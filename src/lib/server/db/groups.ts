import type { D1Database } from '@cloudflare/workers-types';
import type {
	MonitorGroup,
	GroupWithStatus,
	CreateGroupInput,
	UpdateGroupInput
} from '$lib/types/group';
import type { StatusMonitor, DailyStatus } from '$lib/types/status';
import { getOverallStatus } from '$lib/types/status';
import type { MonitorStatus } from '$lib/types/monitor';
import { chunkedInQuery } from './query-helpers';

// Simple in-memory cache for public status (60s TTL)
let publicStatusCache: { data: GroupWithStatus[]; expires: number } | null = null;
const CACHE_TTL_MS = 60_000;

export function getCachedPublicStatus(): GroupWithStatus[] | null {
	if (publicStatusCache && Date.now() < publicStatusCache.expires) {
		return publicStatusCache.data;
	}
	return null;
}

export function setCachedPublicStatus(data: GroupWithStatus[]): void {
	publicStatusCache = { data, expires: Date.now() + CACHE_TTL_MS };
}

export function invalidatePublicStatusCache(): void {
	publicStatusCache = null;
}

// ============================================
// Group CRUD Operations
// ============================================

export async function getAllGroups(db: D1Database): Promise<MonitorGroup[]> {
	const result = await db
		.prepare('SELECT * FROM monitor_groups ORDER BY display_order ASC, name ASC')
		.all<MonitorGroup>();
	return result.results;
}

export async function getGroupById(db: D1Database, id: string): Promise<MonitorGroup | null> {
	return db.prepare('SELECT * FROM monitor_groups WHERE id = ?').bind(id).first<MonitorGroup>();
}

export async function createGroup(db: D1Database, input: CreateGroupInput): Promise<MonitorGroup> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const slug = input.slug || generateSlug(input.name);

	// Get max display_order
	const maxOrder = await db
		.prepare('SELECT MAX(display_order) as max_order FROM monitor_groups')
		.first<{ max_order: number | null }>();
	const displayOrder = (maxOrder?.max_order ?? -1) + 1;

	await db
		.prepare(
			'INSERT INTO monitor_groups (id, name, slug, description, is_public, display_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
		)
		.bind(
			id,
			input.name,
			slug,
			input.description ?? null,
			input.is_public ? 1 : 0,
			displayOrder,
			now
		)
		.run();

	return {
		id,
		name: input.name,
		slug,
		description: input.description ?? null,
		is_public: input.is_public ? 1 : 0,
		display_order: displayOrder,
		created_at: now
	};
}

function generateSlug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}

export async function updateGroup(
	db: D1Database,
	id: string,
	input: UpdateGroupInput
): Promise<void> {
	const updates: string[] = [];
	const values: (string | number)[] = [];

	if (input.name !== undefined) {
		updates.push('name = ?');
		values.push(input.name);
	}
	if (input.slug !== undefined) {
		updates.push('slug = ?');
		values.push(input.slug);
	}
	if (input.description !== undefined) {
		updates.push('description = ?');
		values.push(input.description);
	}
	if (input.is_public !== undefined) {
		updates.push('is_public = ?');
		values.push(input.is_public ? 1 : 0);
	}
	if (input.display_order !== undefined) {
		updates.push('display_order = ?');
		values.push(input.display_order);
	}

	if (updates.length === 0) return;

	values.push(id);
	await db
		.prepare(`UPDATE monitor_groups SET ${updates.join(', ')} WHERE id = ?`)
		.bind(...values)
		.run();
}

export async function deleteGroup(
	db: D1Database,
	id: string
): Promise<{ success: boolean; error?: string }> {
	// Check if group has monitors
	const monitorCount = await db
		.prepare('SELECT COUNT(*) as count FROM monitors WHERE group_id = ?')
		.bind(id)
		.first<{ count: number }>();

	if (monitorCount && monitorCount.count > 0) {
		return {
			success: false,
			error: 'Cannot delete group with monitors. Move or delete monitors first.'
		};
	}

	await db.prepare('DELETE FROM monitor_groups WHERE id = ?').bind(id).run();
	return { success: true };
}

