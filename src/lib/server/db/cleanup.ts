import type { D1Database } from '@cloudflare/workers-types';

/**
 * Idempotency helper for daily cleanup.
 * Uses D1's INSERT OR IGNORE with unique constraint on date to atomically claim cleanup slot.
 * Claim ownership is verified via claim_token (UUID) on all state transitions.
 * Only marks as completed after successful cleanup execution.
 * If cleanup fails, the row is kept with error populated to allow retry on next cron tick.
 * If a stale row exists (started_at set but no completed_at, older than grace period),
 * it is treated as a failed attempt and replaced atomically to allow retry.
 */

const STALE_GRACE_MS = 5 * 60 * 1000; // 5 minutes — cron runs every minute, cleanup takes seconds

function generateClaimToken(): string {
	return crypto.randomUUID();
}

export interface CleanupResult {
	claimSuccess: boolean;
	alreadyRun: boolean;
	checksDeleted: number;
	dailyStatusDeleted: number;
	error?: string;
	claimToken?: string;
}

export async function runDailyCleanupOnce(db: D1Database): Promise<CleanupResult> {
	const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD in UTC
	const now = new Date().toISOString();
	const claimToken = generateClaimToken();

	// Try to claim the cleanup slot for today
	// INSERT OR IGNORE returns 0 changes if row already exists (unique constraint on date)
	const claimResult = await db
		.prepare('INSERT OR IGNORE INTO cleanup_runs (date, started_at, claim_token) VALUES (?, ?, ?)')
		.bind(today, now, claimToken)
		.run();

	// If no row was inserted, cleanup was already claimed/completed today
	if (claimResult.meta.changes === 0) {
		// Check existing row state
		const existing = await db
			.prepare('SELECT started_at, completed_at, error, claim_token FROM cleanup_runs WHERE date = ?')
			.bind(today)
			.first<{ started_at: string; completed_at: string | null; error: string | null; claim_token: string | null }>();

		if (existing?.completed_at) {
			// Already completed successfully
			return {
				claimSuccess: false,
				alreadyRun: true,
				checksDeleted: 0,
				dailyStatusDeleted: 0
			};
		}

		if (existing?.started_at) {
			const startedAt = new Date(existing.started_at).getTime();
			const nowMs = Date.now();
			const ageMs = nowMs - startedAt;

			if (ageMs > STALE_GRACE_MS) {
				// Stale row — previous attempt likely crashed/interrupted
				// Atomically replace only if still stale (no completed_at, same started_at)
				const newToken = generateClaimToken();
				const replaced = await db
					.prepare(
						'UPDATE cleanup_runs SET started_at = ?, claim_token = ?, error = NULL WHERE date = ? AND completed_at IS NULL AND started_at = ?'
					)
					.bind(now, newToken, today, existing.started_at)
					.run();

				if (replaced.meta.changes === 0) {
					// Lost race — row was completed or claimed by another instance
					const current = await db
						.prepare('SELECT completed_at FROM cleanup_runs WHERE date = ?')
						.bind(today)
						.first<{ completed_at: string | null }>();

					if (current?.completed_at) {
						return {
							claimSuccess: false,
							alreadyRun: true,
							checksDeleted: 0,
							dailyStatusDeleted: 0
						};
					}
					// Another instance claimed it
					return {
						claimSuccess: false,
						alreadyRun: true,
						checksDeleted: 0,
						dailyStatusDeleted: 0,
						error: 'Cleanup claimed by another instance after stale cleanup'
					};
				}
				// We claimed it — fall through to run cleanup with new token
				return runCleanupWithToken(db, today, newToken);
			} else {
				// Fresh row — another instance may be running
				return {
					claimSuccess: false,
					alreadyRun: true,
					checksDeleted: 0,
					dailyStatusDeleted: 0,
					error: 'Cleanup already in progress (claimed by another instance)'
				};
			}
		} else {
			// Row exists but no started_at (should not happen with current schema)
			// Atomically claim it
			const newToken = generateClaimToken();
			const claimed = await db
				.prepare('UPDATE cleanup_runs SET started_at = ?, claim_token = ?, error = NULL WHERE date = ? AND started_at IS NULL')
				.bind(now, newToken, today)
				.run();

			if (claimed.meta.changes === 0) {
				// Lost race
				return {
					claimSuccess: false,
					alreadyRun: true,
					checksDeleted: 0,
					dailyStatusDeleted: 0,
					error: 'Cleanup claimed by another instance'
				};
			}
			// We claimed it — fall through to run cleanup with new token
			return runCleanupWithToken(db, today, newToken);
		}
	}

	// We claimed the slot via INSERT — run cleanup with our token
	return runCleanupWithToken(db, today, claimToken);
}

