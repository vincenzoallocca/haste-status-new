// Regressione audit 2026-11-18 (SEC-S-01, SEC-S-02):
// gli incidenti dei gruppi privati non devono comparire sugli endpoint pubblici
// e la finestra ?days= dell'API pubblica deve essere limitata.
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import type { D1Database } from '@cloudflare/workers-types';
import { createFakeD1, rawDb } from './helpers/fake-d1';
import {
	getActiveIncidents,
	getRecentIncidentsByDate,
	clampIncidentDays,
	MAX_INCIDENT_DAYS
} from '../src/lib/server/db/status';
import { GET } from '../src/routes/api/public/incidents/+server';

const MIGRATIONS = join(__dirname, '..', 'migrations');

function seed(db: D1Database) {
	rawDb(db).exec(`
		INSERT INTO monitor_groups (id, name, slug, is_public) VALUES
			('g-pub', 'Pubblico', 'pub', 1),
			('g-priv', 'Gruppo Segreto', 'priv', 0);
		INSERT INTO incidents (id, title, status, group_id, created_at) VALUES
			('i-global', 'Incidente globale', 'investigating', NULL, datetime('now')),
			('i-pub', 'Incidente pubblico', 'investigating', 'g-pub', datetime('now')),
			('i-priv', 'Incidente riservato', 'investigating', 'g-priv', datetime('now'));
	`);
}

async function callApi(db: D1Database, query: string) {
	const url = new URL(`https://status.haste.it/api/public/incidents${query}`);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const res = await GET({ url, platform: { env: { DB: db } } } as any);
	return { status: res.status, text: await res.text() };
}

describe('audit SEC-S-01: incidenti di gruppi privati non pubblici', () => {
	let db: D1Database;
	beforeEach(() => {
		db = createFakeD1(MIGRATIONS);
		seed(db);
	});

	it('getActiveIncidents senza opzioni (admin) restituisce tutti gli incidenti', async () => {
		const ids = (await getActiveIncidents(db)).map((i) => i.id).sort();
		expect(ids).toEqual(['i-global', 'i-priv', 'i-pub']);
	});

	it('getActiveIncidents publicOnly esclude i gruppi privati', async () => {
		const ids = (await getActiveIncidents(db, { publicOnly: true })).map((i) => i.id).sort();
		expect(ids).toEqual(['i-global', 'i-pub']);
	});

	it('getRecentIncidentsByDate publicOnly esclude i gruppi privati', async () => {
		const byDate = await getRecentIncidentsByDate(db, 7, { publicOnly: true });
		const ids = byDate.flatMap((d) => d.incidents.map((i) => i.id)).sort();
		expect(ids).toEqual(['i-global', 'i-pub']);
	});

	it('API pubblica: né ?active=true né la vista per data espongono il gruppo privato', async () => {
		for (const q of ['?active=true', '', '?days=30']) {
			const { status, text } = await callApi(db, q);
			expect(status).toBe(200);
			expect(text).not.toContain('Incidente riservato');
			expect(text).not.toContain('Gruppo Segreto');
			expect(text).toContain('Incidente pubblico');
		}
	});
});

describe('audit SEC-S-02: ?days limitato', () => {
	it('clampIncidentDays limita e normalizza', () => {
		expect(clampIncidentDays('200000')).toBe(MAX_INCIDENT_DAYS);
		expect(clampIncidentDays('abc')).toBe(7);
		expect(clampIncidentDays('0')).toBe(1);
		expect(clampIncidentDays('-5')).toBe(1);
		expect(clampIncidentDays(30)).toBe(30);
	});

	it('API pubblica con days enorme o non numerico risponde 200 con al più 90 giorni', async () => {
		const db = createFakeD1(MIGRATIONS);
		const big = await callApi(db, '?days=200000');
		expect(big.status).toBe(200);
		expect(JSON.parse(big.text).length).toBeLessThanOrEqual(MAX_INCIDENT_DAYS);
		const nan = await callApi(db, '?days=abc');
		expect(nan.status).toBe(200);
		expect(JSON.parse(nan.text).length).toBe(7);
	});
});
