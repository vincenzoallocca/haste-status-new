// Regressione audit 2026-11-18: SEC-S-03 (rate limit login), SEC-S-04 (Origin
// sulle richieste che modificano dati), SEC-S-05 (cambio password chiude le
// altre sessioni), SEC-S-07 (chiave di cache senza query string).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { join } from 'node:path';
import type { D1Database } from '@cloudflare/workers-types';
import { createFakeD1, rawDb } from './helpers/fake-d1';
import { POST as login } from '../src/routes/api/auth/login/+server';
import { PUT as changePassword } from '../src/routes/api/auth/password/+server';
import { GET as publicStatus } from '../src/routes/api/public/status/+server';
import { handle } from '../src/hooks.server';
import { MAX_FAILURES_PER_EMAIL } from '../src/lib/server/db/login-limit';

const MIGRATIONS = join(__dirname, '..', 'migrations');

async function pbkdf2Hash(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, [
		'deriveBits'
	]);
	const bits = new Uint8Array(
		await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256)
	);
	const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
	return `pbkdf2:100000:${hex(salt)}:${hex(bits)}`;
}

async function seedUser(db: D1Database, email: string, password: string): Promise<string> {
	const id = crypto.randomUUID();
	const hash = await pbkdf2Hash(password);
	rawDb(db).exec(`
		INSERT INTO users (id, name, email, email_normalized, password_hash, role, created_at, updated_at)
		VALUES ('${id}', 'Admin', '${email}', '${email.toLowerCase()}', '${hash}', 'admin', datetime('now'), datetime('now'));
		INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('setup_complete', 'true', datetime('now'));
	`);
	return id;
}

function loginEvent(db: D1Database, email: string, password: string, ip = '198.51.100.7') {
	return {
		request: new Request('https://status.haste.it/api/auth/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
			body: JSON.stringify({ email, password })
		}),
		cookies: { set: vi.fn() },
		platform: { env: { DB: db } },
		getClientAddress: () => ip
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any;
}

describe('SEC-S-03: rate limit del login', () => {
	let db: D1Database;
	beforeEach(async () => {
		db = createFakeD1(MIGRATIONS);
		await seedUser(db, 'admin@haste.it', 'Corretta123!');
	});

	it('dopo troppi errori risponde 429 anche con la password giusta, poi si sblocca dopo la finestra', async () => {
		for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) {
			const res = await login(loginEvent(db, 'admin@haste.it', `sbagliata-${i}`, `203.0.113.${i}`));
			expect(res.status).toBe(401);
		}
		const blocked = await login(loginEvent(db, 'admin@haste.it', 'Corretta123!', '192.0.2.1'));
		expect(blocked.status).toBe(429);

		// Simula il passare della finestra di 15 minuti.
		rawDb(db).exec('UPDATE login_attempts SET attempted_at = attempted_at - 3600');
		const ok = await login(loginEvent(db, 'admin@haste.it', 'Corretta123!', '192.0.2.1'));
		expect(ok.status).toBe(200);
	});

	it('senza la tabella (migrazione 0004 non applicata) il login funziona comunque', async () => {
		rawDb(db).exec('DROP TABLE login_attempts');
		const res = await login(loginEvent(db, 'admin@haste.it', 'Corretta123!'));
		expect(res.status).toBe(200);
	});
});

describe('SEC-S-05: il cambio password chiude le altre sessioni', () => {
	it('mantiene solo la sessione corrente', async () => {
		const db = createFakeD1(MIGRATIONS);
		const userId = await seedUser(db, 'pw@haste.it', 'Vecchia123!');
		rawDb(db).exec(`
			INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES
				('corrente', '${userId}', datetime('now', '+1 day'), datetime('now')),
				('altro-pc', '${userId}', datetime('now', '+1 day'), datetime('now'));
		`);
		const res = await changePassword({
			request: new Request('https://status.haste.it/api/auth/password', {
				method: 'PUT',
				body: JSON.stringify({ currentPassword: 'Vecchia123!', newPassword: 'NuovaPassword456!' })
			}),
			locals: { user: { id: userId }, sessionId: 'corrente' },
			platform: { env: { DB: db } }
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any);
		expect(res.status).toBe(200);
		const ids = (rawDb(db).prepare('SELECT id FROM sessions ORDER BY id').all() as { id: string }[]).map((r) => r.id);
		expect(ids).toEqual(['corrente']);
	});
});

describe('SEC-S-04: Origin sulle richieste che modificano dati', () => {
	function event(method: string, origin: string | null, path = '/api/incidents') {
		const headers: Record<string, string> = {};
		if (origin) headers.Origin = origin;
		return {
			request: new Request(`https://status.haste.it${path}`, { method, headers }),
			url: new URL(`https://status.haste.it${path}`),
			cookies: { get: vi.fn().mockReturnValue(undefined) },
			platform: { env: {} },
			locals: {}
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any;
	}
	const resolve = vi.fn(async () => new Response('ok'));

	it('blocca POST da un altro sottodominio', async () => {
		const res = await handle({ event: event('POST', 'https://usage.haste.it'), resolve });
		expect(res.status).toBe(403);
	});

	it('ammette POST dallo stesso origin, senza Origin (server-to-server) e i GET', async () => {
		expect((await handle({ event: event('POST', 'https://status.haste.it'), resolve })).status).toBe(200);
		expect((await handle({ event: event('POST', null), resolve })).status).toBe(200);
		expect((await handle({ event: event('GET', 'https://evil.example'), resolve })).status).toBe(200);
	});
});

describe('SEC-S-07: cache di /api/public/status senza query string', () => {
	it('usa la stessa chiave per URL che differiscono solo per i parametri', async () => {
		const keys: string[] = [];
		const store = new Map<string, Response>();
		vi.stubGlobal('caches', {
			default: {
				match: async (k: string) => {
					keys.push(k);
					return store.get(k)?.clone();
				},
				put: async (k: string, r: Response) => {
					store.set(k, r);
				}
			}
		});
		const db = createFakeD1(MIGRATIONS);
		for (const q of ['?a=1', '?b=2']) {
			await publicStatus({
				request: new Request(`https://status.haste.it/api/public/status${q}`),
				platform: { env: { DB: db } }
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any);
		}
		vi.unstubAllGlobals();
		expect(new Set(keys)).toEqual(new Set(['https://status.haste.it/api/public/status']));
		expect(store.size).toBe(1);
	});
});