async function runCleanupWithToken(db: D1Database, date: string, claimToken: string): Promise<CleanupResult> {
	let checksDeleted = 0;
	let dailyStatusDeleted = 0;
	let cleanupError: string | undefined;

	try {
		const { aggregateDailyStatus } = await import('./status');
		await aggregateDailyStatus(db);
		console.log('[Daily Cleanup] Aggregated daily status for yesterday');
	} catch (err) {
		const errMsg = `aggregateDailyStatus failed: ${err instanceof Error ? err.message : String(err)}`;
		cleanupError = cleanupError ? `${cleanupError}; ${errMsg}` : errMsg;
		console.error('[Daily Cleanup]', errMsg);
	}

	try {
		const { cleanupOldChecks } = await import('./monitors');
		checksDeleted = await cleanupOldChecks(db, 7);
		if (checksDeleted > 0) {
			console.log(`[Daily Cleanup] Cleaned up ${checksDeleted} old checks`);
		}
	} catch (err) {
		cleanupError = `cleanupOldChecks failed: ${err instanceof Error ? err.message : String(err)}`;
		console.error('[Daily Cleanup]', cleanupError);
	}

	try {
		const { cleanupOldDailyStatus } = await import('./status');
		dailyStatusDeleted = await cleanupOldDailyStatus(db, 90);
		if (dailyStatusDeleted > 0) {
			console.log(`[Daily Cleanup] Cleaned up ${dailyStatusDeleted} old daily_status records`);
		}
	} catch (err) {
		const errMsg = `cleanupOldDailyStatus failed: ${err instanceof Error ? err.message : String(err)}`;
		cleanupError = cleanupError ? `${cleanupError}; ${errMsg}` : errMsg;
		console.error('[Daily Cleanup]', errMsg);
	}

	const completedAt = new Date().toISOString();

	if (cleanupError) {
		// Cleanup failed — persist error in row, keep started_at, leave completed_at NULL
		// Next cron tick will see error + stale (if > grace period) and retry
		// Must verify claim_token to prevent overwriting another instance's row
		await db
			.prepare('UPDATE cleanup_runs SET error = ? WHERE date = ? AND claim_token = ? AND completed_at IS NULL')
			.bind(cleanupError, date, claimToken)
			.run();
		return {
			claimSuccess: true,
			alreadyRun: false,
			checksDeleted,
			dailyStatusDeleted,
			error: cleanupError,
			claimToken
		};
	}

	// Cleanup succeeded — mark as completed
	// Must verify claim_token to prevent overwriting another instance's completion
	const completeResult = await db
		.prepare(
			'UPDATE cleanup_runs SET completed_at = ?, checks_deleted = ?, daily_status_deleted = ? WHERE date = ? AND claim_token = ? AND completed_at IS NULL'
		)
		.bind(completedAt, checksDeleted, dailyStatusDeleted, date, claimToken)
		.run();

	if (completeResult.meta.changes === 0) {
		// Claim lost — another instance completed or we're using stale token
		return {
			claimSuccess: false,
			alreadyRun: true,
			checksDeleted: 0,
			dailyStatusDeleted: 0,
			error: 'Cleanup completed by another instance (claim lost)',
			claimToken
		};
	}

	return {
		claimSuccess: true,
		alreadyRun: false,
		checksDeleted,
		dailyStatusDeleted,
		claimToken
	};
}

/**
 * Get cleanup run status for a specific date (for debugging/monitoring)
 */
export async function getCleanupRunStatus(
	db: D1Database,
	date: string
): Promise<{
	date: string;
	started_at: string;
	completed_at: string | null;
	checks_deleted: number;
	daily_status_deleted: number;
	error: string | null;
	claim_token: string | null;
} | null> {
	return db
		.prepare('SELECT * FROM cleanup_runs WHERE date = ?')
		.bind(date)
		.first();
}

/**
 * Get recent cleanup runs (for monitoring dashboard)
 */
export async function getRecentCleanupRuns(
	db: D1Database,
	limit = 30
): Promise<
	Array<{
		date: string;
		started_at: string;
		completed_at: string | null;
		checks_deleted: number;
		daily_status_deleted: number;
		error: string | null;
		claim_token: string | null;
	}>
> {
	const results = await db
		.prepare('SELECT * FROM cleanup_runs ORDER BY date DESC LIMIT ?')
		.bind(limit)
		.all();
	return results.results as Array<{
		date: string;
		started_at: string;
		completed_at: string | null;
		checks_deleted: number;
		daily_status_deleted: number;
		error: string | null;
		claim_token: string | null;
	}>;
}