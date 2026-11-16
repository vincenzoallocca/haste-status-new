import { describe, expect, it, vi } from 'vitest';
import { load } from '../src/routes/status/[slug]/+page.server';

describe('Group Status Page Resilience (/status/[slug])', () => {
  it('returns graceful dbUnavailable: true when D1 database is not available without throwing HTTP 500', async () => {
    const event: any = {
      params: { slug: 'haste-core' },
      platform: {
        env: {} // No DB binding
      }
    };

    const result = await load(event);
    expect(result).toBeDefined();
    expect(result.dbUnavailable).toBe(true);
    expect(result.group).toBeNull();
    expect(result.activeIncidents).toEqual([]);
    expect(result.pastIncidents).toEqual([]);
  });

  it('returns graceful dbUnavailable: true when D1 throws Code 7500 quota exceeded error', async () => {
    const fakeDb: any = {
      prepare: vi.fn().mockImplementation(() => {
        throw new Error("Your account has exceeded D1's free tier daily row read limit [code: 7500]");
      })
    };

    const event: any = {
      params: { slug: 'haste-core' },
      platform: {
        env: {
          DB: fakeDb
        }
      }
    };

    const result = await load(event);
    expect(result).toBeDefined();
    expect(result.dbUnavailable).toBe(true);
    expect(result.group).toBeNull();
  });

  it('preserves 404 error when group is legitimately not found in operational database', async () => {
    const fakeDb: any = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null) // Group not found
        })
      })
    };

    const event: any = {
      params: { slug: 'non-existent-group' },
      platform: {
        env: {
          DB: fakeDb
        }
      }
    };

    await expect(load(event)).rejects.toMatchObject({
      status: 404,
      body: { message: 'Group not found' }
    });
  });
});
