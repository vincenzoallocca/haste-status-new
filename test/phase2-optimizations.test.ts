import { describe, it, expect, beforeEach } from 'vitest';
import { createFakeD1, rawDb } from './helpers/fake-d1';
import {
	getAllMonitorsForStatusPage,
	getAllIncidents,
	getActiveIncidents,
	getRecentIncidentsByDate,
} from '$lib/server/db/status';
import {
	getAllGroupsWithStatus,
	getMonitorsWithStatusForGroup,
} from '$lib/server/db/groups';
import type { D1Database } from '@cloudflare/workers-types';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '..', 'migrations');

describe('Phase 2 Optimizations - Regression Tests', () => {
	let db: D1Database;

	beforeEach(async () => {
		db = await createFakeD1(MIGRATIONS);
	});

	// Helper to create test data
	async function setupTestData(db: D1Database) {
		const raw = rawDb(db);

		// Create groups
		const group1Id = 'group-1';
		const group2Id = 'group-2';
		await raw.exec(`
			INSERT INTO monitor_groups (id, name, slug, is_public, display_order)
			VALUES ('${group1Id}', 'Group 1', 'group-1', 1, 1),
			       ('${group2Id}', 'Group 2', 'group-2', 1, 2);
		`);

		// Create monitors - 5 in group 1, 3 in group 2
		const monitorIds = [
			'monitor-1', 'monitor-2', 'monitor-3', 'monitor-4', 'monitor-5',
			'monitor-6', 'monitor-7', 'monitor-8'
		];

		for (let i = 0; i < monitorIds.length; i++) {
			const groupId = i < 5 ? group1Id : group2Id;
			await raw.exec(`
				INSERT INTO monitors (id, name, script, group_id, interval_seconds, active)
				VALUES ('${monitorIds[i]}', 'Monitor ${i + 1}', 'return up;', '${groupId}', 60, 1);
			`);
		}

		// Create checks for all monitors
		const now = new Date();
		for (const monitorId of monitorIds) {
			for (let j = 0; j < 10; j++) {
				const checkedAt = new Date(now.getTime() - j * 60 * 1000).toISOString();
				const status = j === 0 ? 'up' : (j % 3 === 0 ? 'down' : 'up');
				await raw.exec(`
					INSERT INTO checks (monitor_id, status, response_time_ms, status_code, checked_at, check_date)
					VALUES ('${monitorId}', '${status}', 100, 200, '${checkedAt}', date('${checkedAt}'));
				`);
			}
		}

		// Create daily_status for all monitors (90 days)
		for (const monitorId of monitorIds) {
			for (let d = 0; d < 90; d++) {
				const date = new Date(now.getTime() - d * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
				const total = 1440;
				const up = Math.floor(total * 0.99);
				const down = total - up;
				await raw.exec(`
					INSERT INTO daily_status (monitor_id, date, total_checks, up_checks, down_checks, degraded_checks, downtime_minutes)
					VALUES ('${monitorId}', '${date}', ${total}, ${up}, ${down}, 0, ${Math.round(down / total * 24 * 60)})
					ON CONFLICT(monitor_id, date) DO UPDATE SET
						total_checks = excluded.total_checks,
						up_checks = excluded.up_checks,
						down_checks = excluded.down_checks,
						degraded_checks = excluded.degraded_checks,
						downtime_minutes = excluded.downtime_minutes;
				`);
			}
		}

		// Create incidents
		const incidentIds = ['incident-1', 'incident-2', 'incident-3'];
		for (let i = 0; i < incidentIds.length; i++) {
			const groupId = i < 2 ? group1Id : group2Id;
			const createdAt = new Date(now.getTime() - i * 24 * 60 * 60 * 1000).toISOString();
			const status = i === 0 ? 'investigating' : (i === 1 ? 'monitoring' : 'resolved');
			await raw.exec(`
				INSERT INTO incidents (id, title, status, group_id, created_at)
				VALUES ('${incidentIds[i]}', 'Incident ${i + 1}', '${status}', '${groupId}', '${createdAt}');
			`);
		}

		// Create incident updates
		for (let i = 0; i < incidentIds.length; i++) {
			const numUpdates = i + 1; // 1, 2, 3 updates respectively
			for (let u = 0; u < numUpdates; u++) {
				const updateId = `update-${incidentIds[i]}-${u}`;
				const updateStatus = u === numUpdates - 1 ? 'resolved' : 'investigating';
				const updateTime = new Date(now.getTime() - i * 24 * 60 * 60 * 1000 + u * 60 * 1000).toISOString();
				await raw.exec(`
					INSERT INTO incident_updates (id, incident_id, status, message, created_at)
					VALUES ('${updateId}', '${incidentIds[i]}', '${updateStatus}', 'Update ${u + 1} for incident ${i + 1}', '${updateTime}');
				`);
			}
		}

		return { group1Id, group2Id, monitorIds, incidentIds };
	}

	describe('getAllMonitorsForStatusPage', () => {
		it('returns all monitors with daily status for 90 days', async () => {
			await setupTestData(db);
			const result = await getAllMonitorsForStatusPage(db);

			expect(result).toHaveLength(8);
			for (const monitor of result) {
				expect(monitor.daily_status).toHaveLength(90);
				expect(monitor.uptime_90d).toBeGreaterThan(0);
				expect(monitor.current_status).toBeDefined();
			}
		});

		it('handles empty monitor list', async () => {
			const result = await getAllMonitorsForStatusPage(db);
			expect(result).toEqual([]);
		});

		it('handles monitors without checks', async () => {
			const raw = rawDb(db);
			await raw.exec(`
				INSERT INTO monitors (id, name, script, interval_seconds, active)
				VALUES ('monitor-no-checks', 'No Checks Monitor', 'return up;', 60, 1);
			`);

			const result = await getAllMonitorsForStatusPage(db);
			const monitor = result.find(m => m.id === 'monitor-no-checks');
			expect(monitor).toBeDefined();
			expect(monitor!.current_status).toBeNull();
			expect(monitor!.daily_status).toHaveLength(90);
			expect(monitor!.uptime_90d).toBe(100); // default when no daily_status
		});

		it('handles monitors without daily_status', async () => {
			const raw = rawDb(db);
			await raw.exec(`
				INSERT INTO monitors (id, name, script, interval_seconds, active)
				VALUES ('monitor-no-daily', 'No Daily Monitor', 'return up;', 60, 1);
			`);
			await raw.exec(`
				INSERT INTO checks (monitor_id, status, response_time_ms, status_code, checked_at, check_date)
				VALUES ('monitor-no-daily', 'up', 100, 200, datetime('now'), date('now'));
			`);

			const result = await getAllMonitorsForStatusPage(db);
			const monitor = result.find(m => m.id === 'monitor-no-daily');
			expect(monitor).toBeDefined();
			expect(monitor!.current_status).toBe('up');
			expect(monitor!.uptime_90d).toBe(100); // default when no daily_status
		});
	});

	describe('getAllGroupsWithStatus', () => {
		it('returns all groups with monitors and status', async () => {
			await setupTestData(db);
			const result = await getAllGroupsWithStatus(db);

			expect(result).toHaveLength(2);
			const group1 = result.find(g => g.id === 'group-1');
			const group2 = result.find(g => g.id === 'group-2');
			expect(group1).toBeDefined();
			expect(group2).toBeDefined();
			expect(group1!.monitors).toHaveLength(5);
			expect(group2!.monitors).toHaveLength(3);
			expect(group1!.overall_status).toBeDefined();
			expect(group1!.uptime_90d).toBeGreaterThan(0);
		});

		it('handles empty groups', async () => {
			const raw = rawDb(db);
			await raw.exec(`
				INSERT INTO monitor_groups (id, name, slug, is_public, display_order)
				VALUES ('empty-group', 'Empty Group', 'empty-group', 1, 3);
			`);

			const result = await getAllGroupsWithStatus(db);
			const emptyGroup = result.find(g => g.id === 'empty-group');
			expect(emptyGroup).toBeDefined();
			expect(emptyGroup!.monitors).toHaveLength(0);
			expect(emptyGroup!.overall_status).toBe('operational');
			expect(emptyGroup!.uptime_90d).toBe(100);
		});

		it('handles groups without monitors', async () => {
			const raw = rawDb(db);
			await raw.exec(`
				INSERT INTO monitor_groups (id, name, slug, is_public, display_order)
				VALUES ('no-monitors-group', 'No Monitors Group', 'no-monitors-group', 1, 4);
			`);

			const result = await getAllGroupsWithStatus(db);
			const group = result.find(g => g.id === 'no-monitors-group');
			expect(group).toBeDefined();
			expect(group!.monitors).toHaveLength(0);
			expect(group!.overall_status).toBe('operational');
		});
	});

	describe('getMonitorsWithStatusForGroup', () => {
		it('returns monitors for a specific group with status', async () => {
			await setupTestData(db);
			const result = await getMonitorsWithStatusForGroup(db, 'group-1');

			expect(result).toHaveLength(5);
			for (const monitor of result) {
				expect(monitor.group_id).toBe('group-1');
				expect(monitor.daily_status).toHaveLength(90);
				expect(monitor.uptime_90d).toBeGreaterThan(0);
			}
		});

		it('returns empty array for non-existent group', async () => {
			const result = await getMonitorsWithStatusForGroup(db, 'non-existent');
			expect(result).toEqual([]);
		});
	});

	describe('Incident batching - fetchIncidentUpdatesBatch (via public functions)', () => {
		it('getAllIncidents returns all incidents with updates', async () => {
			await setupTestData(db);
			const result = await getAllIncidents(db);

			expect(result).toHaveLength(3);
			for (const incident of result) {
				expect(incident.updates).toBeDefined();
				expect(Array.isArray(incident.updates)).toBe(true);
			}
			// incident-1 has 1 update, incident-2 has 2, incident-3 has 3
			const inc1 = result.find(i => i.id === 'incident-1');
			const inc2 = result.find(i => i.id === 'incident-2');
			const inc3 = result.find(i => i.id === 'incident-3');
			expect(inc1!.updates).toHaveLength(1);
			expect(inc2!.updates).toHaveLength(2);
			expect(inc3!.updates).toHaveLength(3);
		});

		it('getActiveIncidents returns only non-resolved incidents', async () => {
			await setupTestData(db);
			const result = await getActiveIncidents(db);

			// incident-1 (investigating) and incident-2 (monitoring) are active
			// incident-3 (resolved) is not
			expect(result).toHaveLength(2);
			const ids = result.map(i => i.id).sort();
			expect(ids).toEqual(['incident-1', 'incident-2']);
			for (const incident of result) {
				expect(incident.status).not.toBe('resolved');
				expect(incident.updates).toBeDefined();
			}
		});

		it('getRecentIncidentsByDate groups incidents by date', async () => {
			await setupTestData(db);
			const result = await getRecentIncidentsByDate(db, 7);

			expect(result).toHaveLength(7); // 7 days
			for (const day of result) {
				expect(day.date).toBeDefined();
				expect(day.incidents).toBeDefined();
				expect(Array.isArray(day.incidents)).toBe(true);
			}
			// Total incidents across all days should be 3
			const totalIncidents = result.reduce((sum, day) => sum + day.incidents.length, 0);
			expect(totalIncidents).toBe(3);
		});

		it('handles incidents without updates', async () => {
			const raw = rawDb(db);
			await raw.exec(`
				INSERT INTO monitor_groups (id, name, slug, is_public)
				VALUES ('group-no-updates', 'No Updates', 'no-updates', 1);
			`);
			await raw.exec(`
				INSERT INTO incidents (id, title, status, group_id, created_at)
				VALUES ('incident-no-updates', 'No Updates Incident', 'investigating', 'group-no-updates', datetime('now'));
			`);

			const result = await getAllIncidents(db);
			const incident = result.find(i => i.id === 'incident-no-updates');
			expect(incident).toBeDefined();
			expect(incident!.updates).toEqual([]);
		});

		it('handles empty incident list', async () => {
			const result = await getAllIncidents(db);
			expect(result).toEqual([]);
		});

		it('incident updates are ordered by created_at DESC', async () => {
			await setupTestData(db);
			const result = await getAllIncidents(db);
			const inc3 = result.find(i => i.id === 'incident-3');
			// incident-3 has 3 updates, should be ordered newest first
			expect(inc3!.updates).toHaveLength(3);
			for (let i = 0; i < inc3!.updates.length - 1; i++) {
				expect(new Date(inc3!.updates[i].created_at).getTime())
					.toBeGreaterThanOrEqual(new Date(inc3!.updates[i + 1].created_at).getTime());
			}
		});
	});

	describe('Chunking - lists exceeding threshold', () => {
		it('handles monitor list larger than CHUNK_SIZE (500)', async () => {
			const raw = rawDb(db);
			await raw.exec(`
				INSERT INTO monitor_groups (id, name, slug, is_public)
				VALUES ('large-group', 'Large Group', 'large-group', 1);
			`);

			// Create 600 monitors (exceeds CHUNK_SIZE of 500)
			const monitorIds: string[] = [];
			for (let i = 0; i < 600; i++) {
				const id = `monitor-large-${i}`;
				monitorIds.push(id);
				await raw.exec(`
					INSERT INTO monitors (id, name, script, group_id, interval_seconds, active)
					VALUES ('${id}', 'Monitor ${i}', 'return up;', 'large-group', 60, 1);
				`);
				// Add a check for each
				await raw.exec(`
					INSERT INTO checks (monitor_id, status, response_time_ms, status_code, checked_at, check_date)
					VALUES ('${id}', 'up', 100, 200, datetime('now'), date('now'));
				`);
				// Add daily_status for each
				const now = new Date();
				for (let d = 0; d < 90; d++) {
					const date = new Date(now.getTime() - d * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
					await raw.exec(`
						INSERT INTO daily_status (monitor_id, date, total_checks, up_checks, down_checks, degraded_checks, downtime_minutes)
						VALUES ('${id}', '${date}', 1440, 1440, 0, 0, 0);
					`);
				}
			}

			// Test getAllMonitorsForStatusPage
			const monitors = await getAllMonitorsForStatusPage(db);
			const largeMonitors = monitors.filter(m => m.id.startsWith('monitor-large-'));
			expect(largeMonitors).toHaveLength(600);

			// Test getAllGroupsWithStatus
			const groups = await getAllGroupsWithStatus(db);
			const largeGroup = groups.find(g => g.id === 'large-group');
			expect(largeGroup).toBeDefined();
			expect(largeGroup!.monitors).toHaveLength(600);

			// Test getMonitorsWithStatusForGroup
			const groupMonitors = await getMonitorsWithStatusForGroup(db, 'large-group');
			expect(groupMonitors).toHaveLength(600);
		});

		it('handles incident list larger than CHUNK_SIZE (500)', async () => {
			const raw = rawDb(db);
			await raw.exec(`
				INSERT INTO monitor_groups (id, name, slug, is_public)
				VALUES ('incident-group', 'Incident Group', 'incident-group', 1);
			`);

			// Create 600 incidents
			const incidentIds: string[] = [];
			for (let i = 0; i < 600; i++) {
				const id = `incident-large-${i}`;
				incidentIds.push(id);
				await raw.exec(`
					INSERT INTO incidents (id, title, status, group_id, created_at)
					VALUES ('${id}', 'Incident ${i}', 'investigating', 'incident-group', datetime('now'));
				`);
				// Add 2 updates for each
				for (let u = 0; u < 2; u++) {
					await raw.exec(`
						INSERT INTO incident_updates (id, incident_id, status, message, created_at)
						VALUES ('update-${id}-${u}', '${id}', 'investigating', 'Update ${u}', datetime('now'));
					`);
				}
			}

			const result = await getAllIncidents(db);
			const largeIncidents = result.filter(i => i.id.startsWith('incident-large-'));
			expect(largeIncidents).toHaveLength(600);
			for (const incident of largeIncidents) {
				expect(incident.updates).toHaveLength(2);
			}
		});
	});

	describe('Edge cases - empty lists and duplicates', () => {
		it('handles empty monitorIds in chunked query', async () => {
			// This tests the internal chunkedInQuery with empty array
			const result = await getAllMonitorsForStatusPage(db);
			expect(result).toEqual([]);
		});

		it('handles empty incidentIds in chunked query', async () => {
			const result = await getAllIncidents(db);
			expect(result).toEqual([]);
		});

		it('handles duplicate monitor IDs gracefully', async () => {
			// The functions should not produce duplicate IDs from the database
			await setupTestData(db);
			const monitors = await getAllMonitorsForStatusPage(db);
			const ids = monitors.map(m => m.id);
			const uniqueIds = [...new Set(ids)];
			expect(ids.length).toBe(uniqueIds.length);
		});

		it('handles duplicate incident IDs gracefully', async () => {
			await setupTestData(db);
			const incidents = await getAllIncidents(db);
			const ids = incidents.map(i => i.id);
			const uniqueIds = [...new Set(ids)];
			expect(ids.length).toBe(uniqueIds.length);
		});
	});

	describe('Ordering and completeness', () => {
		it('daily_status is ordered by date ASC', async () => {
			await setupTestData(db);
			const result = await getAllMonitorsForStatusPage(db);
			for (const monitor of result) {
				for (let i = 0; i < monitor.daily_status.length - 1; i++) {
					expect(monitor.daily_status[i].date.localeCompare(monitor.daily_status[i + 1].date)).toBeLessThanOrEqual(0);
				}
			}
		});

		it('incident updates are ordered by created_at DESC', async () => {
			await setupTestData(db);
			const result = await getAllIncidents(db);
			for (const incident of result) {
				for (let i = 0; i < incident.updates.length - 1; i++) {
					const current = new Date(incident.updates[i].created_at).getTime();
					const next = new Date(incident.updates[i + 1].created_at).getTime();
					expect(current).toBeGreaterThanOrEqual(next);
				}
			}
		});

		it('getRecentIncidentsByDate returns days in descending order', async () => {
			await setupTestData(db);
			const result = await getRecentIncidentsByDate(db, 7);
			for (let i = 0; i < result.length - 1; i++) {
				expect(result[i].date.localeCompare(result[i + 1].date)).toBeGreaterThanOrEqual(0);
			}
		});

		it('all 90 days present in daily_status for each monitor', async () => {
			await setupTestData(db);
			const result = await getAllMonitorsForStatusPage(db);
			for (const monitor of result) {
				expect(monitor.daily_status).toHaveLength(90);
				// Check all dates are unique
				const dates = monitor.daily_status.map(d => d.date);
				const uniqueDates = [...new Set(dates)];
				expect(dates.length).toBe(uniqueDates.length);
			}
		});
	});
});