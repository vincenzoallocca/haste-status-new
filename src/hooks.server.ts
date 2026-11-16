import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { getSession, getUserById, isAppSetup, userToPublic } from '$lib/server/db/auth';

// Public status, monitoring and cron paths that NEVER require setup check or authentication
const PUBLIC_STATUS_PATHS = [
	'/status',
	'/api/public',
	'/api/cron'
];

// All paths exempt from authentication requirement (includes login and setup flows)
const PUBLIC_PATHS = [
	'/login',
	'/setup',
	'/status',
	'/api/auth/login',
	'/api/auth/setup',
	'/api/auth/status',
	'/api/cron',
	'/api/status',
	'/api/public'
];

// CSP configuration for Report-Only mode
// All resources are self-hosted; no external dependencies
const CSP_REPORT_ONLY = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self'",
	"img-src 'self' data:",
	"font-src 'self'",
	"connect-src 'self'",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
	"upgrade-insecure-requests"
].join('; ');

export const handle: Handle = async ({ event, resolve }) => {
	const { cookies, url, platform } = event;

	// Helper to apply security headers to every response
	const secureResponse = (response: Response): Response => {
		response.headers.set('X-Content-Type-Options', 'nosniff');
		response.headers.set('X-Frame-Options', 'SAMEORIGIN');
		response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
		response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
		response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
		// Content Security Policy (Report-Only mode for validation)
		response.headers.set('Content-Security-Policy-Report-Only', CSP_REPORT_ONLY);
		return response;
	};

	// Initialize locals
	event.locals.user = null;
	event.locals.sessionId = null;

	// Check if this is a public status/monitoring/cron path (bypasses setup checks and auth)
	const isPublicStatusPath = PUBLIC_STATUS_PATHS.some(
		(path) => url.pathname === path || url.pathname.startsWith(path + '/')
	);

	// Public status and cron paths proceed directly to their handlers without D1 setup queries
	if (isPublicStatusPath) {
		return secureResponse(await resolve(event));
	}

	// Check if this path is exempt from authentication (e.g. login, setup, api/auth/*)
	const isPublicPath = PUBLIC_PATHS.some(
		(path) => url.pathname === path || url.pathname.startsWith(path + '/')
	);

	if (!platform?.env?.DB) {
		// No database available, allow request to proceed
		return secureResponse(await resolve(event));
	}

	const db = platform.env.DB;

	// Check if app is setup - protected by try/catch for D1 resilience (e.g. Code 7500)
	let setupComplete: boolean;
	try {
		setupComplete = await isAppSetup(db);
	} catch (error) {
		console.error('[Hooks] Database error checking setup status:', error);
		// In case of D1 failure: do NOT assume app is set up, do NOT allow protected access.
		// Return controlled 503 Service Unavailable response with security headers.
		if (url.pathname.startsWith('/api/')) {
			return secureResponse(
				new Response(
					JSON.stringify({
						error: 'Database rate limited or temporarily unavailable. Resets at 00:00 UTC.'
					}),
					{
						status: 503,
						headers: {
							'Content-Type': 'application/json',
							'Retry-After': '60',
							'Cache-Control': 'no-store'
						}
					}
				)
			);
		}

		return secureResponse(
			new Response(
				'Service Unavailable — Database rate limited or temporarily unavailable. Please retry shortly.',
				{
					status: 503,
					headers: {
						'Content-Type': 'text/plain; charset=utf-8',
						'Retry-After': '60',
						'Cache-Control': 'no-store'
					}
				}
			)
		);
	}

	// If not setup and not on setup page, redirect to setup
	if (!setupComplete && url.pathname !== '/setup' && !url.pathname.startsWith('/api/auth/')) {
		throw redirect(302, '/setup');
	}

	// If setup complete and on setup page, redirect to login
	if (setupComplete && url.pathname === '/setup') {
		throw redirect(302, '/login');
	}

	// Check session cookie
	const sessionId = cookies.get('session');

	if (sessionId) {
		try {
			const session = await getSession(db, sessionId);

			if (session) {
				const user = await getUserById(db, session.user_id);

				if (user) {
					event.locals.user = userToPublic(user);
					event.locals.sessionId = sessionId;
				}
			}
		} catch (err) {
			console.warn('[Hooks] Failed to validate session (database error):', err);
			event.locals.user = null;
			event.locals.sessionId = null;
		}
	}

	// If authenticated and on login page, redirect to dashboard
	if (event.locals.user && url.pathname === '/login') {
		throw redirect(302, '/');
	}

	// If not authenticated and on root, redirect to public status page
	if (!event.locals.user && url.pathname === '/' && setupComplete) {
		throw redirect(302, '/status');
	}

	// If not authenticated and not on public path, redirect to login (or 401 for API)
	if (!event.locals.user && !isPublicPath && setupComplete) {
		if (url.pathname.startsWith('/api/')) {
			return secureResponse(
				new Response(JSON.stringify({ error: 'Unauthorized' }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' }
				})
			);
		}
		throw redirect(302, '/login');
	}

	return secureResponse(await resolve(event));
};