export async function getGroupMonitorCount(db: D1Database, groupId: string): Promise<number> {
	const result = await db
		.prepare('SELECT COUNT(*) as count FROM monitors WHERE group_id = ?')
		.bind(groupId)
		.first<{ count: number }>();
	return result?.count ?? 0;
}

// ============================================
// Group Status Operations
// ============================================

export async function getPublicGroups(db: D1Database): Promise<MonitorGroup[]> {
	const result = await db
		.prepare(
			'SELECT * FROM monitor_groups WHERE is_public = 1 ORDER BY display_order ASC, name ASC'
		)
		.all<MonitorGroup>();
	return result.results;
}

export async function getGroupBySlug(db: D1Database, slug: string): Promise<MonitorGroup | null> {
	return db.prepare('SELECT * FROM monitor_groups WHERE slug = ?').bind(slug).first<MonitorGroup>();
}

export async function getPublicGroupsWithStatus(db: D1Database): Promise<GroupWithStatus[]> {
	// Check cache first
	const cached = getCachedPublicStatus();
	if (cached) return cached;

	const groups = await db
		.prepare(
			'SELECT * FROM monitor_groups WHERE is_public = 1 ORDER BY display_order ASC, name ASC'
		)
		.all<MonitorGroup>();

	const result = await Promise.all(groups.results.map((group) => getGroupWithStatus(db, group)));
	
	// Cache the result
	setCachedPublicStatus(result);
	return result;
}

export async function getGroupWithStatusBySlug(
	db: D1Database,
	slug: string
): Promise<GroupWithStatus | null> {
	const group = await getGroupBySlug(db, slug);
	if (!group) return null;
	return getGroupWithStatus(db, group);
}

/**
 * Get all groups with status data (for admin)
 * Optimized: Uses 2 queries total (all monitors with latest check+uptime, daily_status batch)
 * instead of N+1 pattern (1 query per group)
 */
