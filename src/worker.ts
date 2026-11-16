/**
 * Custom Cloudflare Worker entry point that wraps SvelteKit's generated handler
 * and adds a scheduled handler for cron-triggered health checks and daily maintenance.
 *
 * This enables deployment via Cloudflare Workers (with Deploy Button support)
 * instead of Cloudflare Pages.
 */

// The SvelteKit handler is imported at build time from the generated output
// @ts-expect-error - This import is resolved during the build process
import svelteKitHandler from './__sveltekit/handler.js';

interface Env {
	DB: D1Database;
	ASSETS: Fetcher;
	ENVIRONMENT?: string;
	CRON_SECRET?: string;
}

/**
 * Run daily maintenance cleanup with idempotency protection.
 * Uses D1-based atomic claim to ensure cleanup runs exactly once per day at 03:00 UTC.
 */
async function runDailyCleanupWithIdempotency(env: Env): Promise<void> {
	if (!env.DB) {
		console.error('[Daily Cleanup] Database not available');
		return;
	}

	const { runDailyCleanupOnce } = await import('./lib/server/db/cleanup');
	const result = await runDailyCleanupOnce(env.DB);

	if (result.alreadyRun) {
		if (result.error) {
			console.warn('[Daily Cleanup] Skipped:', result.error);
		} else {
			console.log('[Daily Cleanup] Already completed for today');
		}
		return;
	}

	if (result.error) {
		console.error('[Daily Cleanup] Failed:', result.error);
		return;
	}

	if (result.checksDeleted > 0 || result.dailyStatusDeleted > 0) {
		console.log(
			`[Daily Cleanup] Completed: ${result.checksDeleted} checks, ${result.dailyStatusDeleted} daily_status records deleted`
		);
	}
}

export default {
	/**
	 * Handle incoming HTTP requests by delegating to SvelteKit's generated handler.
	 */
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		return svelteKitHandler.fetch(request, env, _ctx);
	},

	/**
	 * Handle scheduled cron triggers.
	 * Single cron trigger (every minute): runs health checks every minute,
	 * and daily maintenance cleanup at 03:00 UTC with idempotency protection.
	 */
	async scheduled(
		controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext
	): Promise<void> {
		const cronPattern = controller.cron;
		const now = new Date();
		const isDailyCleanupTime = now.getUTCHours() === 3 && now.getUTCMinutes() === 0;

		console.log(`[Scheduler] Cron triggered: ${cronPattern} at ${now.toISOString()}${isDailyCleanupTime ? ' (daily cleanup window)' : ''}`);

		// Daily maintenance cleanup at 03:00 UTC (with idempotency protection)
		if (isDailyCleanupTime) {
			await runDailyCleanupWithIdempotency(env);
		}

		// Minute cron: trigger health checks via /api/cron endpoint
		if (!env.CRON_SECRET) {
			console.error('[Scheduler] CRON_SECRET not configured');
			return;
		}

		// Create a synthetic request to the cron endpoint
		// The URL doesn't matter for internal routing - SvelteKit will match the path
		const request = new Request('https://pingflare.internal/api/cron', {
			method: 'GET',
			headers: {
				'User-Agent': 'Pingflare-Scheduler/1.0',
				'X-Cron-Secret': env.CRON_SECRET
			}
		});

		try {
			const response = await svelteKitHandler.fetch(request, env, ctx);

			if (!response.ok) {
				console.error(`[Scheduler] Cron endpoint returned ${response.status}`);
				return;
			}

			const result = await response.json();
			console.log('[Scheduler] Health checks completed:', JSON.stringify(result));
		} catch (error) {
			console.error('[Scheduler] Failed to trigger health checks:', error);
		}
	}
};