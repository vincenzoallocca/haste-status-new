import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPublicGroupsWithStatus } from '$lib/server/db/groups';
import { getOverallStatus } from '$lib/types/status';
import type { StatusMonitor } from '$lib/types/status';

export const GET: RequestHandler = async ({ platform, request }) => {
	if (!platform?.env?.DB) {
		return json(
			{
				overall_status: 'unknown',
				error: 'Database not available',
				groups: [],
				monitors: []
			},
			{
				status: 503,
				headers: {
					'Retry-After': '60',
					'Cache-Control': 'no-store'
				}
			}
		);
	}

	try {
		// Check Cloudflare Cache API first
		let cache: { match: (req: Request | string) => Promise<Response | undefined>; put: (req: Request | string, resp: Response) => Promise<void> } | undefined;
		try {
			cache = (globalThis as unknown as { caches?: { default?: typeof cache } }).caches?.default;
		} catch {
			// Cache API not available
		}

		if (cache) {
			try {
				const cached = await cache.match(request.url);
				if (cached) {
					return cached;
				}
			} catch {
				// Cache read error ignored
			}
		}

		const groups = await getPublicGroupsWithStatus(platform.env.DB);

		// Flatten monitors from all public groups
		const monitors: StatusMonitor[] = groups.flatMap((g) => g.monitors);
		const overallStatus = getOverallStatus(monitors);

		const data = json({
			overall_status: overallStatus,
			groups,
			monitors
		});

		// Cache for 60 seconds with Cache-Control header
		const headers = new Headers(data.headers);
		headers.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=30');
		
		const response = new Response(data.body, {
			status: data.status,
			statusText: data.statusText,
			headers
		});

		// Store in Cloudflare Cache API if available
		if (cache) {
			try {
				await cache.put(request.url, response.clone());
			} catch {
				// Cache put error ignored
			}
		}

		return response;
	} catch (error) {
		console.error('[Public Status API] Database query failed (e.g. rate limit):', error);
		return json(
			{
				overall_status: 'unknown',
				error: 'Database rate limited or temporarily unavailable. Resets at 00:00 UTC.',
				groups: [],
				monitors: []
			},
			{
				status: 503,
				headers: {
					'Retry-After': '60',
					'Cache-Control': 'no-store'
				}
			}
		);
	}
};
