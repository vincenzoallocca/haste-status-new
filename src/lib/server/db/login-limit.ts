/**
 * Limite ai tentativi di login falliti (audit 2026-11-18, SEC-S-03).
 *
 * Conta i fallimenti recenti per IP e per email nella tabella login_attempts
 * (migrazione 0004). Se la tabella non esiste ancora (migrazione non applicata)
 * il limite viene saltato con un warning: il login non deve mai bloccarsi per
 * questo motivo.
 */
import type { D1Database } from '@cloudflare/workers-types';

export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const MAX_FAILURES_PER_EMAIL = 10;
export const MAX_FAILURES_PER_IP = 30;

function keysFor(email: string, ip: string): { emailKey: string; ipKey: string } {
	return { emailKey: `email:${email.trim().toLowerCase()}`, ipKey: `ip:${ip || 'unknown'}` };
}

export async function isLoginRateLimited(db: D1Database, email: string, ip: string): Promise<boolean> {
	const { emailKey, ipKey } = keysFor(email, ip);
	const since = Math.floor(Date.now() / 1000) - LOGIN_WINDOW_SECONDS;
	try {
		const row = await db
			.prepare(
				`SELECT
					SUM(CASE WHEN attempt_key = ?1 THEN 1 ELSE 0 END) AS by_email,
					SUM(CASE WHEN attempt_key = ?2 THEN 1 ELSE 0 END) AS by_ip
				 FROM login_attempts
				 WHERE attempt_key IN (?1, ?2) AND attempted_at > ?3`
			)
			.bind(emailKey, ipKey, since)
			.first<{ by_email: number | null; by_ip: number | null }>();
		return (
			Number(row?.by_email ?? 0) >= MAX_FAILURES_PER_EMAIL ||
			Number(row?.by_ip ?? 0) >= MAX_FAILURES_PER_IP
		);
	} catch (err) {
		console.warn('[LoginLimit] limite non applicato (migrazione 0004 assente?):', err);
		return false;
	}
}

export async function recordLoginFailure(db: D1Database, email: string, ip: string): Promise<void> {
	const { emailKey, ipKey } = keysFor(email, ip);
	const now = Math.floor(Date.now() / 1000);
	try {
		await db.batch([
			db.prepare('INSERT INTO login_attempts (attempt_key, attempted_at) VALUES (?1, ?2), (?3, ?2)').bind(emailKey, now, ipKey),
			// Solo le righe di queste due chiavi ormai fuori finestra: tabella sempre piccola.
			db
				.prepare('DELETE FROM login_attempts WHERE attempt_key IN (?1, ?2) AND attempted_at <= ?3')
				.bind(emailKey, ipKey, now - LOGIN_WINDOW_SECONDS)
		]);
	} catch (err) {
		console.warn('[LoginLimit] tentativo non registrato:', err);
	}
}

export async function clearLoginFailures(db: D1Database, email: string): Promise<void> {
	const { emailKey } = keysFor(email, '');
	try {
		await db.prepare('DELETE FROM login_attempts WHERE attempt_key = ?1').bind(emailKey).run();
	} catch {
		/* tabella assente: niente da pulire */
	}
}
