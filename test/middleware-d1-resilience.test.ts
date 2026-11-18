import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeD1 } from './helpers/fake-d1';
import type { D1Database } from '@cloudflare/workers-types';
import { join } from 'node:path';
import * as auth from '../src/lib/server/db/auth';
import { GET as cronHandler } from '../src/routes/api/cron/+server';

const MIGRATIONS = join(__dirname, '..', 'migrations');

describe('Middleware D1 Resilience (hooks.server.ts)', () => {
	let db: D1Database;

	beforeEach(async () => {
		db = await createFakeD1(MIGRATIONS);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function getHandle() {
		// Import hooks handle fresh
		const mod = await import('../src/hooks.server');
		return mod.handle;
	}

	function createFailingD1(): D1Database {
		return {
			prepare: vi.fn().mockImplementation(() => {
				throw new Error("Your account has exceeded D1's free tier daily row read limit [code: 7500]");
			}),
			batch: vi.fn().mockRejectedValue(new Error('D1 Code 7500')),
			exec: vi.fn().mockRejectedValue(new Error('D1 Code 7500')),
			dump: vi.fn().mockRejectedValue(new Error('D1 Code 7500'))
		} as unknown as D1Database;
	}

	it('1. Public route (/status) works and reaches handler even if D1 throws Code 7500', async () => {
		const handle = await getHandle();
		const failingDb = createFailingD1();

		const mockEvent = {
			cookies: { get: vi.fn().mockReturnValue(undefined) },
			url: new URL('https://status.haste.it/status'),
			platform: { env: { DB: failingDb } },
			locals: {}
		} as any;

		const mockResolve = vi.fn().mockResolvedValue(new Response('<html>Public Status</html>', { status: 200 }));

		const response = await handle({ event: mockEvent, resolve: mockResolve });

		expect(mockResolve).toHaveBeenCalledTimes(1);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('<html>Public Status</html>');
		expect(response.headers.get('Strict-Transport-Security')).toBeDefined();
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
	});

	it('2. /api/public/status reaches its handler WITHOUT calling isAppSetup', async () => {
		const handle = await getHandle();
		const isAppSetupSpy = vi.spyOn(auth, 'isAppSetup');
		const failingDb = createFailingD1();

		const mockEvent = {
			cookies: { get: vi.fn().mockReturnValue(undefined) },
			url: new URL('https://status.haste.it/api/public/status'),
			platform: { env: { DB: failingDb } },
			locals: {}
		} as any;

		const mockResolve = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ overall_status: 'operational' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		const response = await handle({ event: mockEvent, resolve: mockResolve });

		expect(isAppSetupSpy).not.toHaveBeenCalled();
		expect(mockResolve).toHaveBeenCalledTimes(1);
		expect(response.status).toBe(200);
		expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
	});

	it('3. /api/cron reaches handler without calling isAppSetup even if D1 has Code 7500', async () => {
		const handle = await getHandle();
		const isAppSetupSpy = vi.spyOn(auth, 'isAppSetup');
		const failingDb = createFailingD1();

		const mockEvent = {
			cookies: { get: vi.fn().mockReturnValue(undefined) },
			url: new URL('https://status.haste.it/api/cron'),
			platform: { env: { DB: failingDb } },
			locals: {}
		} as any;

		const mockResolve = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ checked: 4 }), { status: 200 })
		);

		const response = await handle({ event: mockEvent, resolve: mockResolve });

		expect(isAppSetupSpy).not.toHaveBeenCalled();
		expect(mockResolve).toHaveBeenCalledTimes(1);
		expect(response.status).toBe(200);
	});

	it('4. Protected route is NOT accessible when D1 is unavailable (returns controlled 503)', async () => {
		const handle = await getHandle();
		const failingDb = createFailingD1();

		const mockEvent = {
			cookies: { get: vi.fn().mockReturnValue(undefined) },
			url: new URL('https://status.haste.it/admin/status'),
			platform: { env: { DB: failingDb } },
			locals: {}
		} as any;

		const mockResolve = vi.fn().mockResolvedValue(new Response('Admin Secret Area', { status: 200 }));

		const response = await handle({ event: mockEvent, resolve: mockResolve });

		// Handler was NOT resolved - access denied
		expect(mockResolve).not.toHaveBeenCalled();
		expect(response.status).toBe(503);
		expect(response.headers.get('Retry-After')).toBe('60');
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
	});

	it('5. Protected API route returns 503 JSON with Retry-After when D1 is unavailable', async () => {
		const handle = await getHandle();
		const failingDb = createFailingD1();

		const mockEvent = {
			cookies: { get: vi.fn().mockReturnValue(undefined) },
			url: new URL('https://status.haste.it/api/monitors'),
			platform: { env: { DB: failingDb } },
			locals: {}
		} as any;

		const mockResolve = vi.fn();

		const response = await handle({ event: mockEvent, resolve: mockResolve });

		expect(mockResolve).not.toHaveBeenCalled();
		expect(response.status).toBe(503);
		expect(response.headers.get('Content-Type')).toBe('application/json');
		const body = await response.json();
		expect(body.error).toContain('Database rate limited or temporarily unavailable');
	});

	it('6. Redirect to /setup functions normally when D1 is working and app is NOT setup', async () => {
		const handle = await getHandle();
		// D1 is empty, setup_complete is not present

		const mockEvent = {
			cookies: { get: vi.fn().mockReturnValue(undefined) },
			url: new URL('https://status.haste.it/login'),
			platform: { env: { DB: db } },
			locals: {}
		} as any;

		const mockResolve = vi.fn();

		// Should throw SvelteKit redirect(302, '/setup')
		try {
			await handle({ event: mockEvent, resolve: mockResolve });
			expect.fail('Should have redirected to /setup');
		} catch (err: any) {
			expect(err.status).toBe(302);
			expect(err.location).toBe('/setup');
		}
	});

	it('7. Redirect to /login functions normally when D1 is working and app IS setup', async () => {
		const handle = await getHandle();
		// Mark app as setup
		await db
			.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('setup_complete', 'true', datetime('now'))")
			.run();

		const mockEvent = {
			cookies: { get: vi.fn().mockReturnValue(undefined) },
			url: new URL('https://status.haste.it/setup'),
			platform: { env: { DB: db } },
			locals: {}
		} as any;

		const mockResolve = vi.fn();

		// Should throw SvelteKit redirect(302, '/login')
		try {
			await handle({ event: mockEvent, resolve: mockResolve });
			expect.fail('Should have redirected to /login');
		} catch (err: any) {
			expect(err.status).toBe(302);
			expect(err.location).toBe('/login');
		}
	});

	it('8. Root (/) redirects unauthenticated user to /status when setup is complete', async () => {
		const handle = await getHandle();
		await db
			.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('setup_complete', 'true', datetime('now'))")
			.run();

		const mockEvent = {
			cookies: { get: vi.fn().mockReturnValue(undefined) },
			url: new URL('https://status.haste.it/'),
			platform: { env: { DB: db } },
			locals: {}
		} as any;

		const mockResolve = vi.fn();

		try {
			await handle({ event: mockEvent, resolve: mockResolve });
			expect.fail('Should have redirected to /status');
		} catch (err: any) {
			expect(err.status).toBe(302);
			expect(err.location).toBe('/status');
		}
	});

	it('9. Security headers are always attached to responses including 503 and public responses', async () => {
		const handle = await getHandle();
		const failingDb = createFailingD1();

		const mockEvent = {
			cookies: { get: vi.fn().mockReturnValue(undefined) },
			url: new URL('https://status.haste.it/api/monitors'),
			platform: { env: { DB: failingDb } },
			locals: {}
		} as any;

		const response = await handle({ event: mockEvent, resolve: vi.fn() });

		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
		expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
		expect(response.headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
		expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains; preload');
		expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
	});

	it('10. D1 errors do not produce unhandled exceptions', async () => {
		const handle = await getHandle();
		const failingDb = createFailingD1();

		// Test multiple routes under D1 failure
		const urls = [
			'https://status.haste.it/status',
			'https://status.haste.it/api/public/status',
			'https://status.haste.it/api/cron',
			'https://status.haste.it/admin/status',
			'https://status.haste.it/api/groups'
		];

		for (const u of urls) {
			const mockEvent = {
				cookies: { get: vi.fn().mockReturnValue(undefined) },
				url: new URL(u),
				platform: { env: { DB: failingDb } },
				locals: {}
			} as any;

			const mockResolve = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
			
			// Must never throw unhandled exception
			await expect(handle({ event: mockEvent, resolve: mockResolve })).resolves.toBeInstanceOf(Response);
		}
	});

	describe('Autonomous /api/cron Secret Validation', () => {
		it('rejects /api/cron request missing X-Cron-Secret header with 403 Forbidden', async () => {
			const req = new Request('https://status.haste.it/api/cron', { method: 'GET' });
			const response = await cronHandler({
				platform: { env: { CRON_SECRET: 'valid-secret-12345', DB: db } },
				request: req
			} as any);

			expect(response.status).toBe(403);
			const data = await response.json();
			expect(data).toEqual({ error: 'Forbidden' });
		});

		it('rejects /api/cron request with invalid X-Cron-Secret header with 403 Forbidden', async () => {
			const req = new Request('https://status.haste.it/api/cron', {
				method: 'GET',
				headers: { 'X-Cron-Secret': 'wrong-attacker-secret' }
			});
			const response = await cronHandler({
				platform: { env: { CRON_SECRET: 'valid-secret-12345', DB: db } },
				request: req
			} as any);

			expect(response.status).toBe(403);
			const data = await response.json();
			expect(data).toEqual({ error: 'Forbidden' });
		});

		it('rejects /api/cron request if CRON_SECRET is not configured in platform env with 403 Forbidden', async () => {
			const req = new Request('https://status.haste.it/api/cron', {
				method: 'GET',
				headers: { 'X-Cron-Secret': 'some-secret' }
			});
			const response = await cronHandler({
				platform: { env: { DB: db } },
				request: req
			} as any);

			expect(response.status).toBe(403);
			const data = await response.json();
			expect(data).toEqual({ error: 'Forbidden' });
		});

		it('accepts /api/cron request when X-Cron-Secret exactly matches CRON_SECRET', async () => {
			const req = new Request('https://status.haste.it/api/cron', {
				method: 'GET',
				headers: { 'X-Cron-Secret': 'valid-secret-12345' }
			});
			const response = await cronHandler({
				platform: { env: { CRON_SECRET: 'valid-secret-12345', DB: db } },
				request: req
			} as any);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data.message).toBeDefined();
		});
	});
});
