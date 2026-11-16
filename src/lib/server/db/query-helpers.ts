import type { D1Database } from '@cloudflare/workers-types';

const CHUNK_SIZE = 500;

export async function chunkedInQuery<T>(
	db: D1Database,
	baseQuery: string,
	ids: string[],
	extraBindings: unknown[] = []
): Promise<T[]> {
	if (ids.length === 0) {
		return [];
	}

	const results: T[] = [];

	for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
		const chunk = ids.slice(i, i + CHUNK_SIZE);
		const placeholders = chunk.map(() => '?').join(',');
		const query = baseQuery.replace('IN (?)', `IN (${placeholders})`);
		const chunkResults = await db.prepare(query).bind(...chunk, ...extraBindings).all();
		results.push(...(chunkResults.results as T[]));
	}

	return results;
}

export function buildInClause(ids: string[]): string {
	return ids.map(() => '?').join(',');
}

export { CHUNK_SIZE };