export async function getAllGroupsWithStatus(db: D1Database): Promise<GroupWithStatus[]> {
	const groups = await getAllGroups(db);
	
	if (groups.length === 0) {
		return [];
	}

	// Query 1: Get all monitors across all groups with latest check and 90d uptime
	const allMonitors = await db
		.prepare(
			`
			SELECT 
				m.id,
				m.name,
				m.group_id,
				m.interval_seconds,
				-- Latest check
				c.status as current_status,
				c.response_time_ms,
				c.checked_at,
				-- 90d uptime from daily_status (pre-aggregated)
				COALESCE(ds.uptime_90d, 100) as uptime_90d
			FROM monitors m
			LEFT JOIN (
				SELECT monitor_id, status, response_time_ms, checked_at
				FROM checks
				WHERE (monitor_id, checked_at) IN (
					SELECT monitor_id, MAX(checked_at)
					FROM checks
					GROUP BY monitor_id
				)
			) c ON m.id = c.monitor_id
			LEFT JOIN (
				SELECT monitor_id, 
					CASE 
						WHEN SUM(total_checks) > 0 
						THEN ROUND((SUM(up_checks) * 10000.0 / SUM(total_checks))) / 100
						ELSE 100 
					END as uptime_90d
				FROM daily_status
				WHERE date >= date('now', '-90 days')
				GROUP BY monitor_id
			) ds ON m.id = ds.monitor_id
			ORDER BY m.group_id, m.name ASC
		`
		)
		.all<{
			id: string;
			name: string;
			group_id: string | null;
			interval_seconds: number;
			current_status: string | null;
			response_time_ms: number | null;
			checked_at: string | null;
			uptime_90d: number;
		}>();

	// Query 2: Get daily status for all monitors (90 days) - chunked batch query
	const monitorIds = allMonitors.results.map(m => m.id);
	const dailyStatusMap = new Map<string, DailyStatus[]>();

	if (monitorIds.length > 0) {
		const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

		const dailyData = await chunkedInQuery<{
			monitor_id: string;
			date: string;
			total_checks: number;
			up_checks: number;
			down_checks: number;
			degraded_checks: number;
			downtime_minutes: number;
		}>(
			db,
			`
			SELECT monitor_id, date, total_checks, up_checks, down_checks, degraded_checks, downtime_minutes
			FROM daily_status
			WHERE monitor_id IN (?) AND date >= ?
			ORDER BY monitor_id, date ASC
			`,
			monitorIds,
			[cutoff]
		);

		// Group by monitor_id
		for (const row of dailyData) {
			if (!dailyStatusMap.has(row.monitor_id)) {
				dailyStatusMap.set(row.monitor_id, []);
			}
			let status: 'up' | 'down' | 'degraded' | 'none' = 'none';
			if (row.total_checks > 0) {
				if (row.down_checks > 0) status = 'down';
				else if (row.degraded_checks > 0) status = 'degraded';
				else status = 'up';
			}
			dailyStatusMap.get(row.monitor_id)!.push({
				date: row.date,
				status,
				downtime_minutes: row.downtime_minutes || 0
			});
		}
	}

	// Build StatusMonitor objects for all monitors
	const monitorMap = new Map<string, StatusMonitor>();
	for (const monitor of allMonitors.results) {
		const dailyStatus = dailyStatusMap.get(monitor.id) || [];
		const allDates = new Map<string, DailyStatus>();
		for (let i = 89; i >= 0; i--) {
			const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
			const dateStr = date.toISOString().split('T')[0];
			allDates.set(dateStr, { date: dateStr, status: 'none', downtime_minutes: 0 });
		}
		for (const ds of dailyStatus) {
			allDates.set(ds.date, ds);
		}

		monitorMap.set(monitor.id, {
			id: monitor.id,
			name: monitor.name,
			group_id: monitor.group_id,
			current_status: (monitor.current_status as MonitorStatus) ?? null,
			uptime_90d: monitor.uptime_90d,
			daily_status: Array.from(allDates.values()).sort((a, b) => a.date.localeCompare(b.date))
		});
	}

	// Group monitors by group_id and build GroupWithStatus
	const result: GroupWithStatus[] = [];
	for (const group of groups) {
		const groupMonitors = allMonitors.results
			.filter(m => m.group_id === group.id)
			.map(m => monitorMap.get(m.id)!)
			.filter(Boolean);

		const overallStatus = getOverallStatus(groupMonitors);
		const avgUptime =
			groupMonitors.length > 0
				? groupMonitors.reduce((sum, m) => sum + m.uptime_90d, 0) / groupMonitors.length
				: 100;

		result.push({
			...group,
			monitors: groupMonitors,
			overall_status: overallStatus,
			uptime_90d: Math.round(avgUptime * 100) / 100
		});
	}

	return result;
}

/**
 * Optimized: Fetch all monitors with status for a group in a single query
 * Eliminates N+1 by joining monitors with latest check, daily_status aggregates
 */
