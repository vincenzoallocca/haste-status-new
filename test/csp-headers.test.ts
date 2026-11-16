import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeD1 } from './helpers/fake-d1';
import type { D1Database } from '@cloudflare/workers-types';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '..', 'migrations');

describe('CSP Headers - Security Policy Verification', () => {
	let db: D1Database;

	beforeEach(async () => {
		db = await createFakeD1(MIGRATIONS);
		// Mark app as setup to avoid redirects to /setup
		await db
			.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('setup_complete', 'true', datetime('now'))")
			.run();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function getHandle() {
		const mod = await import('../src/hooks.server.js');
		return mod.handle;
	}

	async function createTestUser(db: D1Database, email = 'test@haste.it', password = 'password') {
		const userId = crypto.randomUUID();
		const salt = crypto.getRandomValues(new Uint8Array(16));
		const hash = await (async () => {
			const enc = new TextEncoder();
			const key = await crypto.subtle.importKey(
				'raw',
				enc.encode(password),
				{ name: 'PBKDF2' },
				false,
				['deriveBits'],
			);
			const bits = await crypto.subtle.deriveBits(
				{ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
				key,
				32 * 8,
			);
			return new Uint8Array(bits);
		})();
		const hashStr = `pbkdf2:100000:${Array.from(salt)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')}:${Array.from(hash)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')}`;
		const now = new Date().toISOString();
		const emailNormalized = email.toLowerCase();
		db.exec(`
			INSERT INTO users (id, name, email, email_normalized, password_hash, role, created_at, updated_at)
			VALUES ('${userId}', 'Test User', '${email}', '${emailNormalized}', '${hashStr}', 'admin', '${now}', '${now}');
		`);
		return { userId };
	}

	async function createSession(db: D1Database, userId: string) {
		const sessionId = crypto.randomUUID();
		const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
		const now = new Date().toISOString();
		db.exec(`
			INSERT INTO sessions (id, user_id, expires_at, created_at)
			VALUES ('${sessionId}', '${userId}', '${expiresAt}', '${now}');
		`);
		return sessionId;
	}

	it('handles request and applies CSP Report-Only header on public path', async () => {
		const handle = await getHandle();
		
		const mockEvent = {
			cookies: {
				get: vi.fn().mockReturnValue(undefined),
			},
			url: new URL('https://status.haste.it/status'),
			platform: {
				env: {
					DB: db,
				},
			},
			locals: {},
		};

		const mockResolve = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
		
		const response = await handle({ event: mockEvent, resolve: mockResolve });
		
		// Verify CSP Report-Only header is present
		expect(response.headers.get('Content-Security-Policy-Report-Only')).toBeDefined();
		expect(response.headers.get('Content-Security-Policy-Report-Only')).toContain("default-src 'self'");
		expect(response.headers.get('Content-Security-Policy-Report-Only')).toContain("script-src 'self'");
		expect(response.headers.get('Content-Security-Policy-Report-Only')).toContain("style-src 'self'");
		
		// Verify NO enforcing CSP header is set
		expect(response.headers.get('Content-Security-Policy')).toBeNull();
	});

	it('applies CSP Report-Only header on API responses (public path)', async () => {
		const handle = await getHandle();
		
		const mockEvent = {
			cookies: {
				get: vi.fn().mockReturnValue(undefined),
			},
			url: new URL('https://status.haste.it/api/status'),
			platform: {
				env: {
					DB: db,
				},
			},
			locals: {},
		};

		const mockResolve = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { 
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		}));
		
		const response = await handle({ event: mockEvent, resolve: mockResolve });
		
		expect(response.headers.get('Content-Security-Policy-Report-Only')).toBeDefined();
		expect(response.headers.get('Content-Security-Policy')).toBeNull();
	});

	it('applies CSP Report-Only header on error responses (public path)', async () => {
		const handle = await getHandle();
		
		const mockEvent = {
			cookies: {
				get: vi.fn().mockReturnValue(undefined),
			},
			url: new URL('https://status.haste.it/api/public/nonexistent'),
			platform: {
				env: {
					DB: db,
				},
			},
			locals: {},
		};

		const mockResolve = vi.fn().mockResolvedValue(new Response('Not Found', { status: 404 }));
		
		const response = await handle({ event: mockEvent, resolve: mockResolve });
		
		expect(response.headers.get('Content-Security-Policy-Report-Only')).toBeDefined();
		expect(response.headers.get('Content-Security-Policy')).toBeNull();
	});

	it('applies CSP Report-Only header on redirect responses', async () => {
		const handle = await getHandle();
		
		const mockEvent = {
			cookies: {
				get: vi.fn().mockReturnValue(undefined),
			},
			url: new URL('https://status.haste.it/login'),
			platform: {
				env: {
					DB: db,
				},
			},
			locals: {},
		};

		// Simulate a redirect response from resolve
		const mockResolve = vi.fn().mockResolvedValue(new Response(null, { 
			status: 302,
			headers: { Location: '/status' }
		}));
		
		const response = await handle({ event: mockEvent, resolve: mockResolve });
		
		expect(response.headers.get('Content-Security-Policy-Report-Only')).toBeDefined();
		expect(response.headers.get('Content-Security-Policy')).toBeNull();
	});

	it('verifies CSP policy contains all required directives', async () => {
		const handle = await getHandle();
		
		const mockEvent = {
			cookies: {
				get: vi.fn().mockReturnValue(undefined),
			},
			url: new URL('https://status.haste.it/status'),
			platform: {
				env: {
					DB: db,
				},
			},
			locals: {},
		};

		const mockResolve = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
		
		const response = await handle({ event: mockEvent, resolve: mockResolve });
		
		const csp = response.headers.get('Content-Security-Policy-Report-Only');
		expect(csp).toBeDefined();
		
		// Verify all required directives are present
		const requiredDirectives = [
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
		];

		for (const directive of requiredDirectives) {
			expect(csp).toContain(directive);
		}
	});

	it('verifies additional security headers are present', async () => {
		const handle = await getHandle();
		
		const mockEvent = {
			cookies: {
				get: vi.fn().mockReturnValue(undefined),
			},
			url: new URL('https://status.haste.it/status'),
			platform: {
				env: {
					DB: db,
				},
			},
			locals: {},
		};

		const mockResolve = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
		
		const response = await handle({ event: mockEvent, resolve: mockResolve });
		
		// Verify all security headers
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
		expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
		expect(response.headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
		expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains; preload');
	});

	it('applies CSP Report-Only on cron endpoint', async () => {
		const handle = await getHandle();
		
		const mockEvent = {
			cookies: {
				get: vi.fn().mockReturnValue(undefined),
			},
			url: new URL('https://status.haste.it/api/cron'),
			platform: {
				env: {
					DB: db,
				},
			},
			locals: {},
		};

		const mockResolve = vi.fn().mockResolvedValue(new Response(JSON.stringify({ checked: 0 }), { 
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		}));
		
		const response = await handle({ event: mockEvent, resolve: mockResolve });
		
		expect(response.headers.get('Content-Security-Policy-Report-Only')).toBeDefined();
		expect(response.headers.get('Content-Security-Policy')).toBeNull();
	});

	it('applies CSP Report-Only on public status page', async () => {
		const handle = await getHandle();
		
		const mockEvent = {
			cookies: {
				get: vi.fn().mockReturnValue(undefined),
			},
			url: new URL('https://status.haste.it/status'),
			platform: {
				env: {
					DB: db,
				},
			},
			locals: {},
		};

		const mockResolve = vi.fn().mockResolvedValue(new Response('<html>Status Page</html>', { 
			status: 200,
			headers: { 'Content-Type': 'text/html' }
		}));
		
		const response = await handle({ event: mockEvent, resolve: mockResolve });
		
		expect(response.headers.get('Content-Security-Policy-Report-Only')).toBeDefined();
		expect(response.headers.get('Content-Security-Policy')).toBeNull();
	});

	it('applies CSP Report-Only header on authenticated dashboard', async () => {
		const handle = await getHandle();
		
		// Create a test user and session
		const { userId } = await createTestUser(db, 'dashboard@haste.it', 'password');
		const sessionId = await createSession(db, userId);
		
		const mockEvent = {
			cookies: {
				get: vi.fn().mockReturnValue(sessionId),
			},
			url: new URL('https://status.haste.it/'),
			platform: {
				env: {
					DB: db,
				},
			},
			locals: {},
		};

		const mockResolve = vi.fn().mockResolvedValue(new Response('Dashboard', { status: 200 }));
		
		const response = await handle({ event: mockEvent, resolve: mockResolve });
		
		expect(response.headers.get('Content-Security-Policy-Report-Only')).toBeDefined();
		expect(response.headers.get('Content-Security-Policy')).toBeNull();
	});
});