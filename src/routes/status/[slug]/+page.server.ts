import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getGroupWithStatusBySlug } from '$lib/server/db/groups';
import type { Incident, IncidentsByDate, IncidentUpdate } from '$lib/types/status';
import type { D1Database } from '@cloudflare/workers-types';

export const load: PageServerLoad = async ({ params, platform }) => {
	if (!platform?.env?.DB) {
		return {
			group: null,
			activeIncidents: [] as Incident[],
			pastIncidents: [] as IncidentsByDate[],
			dbUnavailable: true
		};
	}

	const db = platform.env.DB;

	try {
		const group = await getGroupWithStatusBySlug(db, params.slug);

		if (!group) {
			throw error(404, 'Group not found');
		}

		// Only allow public groups
		if (!group.is_public) {
			throw error(404, 'Group not found');
		}

		// Get incidents for this group
		const [activeIncidents, pastIncidents] = await Promise.all([
			getActiveIncidentsForGroup(db, group.id),
			getRecentIncidentsByDateForGroup(db, group.id, 7)
		]);

		return {
			group,
			activeIncidents,
			pastIncidents,
			dbUnavailable: false
		};
	} catch (err: any) {
		if (err && typeof err === 'object' && 'status' in err && err.status === 404) {
			throw err;
		}
		console.error('[Group Status Page] D1 error loading status for group:', params.slug, err);
		return {
			group: null,
			activeIncidents: [] as Incident[],
			pastIncidents: [] as IncidentsByDate[],
			dbUnavailable: true
		};
	}
};

async function getActiveIncidentsForGroup(db: D1Database, groupId: string): Promise<Incident[]> {
	const incidents = await db
		.prepare(
			`
			SELECT i.*, g.name as group_name
			FROM incidents i
			LEFT JOIN monitor_groups g ON i.group_id = g.id
			WHERE i.status != 'resolved' AND i.group_id = ?
			ORDER BY i.created_at DESC
		`
		)
		.bind(groupId)
		.all<Incident & { group_name: string }>();

	if (incidents.results.length === 0) return [];

	const incidentIds = incidents.results.map((i) => i.id);
	const placeholders = incidentIds.map(() => '?').join(',');
	const updates = await db
		.prepare(`SELECT * FROM incident_updates WHERE incident_id IN (${placeholders}) ORDER BY created_at DESC`)
		.bind(...incidentIds)
		.all<IncidentUpdate>();

	const updatesMap = new Map<string, IncidentUpdate[]>();
	for (const u of updates.results) {
		const list = updatesMap.get(u.incident_id) ?? [];
		list.push(u);
		updatesMap.set(u.incident_id, list);
	}

	return incidents.results.map((incident) => ({
		...incident,
		updates: updatesMap.get(incident.id) ?? []
	}));
}

async function getRecentIncidentsByDateForGroup(
	db: D1Database,
	groupId: string,
	days: number
): Promise<IncidentsByDate[]> {
	const today = new Date();
	const cutoff = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

	// Single query to get all incidents in the date range (eliminates N+1 daily query loop)
	const incidents = await db
		.prepare(
			`
			SELECT i.*, g.name as group_name
			FROM incidents i
			LEFT JOIN monitor_groups g ON i.group_id = g.id
			WHERE date(i.created_at) >= ? AND i.group_id = ?
			ORDER BY i.created_at DESC
		`
		)
		.bind(cutoff, groupId)
		.all<Incident & { group_name: string }>();

	const incidentIds = incidents.results.map((i) => i.id);
	const updatesMap = new Map<string, IncidentUpdate[]>();

	if (incidentIds.length > 0) {
		const placeholders = incidentIds.map(() => '?').join(',');
		const updates = await db
			.prepare(`SELECT * FROM incident_updates WHERE incident_id IN (${placeholders}) ORDER BY created_at DESC`)
			.bind(...incidentIds)
			.all<IncidentUpdate>();

		for (const u of updates.results) {
			const list = updatesMap.get(u.incident_id) ?? [];
			list.push(u);
			updatesMap.set(u.incident_id, list);
		}
	}

	const incidentsByDateStr = new Map<string, Incident[]>();
	for (const inc of incidents.results) {
		// Handles both ISO strings (YYYY-MM-DDTHH:mm:ss) and SQLite datetime('now') (YYYY-MM-DD HH:mm:ss)
		const dStr = inc.created_at ? inc.created_at.slice(0, 10) : '';
		const list = incidentsByDateStr.get(dStr) ?? [];
		list.push({
			...inc,
			updates: updatesMap.get(inc.id) ?? []
		});
		incidentsByDateStr.set(dStr, list);
	}

	const result: IncidentsByDate[] = [];
	for (let i = 0; i < days; i++) {
		const date = new Date(today);
		date.setDate(date.getDate() - i);
		const dateStr = date.toISOString().split('T')[0];
		const dateFormatted = date.toLocaleDateString('en-US', {
			weekday: 'long',
			month: 'long',
			day: 'numeric',
			year: 'numeric'
		});

		result.push({
			date: dateStr,
			dateFormatted,
			incidents: incidentsByDateStr.get(dateStr) ?? []
		});
	}

	return result;
}
