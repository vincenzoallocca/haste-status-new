import type { User, Session, CreateUserInput, UserPublic, UserRole } from '$lib/types/auth';

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function generateId(): string {
	return crypto.randomUUID();
}

const PBKDF2_ITERATIONS = 100000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

function bufferToHex(buffer: ArrayBuffer | Uint8Array): string {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

function hexToBuffer(hex: string): Uint8Array {
	if (hex.length % 2 !== 0) return new Uint8Array(0);
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a[i] ^ b[i];
	}
	return result === 0;
}

async function derivePbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
	const encoder = new TextEncoder();
	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		encoder.encode(password),
		{ name: 'PBKDF2' },
		false,
		['deriveBits']
	);
	const derivedBits = await crypto.subtle.deriveBits(
		{
			name: 'PBKDF2',
			salt: salt as unknown as BufferSource,
			iterations,
			hash: 'SHA-256'
		},
		keyMaterial,
		KEY_BYTES * 8
	);
	return new Uint8Array(derivedBits);
}

async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const hash = await derivePbkdf2(password, salt, PBKDF2_ITERATIONS);
	return `pbkdf2:${PBKDF2_ITERATIONS}:${bufferToHex(salt)}:${bufferToHex(hash)}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
	if (!storedHash) return false;

	if (storedHash.startsWith('pbkdf2:')) {
		const parts = storedHash.split(':');
		if (parts.length !== 4) return false;
		const iterations = parseInt(parts[1], 10);
		const salt = hexToBuffer(parts[2]);
		const expectedHash = hexToBuffer(parts[3]);

		const actualHash = await derivePbkdf2(password, salt, iterations);
		return timingSafeEqual(actualHash, expectedHash);
	}

	// Legacy fallback: plain SHA-256 with timing-safe comparison
	const encoder = new TextEncoder();
	const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(password));
	const actualHash = new Uint8Array(hashBuffer);
	const expectedHash = hexToBuffer(storedHash);
	return timingSafeEqual(actualHash, expectedHash);
}

export async function isAppSetup(db: D1Database): Promise<boolean> {
	const result = await db
		.prepare("SELECT value FROM app_settings WHERE key = 'setup_complete'")
		.first<{ value: string }>();
	return result?.value === 'true';
}

export async function markAppSetup(db: D1Database): Promise<void> {
	await db
		.prepare(
			"INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('setup_complete', 'true', datetime('now'))"
		)
		.run();
}

export async function getUserCount(db: D1Database): Promise<number> {
	const result = await db.prepare('SELECT COUNT(*) as count FROM users').first<{ count: number }>();
	return result?.count ?? 0;
}

export async function createUser(db: D1Database, input: CreateUserInput): Promise<UserPublic> {
	const id = generateId();
	const passwordHash = await hashPassword(input.password);
	const now = new Date().toISOString();
	const role = input.role ?? 'viewer';

	await db
		.prepare(
			`INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(id, input.name, input.email, passwordHash, role, now, now)
		.run();

	return {
		id,
		name: input.name,
		email: input.email,
		role,
		created_at: now,
		last_login_at: null
	};
}

export async function getUserByEmail(db: D1Database, email: string): Promise<User | null> {
	return db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<User>();
}

export async function getUserById(db: D1Database, id: string): Promise<User | null> {
	return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>();
}

export async function getAllUsers(db: D1Database): Promise<UserPublic[]> {
	const result = await db
		.prepare(
			'SELECT id, name, email, role, created_at, last_login_at FROM users ORDER BY created_at'
		)
		.all<UserPublic>();
	return result.results;
}

export async function updateUserRole(
	db: D1Database,
	userId: string,
	role: UserRole
): Promise<boolean> {
	const result = await db
		.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?")
		.bind(role, userId)
		.run();
	return result.meta.changes > 0;
}

export async function updateUserName(
	db: D1Database,
	userId: string,
	name: string
): Promise<boolean> {
	const result = await db
		.prepare("UPDATE users SET name = ?, updated_at = datetime('now') WHERE id = ?")
		.bind(name, userId)
		.run();
	return result.meta.changes > 0;
}

export async function updateUserPassword(
	db: D1Database,
	userId: string,
	newPassword: string
): Promise<boolean> {
	const passwordHash = await hashPassword(newPassword);
	const result = await db
		.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
		.bind(passwordHash, userId)
		.run();
	return result.meta.changes > 0;
}

export async function verifyUserPassword(
	db: D1Database,
	userId: string,
	password: string
): Promise<boolean> {
	const user = await getUserById(db, userId);
	if (!user) return false;
	return verifyPassword(password, user.password_hash);
}

export async function deleteUser(db: D1Database, userId: string): Promise<boolean> {
	const result = await db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
	return result.meta.changes > 0;
}

export async function validateCredentials(
	db: D1Database,
	email: string,
	password: string
): Promise<User | null> {
	const user = await getUserByEmail(db, email);
	if (!user) return null;

	const isValid = await verifyPassword(password, user.password_hash);
	if (!isValid) return null;

	// Migrate legacy SHA-256 hash to PBKDF2 on successful login
	// Use conditional update to prevent race condition: only migrate if stored hash still equals the legacy hash
	if (!user.password_hash.startsWith('pbkdf2:')) {
		try {
			const newHash = await hashPassword(password);
await db
				.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ? AND password_hash = ?")
				.bind(newHash, user.id, user.password_hash)
				.run();
			// If meta.changes === 0, another request already migrated the hash
		} catch {
			// Migration failure should not break login
			console.warn('[Auth] Failed to migrate legacy password hash for user:', user.id);
		}
	}

	// Update last login
	await db
		.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?")
		.bind(user.id)
		.run();

	return user;
}

export async function createSession(db: D1Database, userId: string): Promise<Session> {
	const id = generateId();
	const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
	const now = new Date().toISOString();

	await db
		.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
		.bind(id, userId, expiresAt, now)
		.run();

	return {
		id,
		user_id: userId,
		expires_at: expiresAt,
		created_at: now
	};
}

export async function getSession(db: D1Database, sessionId: string): Promise<Session | null> {
	const session = await db
		.prepare('SELECT * FROM sessions WHERE id = ?')
		.bind(sessionId)
		.first<Session>();

	if (!session) return null;

	// Check if expired
	if (new Date(session.expires_at) < new Date()) {
		await deleteSession(db, sessionId);
		return null;
	}

	return session;
}

export async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
	await db.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
}

export async function deleteUserSessions(db: D1Database, userId: string): Promise<void> {
	await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}

export async function cleanupExpiredSessions(db: D1Database): Promise<number> {
	const result = await db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
	return result.meta.changes;
}

export function userToPublic(user: User): UserPublic {
	return {
		id: user.id,
		name: user.name,
		email: user.email,
		role: user.role,
		created_at: user.created_at,
		last_login_at: user.last_login_at
	};
}