export async function getMonitorsWithStatusForGroup(
	db: D1Database,
	groupId: string
): Promise<StatusMonitor[]> {
	// Single query to get all monitors with their latest check and uptime
	// Uses daily_status for 90d uptime (pre-aggregated) and checks for latest status
	const monitors = await db
		.prepare(
			`
			SELECT 
				m.id,
				m.name,
				m.group_id,
				m.interval_seconds,
				-- Latest check
				c.status as current_status,
				c.response_time_ms,
				c.checked_at,
				-- 90d uptime from daily_status (pre-aggregated)
				COALESCE(ds.uptime_90d, 100) as uptime_90d
			FROM monitors m
			LEFT JOIN (
				SELECT monitor_id, status, response_time_ms, checked_at
				FROM checks
				WHERE (monitor_id, checked_at) IN (
					SELECT monitor_id, MAX(checked_at)
					FROM checks
					GROUP BY monitor_id
				)
			) c ON m.id = c.monitor_id
			LEFT JOIN (
				SELECT monitor_id, 
					CASE 
						WHEN SUM(total_checks) > 0 
						THEN ROUND((SUM(up_checks) * 10000.0 / SUM(total_checks))) / 100
						ELSE 100 
					END as uptime_90d
				FROM daily_status
				WHERE date >= date('now', '-90 days')
				GROUP BY monitor_id
			) ds ON m.id = ds.monitor_id
			WHERE m.group_id = ?
			ORDER BY m.name ASC
		`
		)
		.bind(groupId)
		.all<{
			id: string;
			name: string;
			group_id: string;
			interval_seconds: number;
			current_status: string | null;
			response_time_ms: number | null;
			checked_at: string | null;
			uptime_90d: number;
		}>();

	// Get daily status for each monitor (90 days) - chunked query for all monitors
	const monitorIds = monitors.results.map(m => m.id);
	const dailyStatusMap = new Map<string, DailyStatus[]>();

	if (monitorIds.length > 0) {
		const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

		const dailyData = await chunkedInQuery<{
			monitor_id: string;
			date: string;
			total_checks: number;
			up_checks: number;
			down_checks: number;
			degraded_checks: number;
			downtime_minutes: number;
		}>(
			db,
			`
			SELECT monitor_id, date, total_checks, up_checks, down_checks, degraded_checks, downtime_minutes
			FROM daily_status
			WHERE monitor_id IN (?) AND date >= ?
			ORDER BY monitor_id, date ASC
			`,
			monitorIds,
			[cutoff]
		);

		// Group by monitor_id
		for (const row of dailyData) {
			if (!dailyStatusMap.has(row.monitor_id)) {
				dailyStatusMap.set(row.monitor_id, []);
			}
			let status: 'up' | 'down' | 'degraded' | 'none' = 'none';
			if (row.total_checks > 0) {
				if (row.down_checks > 0) status = 'down';
				else if (row.degraded_checks > 0) status = 'degraded';
				else status = 'up';
			}
			dailyStatusMap.get(row.monitor_id)!.push({
				date: row.date,
				status,
				downtime_minutes: row.downtime_minutes || 0
			});
		}
	}

	// Build StatusMonitor objects
	return monitors.results.map(monitor => {
		const dailyStatus = dailyStatusMap.get(monitor.id) || [];
		// Fill missing dates with 'none'
		const allDates = new Map<string, DailyStatus>();
		for (let i = 89; i >= 0; i--) {
			const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
			const dateStr = date.toISOString().split('T')[0];
			allDates.set(dateStr, { date: dateStr, status: 'none', downtime_minutes: 0 });
		}
		for (const ds of dailyStatus) {
			allDates.set(ds.date, ds);
		}

		return {
			id: monitor.id,
			name: monitor.name,
			group_id: monitor.group_id,
			current_status: (monitor.current_status as MonitorStatus) ?? null,
			uptime_90d: monitor.uptime_90d,
			daily_status: Array.from(allDates.values()).sort((a, b) => a.date.localeCompare(b.date))
		};
	});
}

async function getGroupWithStatus(db: D1Database, group: MonitorGroup): Promise<GroupWithStatus> {
	// Use optimized single-query function
	const statusMonitors = await getMonitorsWithStatusForGroup(db, group.id);

	// Calculate overall status and average uptime
	const overallStatus = getOverallStatus(statusMonitors);
	const avgUptime =
		statusMonitors.length > 0
			? statusMonitors.reduce((sum, m) => sum + m.uptime_90d, 0) / statusMonitors.length
			: 100;

	return {
		...group,
		monitors: statusMonitors,
		overall_status: overallStatus,
		uptime_90d: Math.round(avgUptime * 100) / 100
	};
}

// ============================================
// Default Group Handling
// ============================================

export async function getOrCreateDefaultGroup(db: D1Database): Promise<MonitorGroup> {
	// Check if default group exists
	let defaultGroup = await db
		.prepare("SELECT * FROM monitor_groups WHERE name = 'General'")
		.first<MonitorGroup>();

	if (!defaultGroup) {
		defaultGroup = await createGroup(db, { name: 'General', description: 'Default monitor group' });
	}

	return defaultGroup;
}
