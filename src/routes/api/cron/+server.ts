import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getActiveMonitors,
	insertCheck,
	getLastCheck
} from '$lib/server/db/monitors';
import { runCheck } from '$lib/server/checkers';
import { sendNotifications } from '$lib/server/notifications';
import { invalidatePublicStatusCache } from '$lib/server/db/groups';
import { runDailyCleanupOnce } from '$lib/server/db/cleanup';
import type { MonitorStatus } from '$lib/types/monitor';

function timingSafeEqual(a: string, b: string): boolean {
	const enc = new TextEncoder();
	const bufA = enc.encode(a.trim());
	const bufB = enc.encode(b.trim());
	if (bufA.length !== bufB.length) return false;
	let diff = 0;
	for (let i = 0; i < bufA.length; i++) {
		diff |= bufA[i] ^ bufB[i];
	}
	return diff === 0;
}

// KV caching disabled to stay within free tier limits (1000 puts/day)
// D1 queries are fast enough for small-scale monitoring

export const GET: RequestHandler = async ({ platform, request }) => {
	// Validate cron secret - must match CRON_SECRET environment variable
	const cronSecret = platform?.env?.CRON_SECRET;
	const providedSecret = request.headers.get('X-Cron-Secret');

	if (!cronSecret || !providedSecret || !timingSafeEqual(providedSecret, cronSecret)) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	if (!platform?.env?.DB) {
		return json({ error: 'Database not available' }, { status: 500 });
	}

	const db = platform.env.DB;
	const monitors = await getActiveMonitors(db);

	if (monitors.length === 0) {
		return json({ message: 'No active monitors', checked: 0 });
	}

	const results = await Promise.allSettled(
		monitors.map(async (monitor) => {
			const lastCheck = await getLastCheck(db, monitor.id);

			// Respect configured interval: skip if interval has not elapsed
			if (lastCheck?.checked_at && monitor.interval_seconds && monitor.interval_seconds > 60) {
				const lastCheckedMs = new Date(lastCheck.checked_at).getTime();
				const elapsedSeconds = (Date.now() - lastCheckedMs) / 1000;
				if (elapsedSeconds < monitor.interval_seconds - 5) {
					return {
						monitorId: monitor.id,
						status: lastCheck.status,
						responseTimeMs: lastCheck.response_time_ms,
						statusCode: lastCheck.status_code,
						errorMessage: lastCheck.error_message,
						skipped: true
					};
				}
			}

			const previousStatus: MonitorStatus | null = lastCheck?.status ?? null;

			const result = await runCheck(monitor);
			await insertCheck(
				db,
				monitor.id,
				result.status,
				result.responseTimeMs,
				result.statusCode,
				result.errorMessage,
				null // checked_from - could add colo info later
			);

			// Send notifications on status change
			if (previousStatus !== result.status) {
				try {
					await sendNotifications(
						db,
						monitor,
						previousStatus,
						result.status,
						null, // incident tracking to be implemented
						'mailto:admin@pingflare.app'
					);
				} catch (err) {
					console.error(`Failed to send notifications for monitor ${monitor.id}:`, err);
				}
			}

			return {
				monitorId: monitor.id,
				status: result.status,
				responseTimeMs: result.responseTimeMs,
				statusCode: result.statusCode,
				errorMessage: result.errorMessage
			};
		})
	);

	const successful = results.filter((r) => r.status === 'fulfilled').length;
	const failed = results.filter((r) => r.status === 'rejected').length;

	// Invalidate public status cache after new checks
	invalidatePublicStatusCache();

	// Run daily cleanup and status aggregation at 03:00 UTC (with idempotency protection)
	const now = new Date();
	if (now.getUTCHours() === 3 && now.getUTCMinutes() === 0) {
		try {
			await runDailyCleanupOnce(db);
		} catch (err) {
			console.error('Failed to run daily cleanup:', err);
		}
	}

	return json({
		message: 'Health checks completed',
		checked: monitors.length,
		successful,
		failed,
		results: results.map((r) => (r.status === 'fulfilled' ? r.value : { error: r.reason }))
	});
};
