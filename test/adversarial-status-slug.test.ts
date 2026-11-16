import { describe, expect, it, vi } from 'vitest';
import { load } from '../src/routes/status/[slug]/+page.server';

describe('Adversarial Regression: BUG-05 Status per slug query logic & fixtures', () => {
  const mockGroup = {
    id: 'grp-core',
    name: 'Core Services',
    slug: 'core',
    description: 'Core infrastructure',
    is_public: 1,
    monitors: [],
    overall_status: 'operational',
    uptime_90d: 99.9
  };

  it('fixture: zero incidents returns 7 days of empty incidents', async () => {
    let prepareCallCount = 0;
    const fakeDb: any = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        prepareCallCount++;
        return {
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockImplementation(async () => {
              if (sql.includes('monitor_groups')) return mockGroup;
              return null;
            }),
            all: vi.fn().mockImplementation(async () => {
              if (sql.includes('monitors m')) return { results: [] };
              if (sql.includes('SELECT i.*')) return { results: [] };
              if (sql.includes('incident_updates')) return { results: [] };
              return { results: [] };
            })
          })
        };
      })
    };

    const event: any = {
      params: { slug: 'core' },
      platform: { env: { DB: fakeDb } }
    };

    const result = await load(event);
    expect(result.dbUnavailable).toBe(false);
    expect(result.group).toBeDefined();
    expect(result.activeIncidents).toEqual([]);
    expect(result.pastIncidents).toHaveLength(7);
    for (const day of result.pastIncidents) {
      expect(day.incidents).toEqual([]);
    }
    // Query count verification: NO N+1 queries!
    expect(prepareCallCount).toBeLessThanOrEqual(5);
  });

  it('fixture: handles SQLite space-separated timestamps (datetime("now")) and ISO "T" timestamps', async () => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const incidentIso = {
      id: 'inc-1',
      title: 'ISO Incident',
      status: 'resolved',
      group_id: 'grp-core',
      created_at: `${todayStr}T14:30:00.000Z`,
      resolved_at: `${todayStr}T15:00:00.000Z`,
      group_name: 'Core Services'
    };
    const incidentSpace = {
      id: 'inc-2',
      title: 'SQLite Space Incident',
      status: 'resolved',
      group_id: 'grp-core',
      created_at: `${todayStr} 15:45:00`, // Space instead of T!
      resolved_at: `${todayStr} 16:00:00`,
      group_name: 'Core Services'
    };

    const update1 = {
      id: 'upd-1',
      incident_id: 'inc-1',
      status: 'resolved',
      message: 'Fixed',
      created_at: `${todayStr}T15:00:00.000Z`
    };

    const fakeDb: any = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('monitor_groups')) return mockGroup;
            return null;
          }),
          all: vi.fn().mockImplementation(async () => {
            if (sql.includes('monitors m')) return { results: [] };
            if (sql.includes('status != \'resolved\'')) return { results: [] };
            if (sql.includes('SELECT i.*')) return { results: [incidentIso, incidentSpace] };
            if (sql.includes('incident_updates')) return { results: [update1] };
            return { results: [] };
          })
        })
      }))
    };

    const event: any = {
      params: { slug: 'core' },
      platform: { env: { DB: fakeDb } }
    };

    const result = await load(event);
    const todayEntry = result.pastIncidents.find((p: any) => p.date === todayStr);
    expect(todayEntry).toBeDefined();
    // Both incidents must be found in today's entry!
    expect(todayEntry.incidents).toHaveLength(2);
    expect(todayEntry.incidents[0].id).toBe('inc-1');
    expect(todayEntry.incidents[0].updates).toHaveLength(1);
    expect(todayEntry.incidents[1].id).toBe('inc-2');
  });

  it('fixture: handles multiple updates on an incident correctly', async () => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const activeIncident = {
      id: 'inc-active',
      title: 'Active Issue',
      status: 'investigating',
      group_id: 'grp-core',
      created_at: `${todayStr}T10:00:00.000Z`,
      group_name: 'Core Services'
    };
    const update1 = { id: 'u-1', incident_id: 'inc-active', status: 'investigating', message: 'Looking into it', created_at: `${todayStr}T10:05:00.000Z` };
    const update2 = { id: 'u-2', incident_id: 'inc-active', status: 'identified', message: 'Identified root cause', created_at: `${todayStr}T10:15:00.000Z` };

    const fakeDb: any = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('monitor_groups')) return mockGroup;
            return null;
          }),
          all: vi.fn().mockImplementation(async () => {
            if (sql.includes('monitors m')) return { results: [] };
            if (sql.includes('status != \'resolved\'')) return { results: [activeIncident] };
            if (sql.includes('SELECT i.*')) return { results: [] };
            if (sql.includes('incident_updates')) return { results: [update1, update2] };
            return { results: [] };
          })
        })
      }))
    };

    const event: any = {
      params: { slug: 'core' },
      platform: { env: { DB: fakeDb } }
    };

    const result = await load(event);
    expect(result.activeIncidents).toHaveLength(1);
    expect(result.activeIncidents[0].updates).toHaveLength(2);
    expect(result.activeIncidents[0].updates[0].message).toBe('Looking into it');
    expect(result.activeIncidents[0].updates[1].message).toBe('Identified root cause');
  });
});
