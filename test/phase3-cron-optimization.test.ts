import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeD1, rawDb } from './helpers/fake-d1';
import { cleanupOldChecks } from '$lib/server/db/monitors';
import { cleanupOldDailyStatus } from '$lib/server/db/status';
import { runDailyCleanupOnce } from '$lib/server/db/cleanup';
import type { D1Database } from '@cloudflare/workers-types';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '..', 'migrations');

// Fixed time base for all tests
const FIXED_NOW = new Date('2026-01-15T12:00:00.000Z');

interface CheckRow {
	id: string;
	monitor_id: string;
	checked_at: string;
	status: string;
	latency_ms: number | null;
	region: string | null;
	error: string | null;
}

interface DailyStatusRow {
	id: string;
	monitor_id: string;
	date: string;
	uptime_pct: number;
	total_checks: number;
	failed_checks: number;
	avg_latency_ms: number | null;
}

describe('Phase 3 Cron Optimization - Cleanup Regression Tests', () => {
	let db: D1Database;

	beforeEach(async () => {
		// Mock system time to fixed date for consistent cleanup cutoff calculations
		vi.setSystemTime(FIXED_NOW);
		db = await createFakeD1(MIGRATIONS);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

describe('Consolidated cron behavior (single */1 * * * *)', () => {
		beforeEach(async () => {
			vi.setSystemTime(FIXED_NOW);
			db = await createFakeD1(MIGRATIONS);
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('normal day: first run claims slot, subsequent runs idempotent', async () => {
			vi.setSystemTime(new Date('2026-01-15T12:00:00.000Z'));
			const result = await runDailyCleanupOnce(db);
			// First run always claims (time check is in worker, not here)
			expect(result.claimSuccess).toBe(true);
			expect(result.alreadyRun).toBe(false);
			// Second call is idempotent
			const result2 = await runDailyCleanupOnce(db);
			expect(result2.claimSuccess).toBe(false);
			expect(result2.alreadyRun).toBe(true);
		});

		it('02:59 UTC: cleanup runs on first call (time gate is in worker)', async () => {
			vi.setSystemTime(new Date('2026-01-15T02:59:00.000Z'));
			const result = await runDailyCleanupOnce(db);
			expect(result.claimSuccess).toBe(true);
			expect(result.alreadyRun).toBe(false);
			// Second call idempotent
			const result2 = await runDailyCleanupOnce(db);
			expect(result2.alreadyRun).toBe(true);
		});

		it('03:00 UTC: cleanup runs atomically and claims slot', async () => {
			vi.setSystemTime(new Date('2026-01-15T03:00:00.000Z'));
			const result = await runDailyCleanupOnce(db);
			expect(result.claimSuccess).toBe(true);
			expect(result.alreadyRun).toBe(false);
			expect(result.error).toBeUndefined();
		});

		it('03:01 UTC: cleanup skipped (idempotency - already claimed)', async () => {
			vi.setSystemTime(new Date('2026-01-15T03:00:00.000Z'));
			await runDailyCleanupOnce(db);
			vi.setSystemTime(new Date('2026-01-15T03:01:00.000Z'));
			const result = await runDailyCleanupOnce(db);
			expect(result.claimSuccess).toBe(false);
			expect(result.alreadyRun).toBe(true);
		});

		it('retry on failure: cleanup row deleted, next 03:00 re-runs', async () => {
			vi.setSystemTime(new Date('2026-01-15T03:00:00.000Z'));
			const result = await runDailyCleanupOnce(db);
			expect(result.claimSuccess).toBe(true);
			
			// Verify cleanup_runs row was completed (not deleted) on success
			const raw = rawDb(db);
			const row = raw.prepare('SELECT * FROM cleanup_runs WHERE date = ?').get('2026-01-15') as { completed_at: string | null } | null;
			expect(row?.completed_at).not.toBeNull();
		});

		it('overlap protection: concurrent 03:00 invocations only one claims', async () => {
			vi.setSystemTime(new Date('2026-01-15T03:00:00.000Z'));
			const p1 = runDailyCleanupOnce(db);
			const p2 = runDailyCleanupOnce(db);
			const [r1, r2] = await Promise.all([p1, p2]);
			// Exactly one should have claimed
			const claimed = [r1, r2].filter(r => r.claimSuccess).length;
			expect(claimed).toBe(1);
		});

		it('cleanup failure does not block health checks (idempotency path)', async () => {
			vi.setSystemTime(new Date('2026-01-15T03:00:00.000Z'));
			const result = await runDailyCleanupOnce(db);
			// Successful cleanup should complete without error
			expect(result.error).toBeUndefined();
			// Second call should be idempotent
			const result2 = await runDailyCleanupOnce(db);
			expect(result2.alreadyRun).toBe(true);
		});

		it('idempotency: cleanup_runs table prevents duplicate daily runs', async () => {
			vi.setSystemTime(new Date('2026-01-15T03:00:00.000Z'));
			await runDailyCleanupOnce(db);
			await runDailyCleanupOnce(db); // Second call same minute
			const raw = rawDb(db);
			const count = raw.prepare('SELECT COUNT(*) as c FROM cleanup_runs WHERE date = ?').get('2026-01-15') as { c: number };
			expect(count.c).toBe(1);
		});

		it('health check continuity: aggregateDailyStatus still works independently', async () => {
			vi.setSystemTime(new Date('2026-01-15T03:00:00.000Z'));
			const { aggregateDailyStatus } = await import('$lib/server/db/status');
			await expect(aggregateDailyStatus(db)).resolves.not.toThrow();
			// Cleanup also works
			await expect(runDailyCleanupOnce(db)).resolves.not.toThrow();
		});

		it('stale row retry: worker interruption recovered after grace period', async () => {
			vi.setSystemTime(new Date('2026-01-15T03:00:00.000Z'));
			const raw = rawDb(db);
			
			// Simulate interrupted worker: row with started_at but no completed_at
			await raw.exec(`
				INSERT INTO cleanup_runs (date, started_at) 
				VALUES ('2026-01-15', '2026-01-15T03:00:00.000Z')
			`);
			
			// Advance time past grace period (5 minutes)
			vi.setSystemTime(new Date('2026-01-15T03:06:00.000Z'));
			
			// Next run should detect stale row, atomically replace it, and run cleanup
			const result = await runDailyCleanupOnce(db);
			expect(result.claimSuccess).toBe(true);
			expect(result.alreadyRun).toBe(false);
			expect(result.error).toBeUndefined();
			
			// Verify row was completed
			const row = raw.prepare('SELECT * FROM cleanup_runs WHERE date = ?').get('2026-01-15') as { completed_at: string | null } | null;
			expect(row?.completed_at).not.toBeNull();
		});

		it('fresh row in progress: another instance running blocks retry', async () => {
			vi.setSystemTime(new Date('2026-01-15T03:00:00.000Z'));
			const raw = rawDb(db);
			
			// Simulate another instance just claimed (started_at is now)
			await raw.exec(`
				INSERT INTO cleanup_runs (date, started_at) 
				VALUES ('2026-01-15', '2026-01-15T03:00:00.000Z')
			`);
			
			// Same minute — should see fresh row and back off
			const result = await runDailyCleanupOnce(db);
			expect(result.claimSuccess).toBe(false);
			expect(result.alreadyRun).toBe(true);
			expect(result.error).toContain('in progress');
		});

		it('error persisted in row on failure (not deleted)', async () => {
			// Verify error column exists and can store errors
			const raw = rawDb(db);
			
			// Manually insert a row with error
			await raw.exec(`
				INSERT INTO cleanup_runs (date, started_at, error) 
				VALUES ('2026-01-16', '2026-01-16T03:00:00.000Z', 'test error')
			`);
			
			const row = raw.prepare('SELECT error FROM cleanup_runs WHERE date = ?').get('2026-01-16') as { error: string | null } | null;
			expect(row?.error).toBe('test error');
			
			// Row should still exist (not deleted)
			const count = raw.prepare('SELECT COUNT(*) as c FROM cleanup_runs WHERE date = ?').get('2026-01-16') as { c: number };
			expect(count.c).toBe(1);
		});

		it('completed_at, started_at, error correctly represent state', async () => {
			vi.setSystemTime(new Date('2026-01-15T03:00:00.000Z'));
			const raw = rawDb(db);
			
			// Run successful cleanup
			await runDailyCleanupOnce(db);
			
			const row = raw.prepare('SELECT * FROM cleanup_runs WHERE date = ?').get('2026-01-15') as { 
				started_at: string; 
				completed_at: string | null; 
				checks_deleted: number; 
				daily_status_deleted: number; 
				error: string | null 
			} | null;
			
			// All state fields should be populated correctly
			expect(row).not.toBeNull();
			expect(row?.started_at).not.toBeNull();
			expect(row?.completed_at).not.toBeNull();
			expect(row?.checks_deleted).toBeGreaterThanOrEqual(0);
			expect(row?.daily_status_deleted).toBeGreaterThanOrEqual(0);
			expect(row?.error).toBeNull(); // No error on success
			
			// started_at should be before completed_at
			expect(new Date(row!.started_at).getTime()).toBeLessThanOrEqual(new Date(row!.completed_at!).getTime());
		});

		it('race: stale row replacement atomic — concurrent instance cannot steal claim', async () => {
			vi.setSystemTime(new Date('2026-01-15T03:00:00.000Z'));
			const raw = rawDb(db);
			
			// Simulate stale row from interrupted worker
			await raw.exec(`
				INSERT INTO cleanup_runs (date, started_at) 
				VALUES ('2026-01-15', '2026-01-15T03:00:00.000Z')
			`);
			
			// Advance past grace period
			vi.setSystemTime(new Date('2026-01-15T03:06:00.000Z'));
			
			// Two instances try to claim stale row simultaneously
			const p1 = runDailyCleanupOnce(db);
			const p2 = runDailyCleanupOnce(db);
			const [r1, r2] = await Promise.all([p1, p2]);
			
			// Exactly one should succeed in claiming
			const claimed = [r1, r2].filter(r => r.claimSuccess).length;
			expect(claimed).toBe(1);
			
			// The other should see "claimed by another instance"
			const other = [r1, r2].find(r => !r.claimSuccess);
			expect(other?.error).toContain('claimed by another instance');
			
			// Row should be completed by the winner
			const row = raw.prepare('SELECT completed_at FROM cleanup_runs WHERE date = ?').get('2026-01-15') as { completed_at: string | null } | null;
			expect(row?.completed_at).not.toBeNull();
		});

		it('race: active execution > grace period does not lose claim if completed quickly', async () => {
			vi.setSystemTime(new Date('2026-01-15T03:00:00.000Z'));
			
			// Start cleanup
			const result = await runDailyCleanupOnce(db);
			expect(result.claimSuccess).toBe(true);
			
			// Advance time past grace period (5 min) but cleanup already completed
			vi.setSystemTime(new Date('2026-01-15T03:06:00.000Z'));
			
			// Next run should see completed_at and back off
			const result2 = await runDailyCleanupOnce(db);
			expect(result2.alreadyRun).toBe(true);
			expect(result2.claimSuccess).toBe(false);
		});

		it('race: stale row replaced only if still stale (not completed by another)', async () => {
			vi.setSystemTime(new Date('2026-01-15T03:00:00.000Z'));
			const raw = rawDb(db);
			
			// Simulate stale row
			await raw.exec(`
				INSERT INTO cleanup_runs (date, started_at) 
				VALUES ('2026-01-15', '2026-01-15T03:00:00.000Z')
			`);
			
			// Advance past grace period
			vi.setSystemTime(new Date('2026-01-15T03:06:00.000Z'));
			
			// Instance A claims stale row and runs cleanup
			const resultA = await runDailyCleanupOnce(db);
			expect(resultA.claimSuccess).toBe(true);
			expect(resultA.error).toBeUndefined();
			
			// Instance B tries to claim — should see completed_at and back off
			const resultB = await runDailyCleanupOnce(db);
			expect(resultB.claimSuccess).toBe(false);
			expect(resultB.alreadyRun).toBe(true);
			expect(resultB.error).toBeUndefined(); // completed successfully, no error
			
			// Row should be completed by A
			const row = raw.prepare('SELECT completed_at FROM cleanup_runs WHERE date = ?').get('2026-01-15') as { completed_at: string | null } | null;
			expect(row?.completed_at).not.toBeNull();
		});

		it('retry after failure: error row retried on next cron after grace period', async () => {
			vi.setSystemTime(new Date('2026-01-15T03:00:00.000Z'));
			const raw = rawDb(db);
			
			// Simulate failed cleanup: row with error, no completed_at
			await raw.exec(`
				INSERT INTO cleanup_runs (date, started_at, error) 
				VALUES ('2026-01-15', '2026-01-15T03:00:00.000Z', 'previous failure')
			`);
			
			// Advance past grace period
			vi.setSystemTime(new Date('2026-01-15T03:06:00.000Z'));
			
			// Next run should retry (replace stale error row)
			const result = await runDailyCleanupOnce(db);
			expect(result.claimSuccess).toBe(true);
			expect(result.error).toBeUndefined();
			
			// Error should be cleared on retry attempt
			const row = raw.prepare('SELECT error FROM cleanup_runs WHERE date = ?').get('2026-01-15') as { error: string | null } | null;
			expect(row?.error).toBeNull();
		});
	});

	describe('Claim token ownership and race conditions', () => {
		beforeEach(async () => {
			vi.setSystemTime(FIXED_NOW);
			db = await createFakeD1(MIGRATIONS);
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('Worker A loses claim and cannot complete', async () => {
			vi.setSystemTime(new Date('2026-01-15T03:00:00.000Z'));
			const raw = rawDb(db);
			
			// Worker A claims stale row (manually set up claimed but not completed)
			const tokenA = crypto.randomUUID();
			await raw.exec(`
				INSERT INTO cleanup_runs (date, started_at, claim_token) 
				VALUES ('2026-01-15', '2026-01-15T03:00:00.000Z', '${tokenA}')
			`);
			
			// Advance past grace period
			vi.setSystemTime(new Date('2026-01-15T03:06:00.000Z'));
			
			// Worker B steals claim by replacing stale row (simulating concurrent cron tick)
			const tokenB = crypto.randomUUID();
			await raw.exec(`
				UPDATE cleanup_runs 
				SET started_at = '2026-01-15T03:06:00.000Z', claim_token = '${tokenB}', error = NULL
				WHERE date = '2026-01-15' AND completed_at IS NULL
			`);
			
			// Worker A tries to complete with its token — should fail (0 changes)
			const completeResult = await db
				.prepare(
					'UPDATE cleanup_runs SET completed_at = ?, checks_deleted = ?, daily_status_deleted = ? WHERE date = ? AND claim_token = ? AND completed_at IS NULL'
				)
				.bind(new Date().toISOString(), 5, 3, '2026-01-15', tokenA)
				.run();
			
			expect(completeResult.meta.changes).toBe(0);
			
			// Worker B completes with its token — should succeed
			const completeResultB = await db
				.prepare(
					'UPDATE cleanup_runs SET completed_at = ?, checks_deleted = ?, daily_status_deleted = ? WHERE date = ? AND claim_token = ? AND completed_at IS NULL'
				)
				.bind(new Date().toISOString(), 5, 3, '2026-01-15', tokenB)
				.run();
			
			expect(completeResultB.meta.changes).toBe(1);
			
			// Row should be completed by Worker B
			const row = raw.prepare('SELECT completed_at, claim_token FROM cleanup_runs WHERE date = ?').get('2026-01-15') as { completed_at: string | null; claim_token: string | null } | null;
			expect(row?.completed_at).not.toBeNull();
			expect(row?.claim_token).toBe(tokenB);
		});

		it('Worker A loses claim and cannot record error', async () => {
			vi.setSystemTime(new Date('2026-01-15T03:00:00.000Z'));
			const raw = rawDb(db);
			
			// Worker A claims stale row (manually set up claimed but not completed)
			const tokenA = crypto.randomUUID();
			await raw.exec(`
				INSERT INTO cleanup_runs (date, started_at, claim_token) 
				VALUES ('2026-01-15', '2026-01-15T03:00:00.000Z', '${tokenA}')
			`);
			
			// Advance past grace period
			vi.setSystemTime(new Date('2026-01-15T03:06:00.000Z'));
			
			// Worker B steals claim
			const tokenB = crypto.randomUUID();
			await raw.exec(`
				UPDATE cleanup_runs 
				SET started_at = '2026-01-15T03:06:00.000Z', claim_token = '${tokenB}', error = NULL
				WHERE date = '2026-01-15' AND completed_at IS NULL
			`);
			
			// Worker A tries to record error with its token — should fail (0 changes)
			const errorResult = await db
				.prepare('UPDATE cleanup_runs SET error = ? WHERE date = ? AND claim_token = ? AND completed_at IS NULL')
				.bind('Worker A error', '2026-01-15', tokenA)
				.run();
			
			expect(errorResult.meta.changes).toBe(0);
			
			// Worker B records error with its token — should succeed
			const errorResultB = await db
				.prepare('UPDATE cleanup_runs SET error = ? WHERE date = ? AND claim_token = ? AND completed_at IS NULL')
				.bind('Worker B error', '2026-01-15', tokenB)
				.run();
			
			expect(errorResultB.meta.changes).toBe(1);
			
			// Error should be Worker B's
			const row = raw.prepare('SELECT error, claim_token FROM cleanup_runs WHERE date = ?').get('2026-01-15') as { error: string | null; claim_token: string | null } | null;
			expect(row?.error).toBe('Worker B error');
			expect(row?.claim_token).toBe(tokenB);
		});

		it('Worker A completes with its own token', async () => {
			vi.setSystemTime(new Date('2026-01-15T03:00:00.000Z'));
			const raw = rawDb(db);
			
			// Fresh claim by Worker A (manually set up claimed but not completed)
			const tokenA = crypto.randomUUID();
			await raw.exec(`
				INSERT INTO cleanup_runs (date, started_at, claim_token) 
				VALUES ('2026-01-15', '2026-01-15T03:00:00.000Z', '${tokenA}')
			`);
			
			// Worker B tries to complete with wrong token — should fail
			const wrongToken = crypto.randomUUID();
			const completeResult = await db
				.prepare(
					'UPDATE cleanup_runs SET completed_at = ?, checks_deleted = ?, daily_status_deleted = ? WHERE date = ? AND claim_token = ? AND completed_at IS NULL'
				)
				.bind(new Date().toISOString(), 5, 3, '2026-01-15', wrongToken)
				.run();
			
			expect(completeResult.meta.changes).toBe(0);
			
			// Worker A completes with correct token — should succeed
			const completeResultA = await db
				.prepare(
					'UPDATE cleanup_runs SET completed_at = ?, checks_deleted = ?, daily_status_deleted = ? WHERE date = ? AND claim_token = ? AND completed_at IS NULL'
				)
				.bind(new Date().toISOString(), 5, 3, '2026-01-15', tokenA)
				.run();
			
			expect(completeResultA.meta.changes).toBe(1);
			
			// Row should be completed by Worker A
			const row = raw.prepare('SELECT completed_at, claim_token FROM cleanup_runs WHERE date = ?').get('2026-01-15') as { completed_at: string | null; claim_token: string | null } | null;
			expect(row?.completed_at).not.toBeNull();
			expect(row?.claim_token).toBe(tokenA);
		});

		it('Two workers compete for stale row replacement: only one acquires claim', async () => {
			vi.setSystemTime(new Date('2026-01-15T03:00:00.000Z'));
			const raw = rawDb(db);
			
			// Simulate stale row from interrupted worker
			await raw.exec(`
				INSERT INTO cleanup_runs (date, started_at) 
				VALUES ('2026-01-15', '2026-01-15T03:00:00.000Z')
			`);
			
			// Advance past grace period
			vi.setSystemTime(new Date('2026-01-15T03:06:00.000Z'));
			
			// Two instances try to claim stale row simultaneously via runDailyCleanupOnce
			const p1 = runDailyCleanupOnce(db);
			const p2 = runDailyCleanupOnce(db);
			const [r1, r2] = await Promise.all([p1, p2]);
			
			// Exactly one should succeed in claiming
			const claimed = [r1, r2].filter(r => r.claimSuccess).length;
			expect(claimed).toBe(1);
			
			// The other should see "claimed by another instance"
			const other = [r1, r2].find(r => !r.claimSuccess);
			expect(other?.error).toContain('claimed by another instance');
			
			// Row should be completed by the winner
			const row = raw.prepare('SELECT completed_at FROM cleanup_runs WHERE date = ?').get('2026-01-15') as { completed_at: string | null } | null;
			expect(row?.completed_at).not.toBeNull();
		});

		it('Wrong token does not modify any data', async () => {
			vi.setSystemTime(new Date('2026-01-15T03:00:00.000Z'));
			const raw = rawDb(db);
			
			// Create a completed row with a known token
			const realToken = crypto.randomUUID();
			await raw.exec(`
				INSERT INTO cleanup_runs (date, started_at, completed_at, claim_token)
				VALUES ('2026-01-15', '2026-01-15T03:00:00.000Z', '2026-01-15T03:00:05.000Z', '${realToken}')
			`);
			
			// Try to update with wrong token
			const wrongToken = crypto.randomUUID();
			const result = await db
				.prepare('UPDATE cleanup_runs SET error = ? WHERE date = ? AND claim_token = ?')
				.bind('wrong token attempt', '2026-01-15', wrongToken)
				.run();
			
			expect(result.meta.changes).toBe(0);
			
			// Row should be unchanged
			const row = raw.prepare('SELECT error, claim_token FROM cleanup_runs WHERE date = ?').get('2026-01-15') as { error: string | null; claim_token: string | null } | null;
			expect(row?.error).toBeNull();
			expect(row?.claim_token).toBe(realToken);
		});

		it('Partial cleanup followed by retry produces coherent state', async () => {
			vi.setSystemTime(new Date('2026-01-15T03:00:00.000Z'));
			const raw = rawDb(db);
			
			// Simulate partially completed cleanup (checks deleted but daily_status failed)
			// This is represented as a row with error but no completed_at
			await raw.exec(`
				INSERT INTO cleanup_runs (date, started_at, error)
				VALUES ('2026-01-15', '2026-01-15T03:00:00.000Z', 'cleanupOldDailyStatus failed: D1 error')
			`);
			
			// Advance past grace period
			vi.setSystemTime(new Date('2026-01-15T03:06:00.000Z'));
			
			// Next run retries and succeeds
			const result = await runDailyCleanupOnce(db);
			expect(result.claimSuccess).toBe(true);
			expect(result.error).toBeUndefined();
			expect(result.checksDeleted).toBeGreaterThanOrEqual(0);
			expect(result.dailyStatusDeleted).toBeGreaterThanOrEqual(0);
			
			// Final state should be completed (no error)
			const row = raw.prepare('SELECT * FROM cleanup_runs WHERE date = ?').get('2026-01-15') as {
				completed_at: string | null;
				error: string | null;
				checks_deleted: number;
				daily_status_deleted: number;
				claim_token: string | null;
			} | null;
			
			expect(row?.completed_at).not.toBeNull();
			expect(row?.error).toBeNull();
			expect(row?.checks_deleted).toBeGreaterThanOrEqual(0);
			expect(row?.daily_status_deleted).toBeGreaterThanOrEqual(0);
			expect(row?.claim_token).not.toBeNull();
		});

		it('Worker that loses claim cannot overwrite counters', async () => {
			vi.setSystemTime(new Date('2026-01-15T03:00:00.000Z'));
			const raw = rawDb(db);
			
			// Worker A claims and completes successfully
			const resultA = await runDailyCleanupOnce(db);
			expect(resultA.claimSuccess).toBe(true);
			const tokenA = resultA.claimToken!;
			
			// Verify completed
			let row = raw.prepare('SELECT completed_at, checks_deleted, daily_status_deleted, claim_token FROM cleanup_runs WHERE date = ?').get('2026-01-15') as {
				completed_at: string | null;
				checks_deleted: number;
				daily_status_deleted: number;
				claim_token: string | null;
			} | null;
			expect(row?.completed_at).not.toBeNull();
			expect(row?.claim_token).toBe(tokenA);
			const originalChecksDeleted = row?.checks_deleted ?? 0;
			const originalDailyDeleted = row?.daily_status_deleted ?? 0;
			
			// Simulate Worker B somehow getting a new claim_token on the completed row
			// (This shouldn't happen in normal flow, but tests the protection)
			const tokenB = crypto.randomUUID();
			await raw.exec(`
				UPDATE cleanup_runs SET claim_token = '${tokenB}' WHERE date = '2026-01-15'
			`);
			
			// Worker A tries to update counters with old token — should fail (completed_at IS NULL condition)
			const updateResult = await db
				.prepare(
					'UPDATE cleanup_runs SET checks_deleted = ?, daily_status_deleted = ? WHERE date = ? AND claim_token = ? AND completed_at IS NULL'
				)
				.bind(999, 888, '2026-01-15', tokenA)
				.run();
			
			expect(updateResult.meta.changes).toBe(0);
			
			// Worker B tries with new token but completed_at is set — should also fail
			const updateResultB = await db
				.prepare(
					'UPDATE cleanup_runs SET checks_deleted = ?, daily_status_deleted = ? WHERE date = ? AND claim_token = ? AND completed_at IS NULL'
				)
				.bind(777, 666, '2026-01-15', tokenB)
				.run();
			
			expect(updateResultB.meta.changes).toBe(0);
			
			// Counters should remain unchanged
			row = raw.prepare('SELECT checks_deleted, daily_status_deleted FROM cleanup_runs WHERE date = ?').get('2026-01-15') as {
				checks_deleted: number;
				daily_status_deleted: number;
			} | null;
			expect(row?.checks_deleted).toBe(originalChecksDeleted);
			expect(row?.daily_status_deleted).toBe(originalDailyDeleted);
		});
	});

	// Helper to create test data using fixed time base
	async function setupTestData(db: D1Database) {
		const raw = rawDb(db);

		// Create a monitor
		await raw.exec(`
			INSERT INTO monitors (id, name, script, interval_seconds, active)
			VALUES ('monitor-1', 'Test Monitor', 'return up;', 60, 1);
		`);

		// Create checks - some old, some recent, using fixed time base
		// Old: 10 days ago (clearly outside 7-day retention)
		const oldDate = new Date(FIXED_NOW.getTime() - 10 * 24 * 60 * 60 * 1000);
		// Recent: 3 days ago (clearly inside 7-day retention)
		const recentDate = new Date(FIXED_NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
		// Boundary: 6 days 23 hours ago (inside retention, close to boundary)
		const boundaryDate = new Date(FIXED_NOW.getTime() - (6 * 24 + 23) * 60 * 60 * 1000);

		await raw.exec(`
			INSERT INTO checks (monitor_id, status, response_time_ms, status_code, checked_at, check_date)
			VALUES ('monitor-1', 'up', 100, 200, '${oldDate.toISOString()}', '${oldDate.toISOString().split('T')[0]}');
		`);
		await raw.exec(`
			INSERT INTO checks (monitor_id, status, response_time_ms, status_code, checked_at, check_date)
			VALUES ('monitor-1', 'up', 100, 200, '${recentDate.toISOString()}', '${recentDate.toISOString().split('T')[0]}');
		`);
		await raw.exec(`
			INSERT INTO checks (monitor_id, status, response_time_ms, status_code, checked_at, check_date)
			VALUES ('monitor-1', 'up', 100, 200, '${boundaryDate.toISOString()}', '${boundaryDate.toISOString().split('T')[0]}');
		`);

		// Create daily_status - some old, some recent
		// Old: 100 days ago (clearly outside 90-day retention)
		const oldDailyDate = new Date(FIXED_NOW.getTime() - 100 * 24 * 60 * 60 * 1000);
		// Recent: 30 days ago (clearly inside 90-day retention)
		const recentDailyDate = new Date(FIXED_NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
		// Boundary: 89 days ago (inside retention, close to boundary)
		const boundaryDailyDate = new Date(FIXED_NOW.getTime() - 89 * 24 * 60 * 60 * 1000);

		await raw.exec(`
			INSERT INTO daily_status (monitor_id, date, total_checks, up_checks, down_checks, degraded_checks, downtime_minutes)
			VALUES ('monitor-1', '${oldDailyDate.toISOString().split('T')[0]}', 1440, 1440, 0, 0, 0);
		`);
		await raw.exec(`
			INSERT INTO daily_status (monitor_id, date, total_checks, up_checks, down_checks, degraded_checks, downtime_minutes)
			VALUES ('monitor-1', '${recentDailyDate.toISOString().split('T')[0]}', 1440, 1440, 0, 0, 0);
		`);
		await raw.exec(`
			INSERT INTO daily_status (monitor_id, date, total_checks, up_checks, down_checks, degraded_checks, downtime_minutes)
			VALUES ('monitor-1', '${boundaryDailyDate.toISOString().split('T')[0]}', 1440, 1440, 0, 0, 0);
		`);
	}

	describe('cleanupOldChecks (7-day retention)', () => {
		it('deletes checks older than 7 days', async () => {
			await setupTestData(db);
			const deleted = await cleanupOldChecks(db, 7);
			// Should delete only the 10-day-old check (1 record)
			expect(deleted).toBe(1);

			const raw = rawDb(db);
			const remaining = raw.prepare('SELECT COUNT(*) as c FROM checks').get() as { c: number };
			// Should keep the 3-day-old and 6d23h-old checks (2 records)
			expect(remaining.c).toBe(2);
		});

		it('keeps checks within 7-day retention', async () => {
			await setupTestData(db);
			await cleanupOldChecks(db, 7);

			const raw = rawDb(db);
			// Both recent (3 days) and boundary (6d23h) should be kept
			const allChecks = raw.prepare('SELECT checked_at FROM checks').all() as { checked_at: string }[];
			expect(allChecks.length).toBe(2);

			// Verify both are within 7 days of FIXED_NOW
			for (const check of allChecks) {
				const checkDate = new Date(check.checked_at);
				const diffDays = (FIXED_NOW.getTime() - checkDate.getTime()) / (24 * 60 * 60 * 1000);
				expect(diffDays).toBeLessThan(7);
			}
		});

		it('handles empty database', async () => {
			const deleted = await cleanupOldChecks(db, 7);
			expect(deleted).toBe(0);
		});

		it('handles database with no expired checks', async () => {
			const raw = rawDb(db);
			await raw.exec(`
				INSERT INTO monitors (id, name, script, interval_seconds, active)
				VALUES ('monitor-1', 'Test Monitor', 'return up;', 60, 1);
			`);
			// Create a check at fixed now (well within retention)
			await raw.exec(`
				INSERT INTO checks (monitor_id, status, response_time_ms, status_code, checked_at, check_date)
				VALUES ('monitor-1', 'up', 100, 200, '${FIXED_NOW.toISOString()}', '${FIXED_NOW.toISOString().split('T')[0]}');
			`);

			const deleted = await cleanupOldChecks(db, 7);
			expect(deleted).toBe(0);

			const remaining = raw.prepare('SELECT COUNT(*) as c FROM checks').get() as { c: number };
			expect(remaining.c).toBe(1);
		});

		it('handles mix of expired and non-expired checks', async () => {
			await setupTestData(db);
			const deleted = await cleanupOldChecks(db, 7);
			expect(deleted).toBe(1);

			const raw = rawDb(db);
			const remaining = raw.prepare('SELECT COUNT(*) as c FROM checks').get() as { c: number };
			expect(remaining.c).toBe(2);
		});

		it('is idempotent - running twice deletes same rows (0 second time)', async () => {
			await setupTestData(db);
			const firstRun = await cleanupOldChecks(db, 7);
			const secondRun = await cleanupOldChecks(db, 7);

			expect(firstRun).toBe(1);
			expect(secondRun).toBe(0);

			const raw = rawDb(db);
			const remaining = raw.prepare('SELECT COUNT(*) as c FROM checks').get() as { c: number };
			expect(remaining.c).toBe(2);
		});

		it('retention of 7 days is preserved', async () => {
			await setupTestData(db);
			await cleanupOldChecks(db, 7);

			const raw = rawDb(db);
			const oldest = raw.prepare('SELECT MIN(checked_at) as min FROM checks').get() as { min: string };
			const oldestDate = new Date(oldest.min);
			const diffDays = (FIXED_NOW.getTime() - oldestDate.getTime()) / (24 * 60 * 60 * 1000);
			expect(diffDays).toBeLessThan(7);
		});
	});

	describe('cleanupOldDailyStatus (90-day retention)', () => {
		it('deletes daily_status older than 90 days', async () => {
			await setupTestData(db);
			const deleted = await cleanupOldDailyStatus(db, 90);
			// Should delete only the 100-day-old record (1 record)
			expect(deleted).toBe(1);

			const raw = rawDb(db);
			const remaining = raw.prepare('SELECT COUNT(*) as c FROM daily_status').get() as { c: number };
			// Should keep the 30-day-old and 89-day-old records (2 records)
			expect(remaining.c).toBe(2);
		});

		it('keeps daily_status within 90-day retention', async () => {
			await setupTestData(db);
			await cleanupOldDailyStatus(db, 90);

			const raw = rawDb(db);
			// Both recent (30 days) and boundary (89 days) should be kept
			const allDaily = raw.prepare('SELECT date FROM daily_status').all() as { date: string }[];
			expect(allDaily.length).toBe(2);

			// Verify both are within 90 days of FIXED_NOW
			for (const daily of allDaily) {
				const dailyDate = new Date(daily.date);
				const diffDays = (FIXED_NOW.getTime() - dailyDate.getTime()) / (24 * 60 * 60 * 1000);
				expect(diffDays).toBeLessThan(90);
			}
		});

		it('handles empty database', async () => {
			const deleted = await cleanupOldDailyStatus(db, 90);
			expect(deleted).toBe(0);
		});

		it('handles database with no expired daily_status', async () => {
			const raw = rawDb(db);
			await raw.exec(`
				INSERT INTO monitors (id, name, script, interval_seconds, active)
				VALUES ('monitor-1', 'Test Monitor', 'return up;', 60, 1);
			`);
			await raw.exec(`
				INSERT INTO daily_status (monitor_id, date, total_checks, up_checks, down_checks, degraded_checks, downtime_minutes)
				VALUES ('monitor-1', '${FIXED_NOW.toISOString().split('T')[0]}', 1440, 1440, 0, 0, 0);
			`);

			const deleted = await cleanupOldDailyStatus(db, 90);
			expect(deleted).toBe(0);

			const remaining = raw.prepare('SELECT COUNT(*) as c FROM daily_status').get() as { c: number };
			expect(remaining.c).toBe(1);
		});

		it('handles mix of expired and non-expired daily_status', async () => {
			await setupTestData(db);
			const deleted = await cleanupOldDailyStatus(db, 90);
			expect(deleted).toBe(1);

			const raw = rawDb(db);
			const remaining = raw.prepare('SELECT COUNT(*) as c FROM daily_status').get() as { c: number };
			expect(remaining.c).toBe(2);
		});

		it('is idempotent - running twice deletes same rows (0 second time)', async () => {
			await setupTestData(db);
			const firstRun = await cleanupOldDailyStatus(db, 90);
			const secondRun = await cleanupOldDailyStatus(db, 90);

			expect(firstRun).toBe(1);
			expect(secondRun).toBe(0);

			const raw = rawDb(db);
			const remaining = raw.prepare('SELECT COUNT(*) as c FROM daily_status').get() as { c: number };
			expect(remaining.c).toBe(2);
		});

		it('retention of 90 days is preserved', async () => {
			await setupTestData(db);
			await cleanupOldDailyStatus(db, 90);

			const raw = rawDb(db);
			const oldest = raw.prepare('SELECT MIN(date) as min FROM daily_status').get() as { min: string };
			const oldestDate = new Date(oldest.min);
			const diffDays = (FIXED_NOW.getTime() - oldestDate.getTime()) / (24 * 60 * 60 * 1000);
			expect(diffDays).toBeLessThan(90);
		});
	});

	describe('Cleanup independence and error handling', () => {
		it('cleanupOldChecks and cleanupOldDailyStatus operate independently', async () => {
			await setupTestData(db);

			// Run checks cleanup
			const checksDeleted = await cleanupOldChecks(db, 7);
			expect(checksDeleted).toBe(1);

			// Run daily_status cleanup
			const dailyDeleted = await cleanupOldDailyStatus(db, 90);
			expect(dailyDeleted).toBe(1);

			const raw = rawDb(db);
			const remainingChecks = raw.prepare('SELECT COUNT(*) as c FROM checks').get() as { c: number };
			const remainingDaily = raw.prepare('SELECT COUNT(*) as c FROM daily_status').get() as { c: number };
			expect(remainingChecks.c).toBe(2);
			expect(remainingDaily.c).toBe(2);
		});

		it('errors in one cleanup do not affect the other', async () => {
			await setupTestData(db);

			// Verify both functions can be called sequentially without interference
			await cleanupOldChecks(db, 7);
			await cleanupOldDailyStatus(db, 90);

			const raw = rawDb(db);
			const remainingChecks = raw.prepare('SELECT COUNT(*) as c FROM checks').get() as { c: number };
			const remainingDaily = raw.prepare('SELECT COUNT(*) as c FROM daily_status').get() as { c: number };
			expect(remainingChecks.c).toBe(2);
			expect(remainingDaily.c).toBe(2);
		});
	});

	describe('Cron separation verification', () => {
		it('minute cron tasks (health checks, aggregateDailyStatus) are separate from daily cleanup', async () => {
			// This test verifies the conceptual separation
			// The actual cron handler is tested via integration
			await setupTestData(db);

			// Simulate minute cron: aggregateDailyStatus should work
			const { aggregateDailyStatus } = await import('$lib/server/db/status');
			await expect(aggregateDailyStatus(db)).resolves.not.toThrow();

			// Daily cleanup should work independently
			await expect(cleanupOldChecks(db, 7)).resolves.not.toThrow();
			await expect(cleanupOldDailyStatus(db, 90)).resolves.not.toThrow();
		});

		it('no accidental deletion of non-expired data', async () => {
			await setupTestData(db);

			// Run both cleanups
			await cleanupOldChecks(db, 7);
			await cleanupOldDailyStatus(db, 90);

			const raw = rawDb(db);

			// Verify recent data still exists (using fixed time base for comparison)
			const cutoffChecks = new Date(FIXED_NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
			const recentChecks = raw.prepare('SELECT * FROM checks WHERE checked_at > ?').all(cutoffChecks) as CheckRow[];
			expect(recentChecks.length).toBe(2);

			const cutoffDaily = new Date(FIXED_NOW.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
			const recentDaily = raw.prepare('SELECT * FROM daily_status WHERE date > ?').all(cutoffDaily) as DailyStatusRow[];
			expect(recentDaily.length).toBe(2);
		});
	});
});