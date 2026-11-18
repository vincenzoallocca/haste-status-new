import type { D1Database } from '@cloudflare/workers-types';
import type { MonitorStatus, Check } from '$lib/types/monitor';
import type {
	DailyStatus,
	StatusMonitor,
	Incident,
	IncidentUpdate,
	IncidentsByDate,
	CreateIncidentInput,
	AddIncidentUpdateInput
} from '$lib/types/status';
import { chunkedInQuery } from './query-helpers';

// ============================================
// Monitor Status Functions
// ============================================

/**
 * Get last check for a monitor
 */
export async function getLastCheck(db: D1Database, monitorId: string): Promise<Check | null> {
	return db
		.prepare('SELECT * FROM checks WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT 1')
		.bind(monitorId)
		.first<Check>();
}

/**
 * Get 90-day daily status for a monitor
 */
export async function getDailyStatus(db: D1Database, monitorId: string): Promise<DailyStatus[]> {
	const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

	// Get aggregated daily data
	const dailyData = await db
		.prepare(
			`
			SELECT date, total_checks, up_checks, down_checks, degraded_checks, downtime_minutes
			FROM daily_status
			WHERE monitor_id = ? AND date >= ?
			ORDER BY date ASC
		`
		)
		.bind(monitorId, cutoff)
		.all<{
			date: string;
			total_checks: number;
			up_checks: number;
			down_checks: number;
			degraded_checks: number;
			downtime_minutes: number;
		}>();

	// Also get raw checks for recent days not yet aggregated (today only, uses check_date index)
	const today = new Date().toISOString().split('T')[0];
	const rawChecks = await db
		.prepare(
			`
			SELECT
				check_date as date,
				COUNT(*) as total_checks,
				SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) as up_checks,
				SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) as down_checks,
				SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END) as degraded_checks
			FROM checks
			WHERE monitor_id = ? AND check_date >= ?
			GROUP BY check_date
			ORDER BY date ASC
		`
		)
		.bind(monitorId, today)
		.all<{
			date: string;
			total_checks: number;
			up_checks: number;
			down_checks: number;
			degraded_checks: number;
		}>();

	// Build a map of dates to status
	const statusMap = new Map<string, DailyStatus>();

	// Initialize all 90 days with 'none' status
	for (let i = 89; i >= 0; i--) {
		const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
		const dateStr = date.toISOString().split('T')[0];
		statusMap.set(dateStr, { date: dateStr, status: 'none', downtime_minutes: 0 });
	}

	// Fill in aggregated data
	for (const row of dailyData.results) {
		if (row.total_checks === 0) continue;
		let status: DailyStatus['status'] = 'up';
		if (row.down_checks > 0) status = 'down';
		else if (row.degraded_checks > 0) status = 'degraded';
		statusMap.set(row.date, {
			date: row.date,
			status,
			downtime_minutes: row.downtime_minutes || 0
		});
	}

	// Overlay raw checks (more recent data)
	for (const row of rawChecks.results) {
		if (row.total_checks === 0) continue;
		let status: DailyStatus['status'] = 'up';
		if (row.down_checks > 0) status = 'down';
		else if (row.degraded_checks > 0) status = 'degraded';
		// Estimate downtime (rough calculation)
		const downtimeMinutes = Math.round((row.down_checks / row.total_checks) * 24 * 60);
		statusMap.set(row.date, { date: row.date, status, downtime_minutes: downtimeMinutes });
	}

	// Return sorted array
	return Array.from(statusMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Calculate 90-day uptime percentage using pre-aggregated daily_status table
 * Much more efficient than scanning raw checks
 */
export async function getUptime90d(db: D1Database, monitorId: string): Promise<number> {
	const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

	const result = await db
		.prepare(
			`
			SELECT
				SUM(total_checks) as total,
				SUM(up_checks) as up
			FROM daily_status
			WHERE monitor_id = ? AND date >= ?
		`
		)
		.bind(monitorId, cutoff)
		.first<{ total: number; up: number }>();

	if (!result?.total || result.total === 0) return 100;
	return Math.round((result.up / result.total) * 10000) / 100;
}

/**
 * Get all monitors with status data (for admin)
 * Optimized: Uses 2 queries total (monitors+latest_check+uptime, daily_status batch)
 * instead of N+1 pattern (3 queries per monitor)
 */
export async function getAllMonitorsForStatusPage(db: D1Database): Promise<StatusMonitor[]> {
	// Query 1: Get all monitors with latest check and 90d uptime from daily_status
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
			ORDER BY m.name ASC
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

/**
 * Get effective status for dashboard display
 * Returns 'down' only if last 5 consecutive minutes worth of checks are down
 */
export async function getEffectiveStatus(
	db: D1Database,
	monitorId: string,
	intervalSeconds: number
): Promise<MonitorStatus | null> {
	// Calculate how many checks in 5 minutes
	const checksIn5Min = Math.max(1, Math.ceil(300 / intervalSeconds));

	const recentChecks = await db
		.prepare(
			`
			SELECT status FROM checks
			WHERE monitor_id = ?
			ORDER BY checked_at DESC
			LIMIT ?
		`
		)
		.bind(monitorId, checksIn5Min)
		.all<{ status: MonitorStatus }>();

	if (recentChecks.results.length === 0) return null;

	// If all recent checks are 'down', return 'down'
	const allDown = recentChecks.results.every((c) => c.status === 'down');
	if (allDown && recentChecks.results.length >= checksIn5Min) {
		return 'down';
	}

	// Otherwise return the most recent status (but treat single failure as still up)
	const mostRecent = recentChecks.results[0].status;
	if (mostRecent === 'down') {
		// Not enough consecutive failures, show as degraded
		return 'degraded';
	}
	return mostRecent;
}

/**
 * Aggregate daily status from raw checks (run once per day)
 * Uses check_date index for efficiency
 */
export async function aggregateDailyStatus(db: D1Database): Promise<void> {
	// Get yesterday's date
	const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
	const dateStr = yesterday.toISOString().split('T')[0];

	// Aggregate for each monitor using check_date index
	const aggregates = await db
		.prepare(
			`
			SELECT
				monitor_id,
				COUNT(*) as total_checks,
				SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) as up_checks,
				SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) as down_checks,
				SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END) as degraded_checks
			FROM checks
			WHERE check_date = ?
			GROUP BY monitor_id
		`
		)
		.bind(dateStr)
		.all<{
			monitor_id: string;
			total_checks: number;
			up_checks: number;
			down_checks: number;
			degraded_checks: number;
		}>();

	for (const agg of aggregates.results) {
		const downtimeMinutes = Math.round((agg.down_checks / agg.total_checks) * 24 * 60);

		await db
			.prepare(
				`
				INSERT INTO daily_status (monitor_id, date, total_checks, up_checks, down_checks, degraded_checks, downtime_minutes)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(monitor_id, date) DO UPDATE SET
					total_checks = excluded.total_checks,
					up_checks = excluded.up_checks,
					down_checks = excluded.down_checks,
					degraded_checks = excluded.degraded_checks,
					downtime_minutes = excluded.downtime_minutes
			`
			)
			.bind(
				agg.monitor_id,
				dateStr,
				agg.total_checks,
				agg.up_checks,
				agg.down_checks,
				agg.degraded_checks,
				downtimeMinutes
			)
			.run();
	}
}

// ============================================
// Incident Functions
// ============================================

/**
 * Batch fetch incident updates for multiple incidents
 * Replaces N+1 pattern with chunked queries using IN clause
 */
async function fetchIncidentUpdatesBatch(
	db: D1Database,
	incidentIds: string[]
): Promise<Map<string, IncidentUpdate[]>> {
	const updatesMap = new Map<string, IncidentUpdate[]>();

	if (incidentIds.length === 0) {
		return updatesMap;
	}

	const updates = await chunkedInQuery<IncidentUpdate>(
		db,
		`SELECT * FROM incident_updates WHERE incident_id IN (?) ORDER BY incident_id, created_at DESC`,
		incidentIds
	);

	for (const update of updates) {
		if (!updatesMap.has(update.incident_id)) {
			updatesMap.set(update.incident_id, []);
		}
		updatesMap.get(update.incident_id)!.push(update);
	}

	return updatesMap;
}

/**
 * Get all incidents with their updates and group names
 * Optimized: Batch fetches incident_updates in single query
 */
export async function getAllIncidents(db: D1Database): Promise<Incident[]> {
	const incidents = await db
		.prepare(
			`
			SELECT i.*, g.name as group_name
			FROM incidents i
			LEFT JOIN monitor_groups g ON i.group_id = g.id
			ORDER BY i.created_at DESC
		`
		)
		.all<Omit<Incident, 'updates'>>();

	const incidentIds = incidents.results.map(i => i.id);
	const updatesMap = await fetchIncidentUpdatesBatch(db, incidentIds);

	const incidentsWithUpdates: Incident[] = incidents.results.map(incident => ({
		...incident,
		updates: updatesMap.get(incident.id) || []
	}));

	return incidentsWithUpdates;
}

/** Incidenti globali (senza gruppo) o di gruppi pubblici. */
const PUBLIC_INCIDENT_FILTER = ' AND (i.group_id IS NULL OR g.is_public = 1)';

export const MAX_INCIDENT_DAYS = 90;

/** Limita la finestra in giorni a 1..90 (input non numerico -> 7). */
export function clampIncidentDays(days: unknown): number {
	const n = typeof days === 'number' ? Math.floor(days) : parseInt(String(days), 10);
	if (!Number.isFinite(n)) return 7;
	return Math.min(MAX_INCIDENT_DAYS, Math.max(1, n));
}

/**
 * Get active (unresolved) incidents with group names
 * Optimized: Batch fetches incident_updates in single query
 */
export async function getActiveIncidents(
	db: D1Database,
	options: { publicOnly?: boolean } = {}
): Promise<Incident[]> {
	// publicOnly: esclude gli incidenti legati a gruppi non pubblici (is_public = 0)
	const visibility = options.publicOnly ? PUBLIC_INCIDENT_FILTER : '';
	const incidents = await db
		.prepare(
			`
			SELECT i.*, g.name as group_name
			FROM incidents i
			LEFT JOIN monitor_groups g ON i.group_id = g.id
			WHERE i.status != 'resolved'${visibility}
			ORDER BY i.created_at DESC
		`
		)
		.all<Omit<Incident, 'updates'>>();

	const incidentIds = incidents.results.map(i => i.id);
	const updatesMap = await fetchIncidentUpdatesBatch(db, incidentIds);

	const incidentsWithUpdates: Incident[] = incidents.results.map(incident => ({
		...incident,
		updates: updatesMap.get(incident.id) || []
	}));

	return incidentsWithUpdates;
}

/**
 * Get recent incidents (past 7 days) grouped by date with group names
 * Optimized: Batch fetches incident_updates in single query
 */
export async function getRecentIncidentsByDate(
	db: D1Database,
	days: number = 7,
	options: { publicOnly?: boolean } = {}
): Promise<IncidentsByDate[]> {
	days = clampIncidentDays(days);
	const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
	const visibility = options.publicOnly ? PUBLIC_INCIDENT_FILTER : '';

	const incidents = await db
		.prepare(
			`
			SELECT i.*, g.name as group_name
			FROM incidents i
			LEFT JOIN monitor_groups g ON i.group_id = g.id
			WHERE i.created_at > ?${visibility}
			ORDER BY i.created_at DESC
		`
		)
		.bind(cutoff)
		.all<Omit<Incident, 'updates'>>();

	const incidentIds = incidents.results.map(i => i.id);
	const updatesMap = await fetchIncidentUpdatesBatch(db, incidentIds);

	const incidentsWithUpdates: Incident[] = incidents.results.map(incident => ({
		...incident,
		updates: updatesMap.get(incident.id) || []
	}));

	// Group by date
	const byDateMap = new Map<string, Incident[]>();

	// Initialize all days
	for (let i = 0; i < days; i++) {
		const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
		const dateStr = date.toISOString().split('T')[0];
		byDateMap.set(dateStr, []);
	}

	// Group incidents
	for (const incident of incidentsWithUpdates) {
		const dateStr = incident.created_at.split('T')[0];
		const existing = byDateMap.get(dateStr) || [];
		existing.push(incident);
		byDateMap.set(dateStr, existing);
	}

	// Convert to array
	const result: IncidentsByDate[] = [];
	for (const [date, incidents] of byDateMap) {
		const d = new Date(date);
		result.push({
			date,
			dateFormatted: d.toLocaleDateString('en-US', {
				month: 'short',
				day: 'numeric',
				year: 'numeric'
			}),
			incidents
		});
	}

	return result.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Get a single incident by ID
 */
export async function getIncidentById(db: D1Database, id: string): Promise<Incident | null> {
	const incident = await db
		.prepare('SELECT * FROM incidents WHERE id = ?')
		.bind(id)
		.first<Omit<Incident, 'updates'>>();

	if (!incident) return null;

	const updates = await db
		.prepare('SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY created_at DESC')
		.bind(id)
		.all<IncidentUpdate>();

	return { ...incident, updates: updates.results };
}

/**
 * Create a new incident with initial update
 */
export async function createIncident(
	db: D1Database,
	input: CreateIncidentInput
): Promise<Incident> {
	const incidentId = crypto.randomUUID();
	const updateId = crypto.randomUUID();
	const now = new Date().toISOString();

	await db
		.prepare(
			'INSERT INTO incidents (id, title, status, group_id, created_at) VALUES (?, ?, ?, ?, ?)'
		)
		.bind(incidentId, input.title, input.status, input.group_id, now)
		.run();

	await db
		.prepare(
			'INSERT INTO incident_updates (id, incident_id, status, message, created_at) VALUES (?, ?, ?, ?, ?)'
		)
		.bind(updateId, incidentId, input.status, input.message, now)
		.run();

	// Get group name
	const group = await db
		.prepare('SELECT name FROM monitor_groups WHERE id = ?')
		.bind(input.group_id)
		.first<{ name: string }>();

	return {
		id: incidentId,
		title: input.title,
		status: input.status,
		group_id: input.group_id,
		group_name: group?.name,
		created_at: now,
		resolved_at: null,
		updates: [
			{
				id: updateId,
				incident_id: incidentId,
				status: input.status,
				message: input.message,
				created_at: now
			}
		]
	};
}

/**
 * Add an update to an incident
 */
export async function addIncidentUpdate(
	db: D1Database,
	incidentId: string,
	input: AddIncidentUpdateInput
): Promise<IncidentUpdate> {
	const updateId = crypto.randomUUID();
	const now = new Date().toISOString();

	await db
		.prepare(
			'INSERT INTO incident_updates (id, incident_id, status, message, created_at) VALUES (?, ?, ?, ?, ?)'
		)
		.bind(updateId, incidentId, input.status, input.message, now)
		.run();

	// Update incident status
	const resolvedAt = input.status === 'resolved' ? now : null;
	await db
		.prepare('UPDATE incidents SET status = ?, resolved_at = COALESCE(?, resolved_at) WHERE id = ?')
		.bind(input.status, resolvedAt, incidentId)
		.run();

	return {
		id: updateId,
		incident_id: incidentId,
		status: input.status,
		message: input.message,
		created_at: now
	};
}

/**
 * Delete an incident
 */
export async function deleteIncident(db: D1Database, id: string): Promise<void> {
	await db.prepare('DELETE FROM incidents WHERE id = ?').bind(id).run();
}

/**
 * Clean up old daily status records (keep N days)
 */
export async function cleanupOldDailyStatus(db: D1Database, keepDays: number): Promise<number> {
	const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
	const result = await db.prepare('DELETE FROM daily_status WHERE date < ?').bind(cutoff).run();
	return result.meta.changes;
}
