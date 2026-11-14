import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeD1, rawDb } from '../helpers/fake-d1';
import {
	validateCredentials,
	getUserById,
} from '$lib/server/db/auth';
import type { D1Database } from '@cloudflare/workers-types';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '..', '..', 'migrations');

describe('validateCredentials - PBKDF2 migration', () => {
	let db: D1Database;

	beforeEach(async () => {
		db = await createFakeD1(MIGRATIONS);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('migrates legacy SHA-256 hash to PBKDF2 on successful login', async () => {
		// Create user with legacy SHA-256 hash (simulating old format)
		const userId = crypto.randomUUID();
		const password = 'testpassword123';
		const encoder = new TextEncoder();
		const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(password));
		const legacyHash = Array.from(new Uint8Array(hashBuffer))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');

		await rawDb(db).exec(`
			INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at)
			VALUES ('${userId}', 'Test User', 'legacy@test.com', '${legacyHash}', 'admin', datetime('now'), datetime('now'))
		`);

		// Verify the hash is legacy format
		const userBefore = await getUserById(db, userId);
		expect(userBefore?.password_hash.startsWith('pbkdf2:')).toBe(false);
		expect(userBefore?.password_hash.length).toBe(64); // SHA-256 hex

		// Login with correct password - should migrate
		const user = await validateCredentials(db, 'legacy@test.com', password);
		expect(user).not.toBeNull();
		expect(user?.email).toBe('legacy@test.com');

		// Verify hash was migrated to PBKDF2
		const userAfter = await getUserById(db, userId);
		expect(userAfter?.password_hash.startsWith('pbkdf2:')).toBe(true);
		expect(userAfter?.password_hash).toContain(':'); // pbkdf2:iterations:salt:hash

		// Verify the new PBKDF2 hash works for subsequent login
		const userSecondLogin = await validateCredentials(db, 'legacy@test.com', password);
		expect(userSecondLogin).not.toBeNull();
		expect(userSecondLogin?.email).toBe('legacy@test.com');
	});

	it('does NOT migrate hash on incorrect password', async () => {
		const userId = crypto.randomUUID();
		const password = 'correctpassword';
		const wrongPassword = 'wrongpassword';
		const encoder = new TextEncoder();
		const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(password));
		const legacyHash = Array.from(new Uint8Array(hashBuffer))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');

		await rawDb(db).exec(`
			INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at)
			VALUES ('${userId}', 'Test User', 'nomigrate@test.com', '${legacyHash}', 'admin', datetime('now'), datetime('now'))
		`);

		// Attempt login with wrong password
		const user = await validateCredentials(db, 'nomigrate@test.com', wrongPassword);
		expect(user).toBeNull();

		// Verify hash was NOT migrated (still legacy SHA-256)
		const userAfter = await getUserById(db, userId);
		expect(userAfter?.password_hash.startsWith('pbkdf2:')).toBe(false);
		expect(userAfter?.password_hash).toBe(legacyHash);
	});

	it('existing PBKDF2 login remains functional', async () => {
		// Create user with PBKDF2 hash (create manually since hashPassword is not exported)
		const encoder = new TextEncoder();
		const salt = crypto.getRandomValues(new Uint8Array(16));
		const keyMaterial = await crypto.subtle.importKey(
			'raw',
			encoder.encode('pbkdf2password'),
			{ name: 'PBKDF2' },
			false,
			['deriveBits']
		);
		const derivedBits = await crypto.subtle.deriveBits(
			{ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
			keyMaterial,
			256
		);
		const hash = Array.from(new Uint8Array(derivedBits))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		const saltHex = Array.from(salt)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		const pbkdf2Hash = `pbkdf2:100000:${saltHex}:${hash}`;
		const userId = crypto.randomUUID();

		await rawDb(db).exec(`
			INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at)
			VALUES ('${userId}', 'PBKDF2 User', 'pbkdf2@test.com', '${pbkdf2Hash}', 'admin', datetime('now'), datetime('now'))
		`);

		// Login with correct password
		const user = await validateCredentials(db, 'pbkdf2@test.com', 'pbkdf2password');
		expect(user).not.toBeNull();
		expect(user?.email).toBe('pbkdf2@test.com');

		// Hash should remain PBKDF2 (re-hashed with new salt)
		const userAfter = await getUserById(db, userId);
		expect(userAfter?.password_hash.startsWith('pbkdf2:')).toBe(true);
		// Note: hash will be different due to new salt, but still PBKDF2 format
	});

	it('malformed legacy hash is rejected', async () => {
		const userId = crypto.randomUUID();
		const malformedHash = 'not-a-valid-hex-string!';

		await rawDb(db).exec(`
			INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at)
			VALUES ('${userId}', 'Test User', 'malformed@test.com', '${malformedHash}', 'admin', datetime('now'), datetime('now'))
		`);

		const user = await validateCredentials(db, 'malformed@test.com', 'anypassword');
		expect(user).toBeNull();
	});

	it('malformed PBKDF2 hash is rejected', async () => {
		const userId = crypto.randomUUID();
		const malformedPbkdf2 = 'pbkdf2:invalid';

		await rawDb(db).exec(`
			INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at)
			VALUES ('${userId}', 'Test User', 'malformedpbkdf2@test.com', '${malformedPbkdf2}', 'admin', datetime('now'), datetime('now'))
		`);

		const user = await validateCredentials(db, 'malformedpbkdf2@test.com', 'anypassword');
		expect(user).toBeNull();
	});

	it('handles database update failure during migration gracefully', async () => {
		const userId = crypto.randomUUID();
		const password = 'testpassword123';
		const encoder = new TextEncoder();
		const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(password));
		const legacyHash = Array.from(new Uint8Array(hashBuffer))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');

		await rawDb(db).exec(`
			INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at)
			VALUES ('${userId}', 'Test User', 'dbfail@test.com', '${legacyHash}', 'admin', datetime('now'), datetime('now'))
		`);

		// Mock db.prepare to throw on UPDATE (migration) but not on SELECT
		const originalPrepare = db.prepare.bind(db);
		db.prepare = vi.fn((sql: string, ...bindings: unknown[]) => {
			if (sql.includes('UPDATE users SET password_hash')) {
				throw new Error('Database update failed');
			}
			return originalPrepare(sql, ...bindings);
		});

		// Login should still succeed despite migration failure
		const user = await validateCredentials(db, 'dbfail@test.com', password);
		expect(user).not.toBeNull();
		expect(user?.email).toBe('dbfail@test.com');

		// Hash remains legacy (migration failed silently)
		const userAfter = await getUserById(db, userId);
		expect(userAfter?.password_hash).toBe(legacyHash);
	});

	it('subsequent login after migration uses PBKDF2', async () => {
		const userId = crypto.randomUUID();
		const password = 'testpassword123';
		const encoder = new TextEncoder();
		const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(password));
		const legacyHash = Array.from(new Uint8Array(hashBuffer))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');

		await rawDb(db).exec(`
			INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at)
			VALUES ('${userId}', 'Test User', 'subsequent@test.com', '${legacyHash}', 'admin', datetime('now'), datetime('now'))
		`);

		// First login - migrates
		const user1 = await validateCredentials(db, 'subsequent@test.com', password);
		expect(user1).not.toBeNull();

		const userAfterFirst = await getUserById(db, userId);
		const pbkdf2HashAfterFirst = userAfterFirst?.password_hash;
		expect(pbkdf2HashAfterFirst?.startsWith('pbkdf2:')).toBe(true);

		// Second login - uses PBKDF2 (hash should remain the same since we don't re-hash on every PBKDF2 login)
		const user2 = await validateCredentials(db, 'subsequent@test.com', password);
		expect(user2).not.toBeNull();

		// Hash should still be PBKDF2 and unchanged (no re-hash on subsequent PBKDF2 logins)
		const userAfterSecond = await getUserById(db, userId);
		expect(userAfterSecond?.password_hash.startsWith('pbkdf2:')).toBe(true);
		expect(userAfterSecond?.password_hash).toBe(pbkdf2HashAfterFirst);
	});

	it('handles concurrent legacy logins without overwriting migrated hash', async () => {
		const userId = crypto.randomUUID();
		const password = 'concurrentpassword';
		const encoder = new TextEncoder();
		const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(password));
		const legacyHash = Array.from(new Uint8Array(hashBuffer))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');

		await rawDb(db).exec(`
			INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at)
			VALUES ('${userId}', 'Test User', 'concurrent@test.com', '${legacyHash}', 'admin', datetime('now'), datetime('now'))
		`);

		// Simulate two concurrent login attempts by calling validateCredentials twice
		// The first should migrate, the second should see the already-migrated hash
		const [user1, user2] = await Promise.all([
			validateCredentials(db, 'concurrent@test.com', password),
			validateCredentials(db, 'concurrent@test.com', password),
		]);

		// Both logins should succeed
		expect(user1).not.toBeNull();
		expect(user2).not.toBeNull();

		// Hash should be PBKDF2 (only one migration should have occurred)
		const userAfter = await getUserById(db, userId);
		expect(userAfter?.password_hash.startsWith('pbkdf2:')).toBe(true);

		// Verify the migrated hash works for subsequent logins
		const user3 = await validateCredentials(db, 'concurrent@test.com', password);
		expect(user3).not.toBeNull();
	});
});