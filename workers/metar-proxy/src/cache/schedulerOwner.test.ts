import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OwnedSchedulerCoordinator,
  abortOwnedSchedulerRun,
  beginOwnedSchedulerRun,
  completeOwnedSchedulerRun,
  recordOwnedSchedulerDemand,
  renewOwnedSchedulerRun
} from './schedulerOwner';
import type { DurableObjectNamespaceLike } from './types';

class Storage {
  private readonly records = new Map<string, unknown>();
  alarmAt: number | null = null;
  async get<T>(key: string): Promise<T | undefined> { return this.records.get(key) as T | undefined; }
  async put(key: string, value: unknown): Promise<void> { this.records.set(key, value); }
  async setAlarm(value: number | Date): Promise<void> { this.alarmAt = Number(value); }
  async getAlarm(): Promise<number | null> { return this.alarmAt; }
}

class SqlStorage extends Storage {
  private readonly handler: (query: string, ...bindings: unknown[]) => Array<Record<string, unknown>>;
  readonly execMock = vi.fn((query: string, ...bindings: unknown[]): Array<Record<string, unknown>> => this.handler(query, ...bindings));
  readonly sql = { exec: <T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Iterable<T> => this.execMock(query, ...bindings) as T[] };

  constructor(handler: (query: string, ...bindings: unknown[]) => Array<Record<string, unknown>> = () => []) {
    super();
    this.handler = handler;
  }

  transactionSync<T>(closure: () => T): T { return closure(); }
}

class Namespace implements DurableObjectNamespaceLike {
  private readonly coordinator = new OwnedSchedulerCoordinator({ storage: new Storage() });
  idFromName(name: string): string { return name; }
  get() { return { fetch: (input: RequestInfo | URL, init?: RequestInit) => this.coordinator.fetch(input instanceof Request ? input : new Request(input.toString(), init), new URL(input.toString()).pathname) }; }
}

async function coordinatorRequest(
  coordinator: OwnedSchedulerCoordinator,
  path: string,
  body: unknown
): Promise<Response> {
  return coordinator.fetch(
    new Request(`https://cache-coordinator.internal${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),
    path
  );
}

describe('owned scheduler demand lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps client touches neutral and suppresses after three real upstream failures', async () => {
    const namespace = new Namespace();
    await expect(recordOwnedSchedulerDemand(namespace, 'metar', 'KORD', 3600)).resolves.toBe(true);
    for (let count = 1; count <= 3; count += 1) {
      const run = await beginOwnedSchedulerRun(namespace, 30, 2);
      expect(run?.candidates).toHaveLength(1);
      if (count === 2) await recordOwnedSchedulerDemand(namespace, 'metar', 'KORD', 3600);
      const candidate = run?.candidates[0];
      if (!candidate) throw new Error('Expected claimed candidate.');
      await expect(completeOwnedSchedulerRun(namespace, run?.runId ?? '', [{ ...candidate, outcome: 'upstream_failed' }])).resolves.toEqual(count === 3 ? ['metar:KORD'] : []);
    }
    await expect(beginOwnedSchedulerRun(namespace, 30, 2)).resolves.toMatchObject({ candidates: [] });
  });

  it('reactivates a suppressed entry only after a successful refresh and applies each outcome once', async () => {
    const namespace = new Namespace();
    await recordOwnedSchedulerDemand(namespace, 'airport', 'KJFK', 3600);
    for (let count = 0; count < 3; count += 1) {
      const run = await beginOwnedSchedulerRun(namespace, 30, 2);
      const candidate = run?.candidates[0];
      if (!candidate) throw new Error('Expected claimed candidate.');
      await completeOwnedSchedulerRun(namespace, run?.runId ?? '', [{ ...candidate, outcome: 'upstream_failed' }]);
    }
    await recordOwnedSchedulerDemand(namespace, 'airport', 'KJFK', 3600, true);
    const suppressed = await beginOwnedSchedulerRun(namespace, 30, 2);
    expect(suppressed?.candidates).toMatchObject([{ resource: 'airport', normalizedKey: 'KJFK' }]);
    await abortOwnedSchedulerRun(namespace, suppressed?.runId ?? '');
  });

  it('makes a run token-bound and abortable', async () => {
    const namespace = new Namespace();
    await recordOwnedSchedulerDemand(namespace, 'metar', 'KDEN', 3600);
    const run = await beginOwnedSchedulerRun(namespace, 1, 2);
    await expect(renewOwnedSchedulerRun(namespace, run?.runId ?? '', 30)).resolves.toBe(true);
    await abortOwnedSchedulerRun(namespace, run?.runId ?? '');
    await expect(renewOwnedSchedulerRun(namespace, run?.runId ?? '', 30)).resolves.toBe(false);
  });

  it('rejects malformed coordinator requests at its trust boundary', async () => {
    const coordinator = new OwnedSchedulerCoordinator({ storage: new Storage() });

    await expect(coordinatorRequest(coordinator, '/scheduler/v2/touch', { resource: 'metar', normalizedKey: '', inactivityTtlSeconds: 1 }))
      .resolves.toMatchObject({ status: 400 });
    await expect(coordinatorRequest(coordinator, '/scheduler/v2/begin', { holdSeconds: 0, maxCandidates: 2 }))
      .resolves.toMatchObject({ status: 400 });
    await expect(coordinatorRequest(coordinator, '/scheduler/v2/renew', { runId: '', holdSeconds: 1 }))
      .resolves.toMatchObject({ status: 400 });
    await expect(coordinatorRequest(coordinator, '/scheduler/v2/unknown', { runId: 'run' }))
      .resolves.toMatchObject({ status: 404 });
  });

  it('uses Durable Object storage transactions for the SQLite demand path', async () => {
    const storage = new SqlStorage();
    const transactionSpy = vi.spyOn(storage, 'transactionSync');
    const coordinator = new OwnedSchedulerCoordinator({ storage });

    await expect(coordinatorRequest(coordinator, '/scheduler/v2/touch', {
      resource: 'metar', normalizedKey: 'KORD', inactivityTtlSeconds: 60
    })).resolves.toMatchObject({ status: 200 });

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(storage.execMock).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO scheduler_demands'), 'metar', 'KORD', expect.any(String), expect.any(Number), 0, 0);
  });

  it('does not duplicate a touched candidate when SQL selection wraps its progress cursor', async () => {
    const inserted = new Set<string>();
    const storage = new SqlStorage((query, ...bindings) => {
      if (query.includes('FROM scheduler_progress')) {
        return [{ last_accessed_at: '2026-03-06T12:00:00.000Z', normalized_key: 'KJFK' }];
      }
      if (query.includes('FROM scheduler_demands AS demands')) {
        if (bindings[0] !== 'metar') return [];
        expect(query).toContain('ORDER BY CASE WHEN');
        return [
          { resource: 'metar', normalized_key: 'KORD', last_accessed_at: '2026-03-06T12:00:01.000Z', demand_version: 2 },
          { resource: 'metar', normalized_key: 'KJFK', last_accessed_at: '2026-03-06T12:00:00.000Z', demand_version: 1 }
        ];
      }
      if (query.includes('INSERT INTO scheduler_run_items')) {
        const key = `${bindings[1]}:${bindings[2]}`;
        if (inserted.has(key)) throw new Error('UNIQUE constraint failed: scheduler_run_items');
        inserted.add(key);
      }
      return [];
    });
    const coordinator = new OwnedSchedulerCoordinator({ storage });

    const response = await coordinatorRequest(coordinator, '/scheduler/v2/begin', { holdSeconds: 30, maxCandidates: 4 });

    await expect(response.json()).resolves.toMatchObject({
      acquired: true,
      candidates: [
        { resource: 'metar', normalizedKey: 'KORD' },
        { resource: 'metar', normalizedKey: 'KJFK' }
      ]
    });
    expect(inserted).toEqual(new Set(['metar:KORD', 'metar:KJFK']));
  });

  it('does not let a failed run outcome overwrite a later successful client touch', async () => {
    const namespace = new Namespace();
    await recordOwnedSchedulerDemand(namespace, 'metar', 'KORD', 3600);
    for (let count = 0; count < 2; count += 1) {
      const run = await beginOwnedSchedulerRun(namespace, 30, 2);
      const candidate = run?.candidates[0];
      if (!run || !candidate) throw new Error('Expected a claimed candidate.');
      await completeOwnedSchedulerRun(namespace, run.runId, [{ ...candidate, outcome: 'upstream_failed' }]);
    }

    const staleRun = await beginOwnedSchedulerRun(namespace, 30, 2);
    const staleCandidate = staleRun?.candidates[0];
    if (!staleRun || !staleCandidate) throw new Error('Expected a claimed candidate.');
    await recordOwnedSchedulerDemand(namespace, 'metar', 'KORD', 3600, true);
    await expect(completeOwnedSchedulerRun(namespace, staleRun.runId, [{ ...staleCandidate, outcome: 'upstream_failed' }]))
      .resolves.toEqual([]);

    for (let count = 0; count < 2; count += 1) {
      const run = await beginOwnedSchedulerRun(namespace, 30, 2);
      const candidate = run?.candidates[0];
      if (!run || !candidate) throw new Error('Expected a claimed candidate.');
      await expect(completeOwnedSchedulerRun(namespace, run.runId, [{ ...candidate, outcome: 'upstream_failed' }]))
        .resolves.toEqual([]);
    }
  });

  it('returns inactive-run responses without mutating demand state', async () => {
    const coordinator = new OwnedSchedulerCoordinator({ storage: new Storage() });

    await expect(coordinatorRequest(coordinator, '/scheduler/v2/renew', { runId: 'missing', holdSeconds: 1 }))
      .resolves.toMatchObject({ status: 409 });
    await expect(coordinatorRequest(coordinator, '/scheduler/v2/complete', { runId: 'missing', outcomes: [] }))
      .resolves.toMatchObject({ status: 409 });
    await expect(coordinatorRequest(coordinator, '/scheduler/v2/abort', { runId: 'missing' }))
      .resolves.toMatchObject({ status: 200 });
    await expect(coordinatorRequest(coordinator, '/scheduler/v2/begin', { holdSeconds: 1, maxCandidates: 2 }))
      .resolves.toHaveProperty('status', 200);
  });

  it('completes each claimed item once and ignores foreign outcomes', async () => {
    const namespace = new Namespace();
    await recordOwnedSchedulerDemand(namespace, 'metar', 'KMSN', 3600);
    const run = await beginOwnedSchedulerRun(namespace, 30, 2);
    const candidate = run?.candidates[0];
    if (!run || !candidate) throw new Error('Expected a claimed candidate.');

    await expect(completeOwnedSchedulerRun(namespace, run.runId, [
      { ...candidate, outcome: 'upstream_failed' },
      { ...candidate, outcome: 'upstream_failed' },
      { resource: 'airport', normalizedKey: 'KORD', lastAccessedAt: candidate.lastAccessedAt, outcome: 'upstream_failed' }
    ])).resolves.toEqual([]);
    await expect(completeOwnedSchedulerRun(namespace, run.runId, [{ ...candidate, outcome: 'upstream_failed' }])).resolves.toBeNull();
  });

  it('selects both resource types before filling remaining bounded capacity', async () => {
    const namespace = new Namespace();
    await recordOwnedSchedulerDemand(namespace, 'metar', 'KAAA', 3600);
    await recordOwnedSchedulerDemand(namespace, 'metar', 'KBBB', 3600);
    await recordOwnedSchedulerDemand(namespace, 'airport', 'KCCC', 3600);

    const run = await beginOwnedSchedulerRun(namespace, 30, 3);
    expect(run?.candidates.map((candidate) => candidate.resource)).toEqual(['metar', 'metar', 'airport']);
    await abortOwnedSchedulerRun(namespace, run?.runId ?? '');
  });

  it('advances the completed resource window so bounded runs reach later demand', async () => {
    const namespace = new Namespace();
    for (const key of ['KAAA', 'KBBB', 'KCCC', 'KDDD']) {
      await recordOwnedSchedulerDemand(namespace, 'metar', key, 3600);
    }

    const first = await beginOwnedSchedulerRun(namespace, 30, 2);
    expect(first?.candidates.map((candidate) => candidate.normalizedKey)).toEqual(['KAAA', 'KBBB']);
    await completeOwnedSchedulerRun(namespace, first?.runId ?? '', []);

    const second = await beginOwnedSchedulerRun(namespace, 30, 2);
    expect(second?.candidates.map((candidate) => candidate.normalizedKey)).toEqual(['KCCC', 'KDDD']);
    await abortOwnedSchedulerRun(namespace, second?.runId ?? '');
  });

  it('cleans expired demand from its alarm path even when no run occurs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-06T12:00:00.000Z'));
    const storage = new Storage();
    const coordinator = new OwnedSchedulerCoordinator({ storage });

    await coordinatorRequest(coordinator, '/scheduler/v2/touch', {
      resource: 'metar', normalizedKey: 'KORD', inactivityTtlSeconds: 1
    });
    expect(storage.alarmAt).toBe(Date.now() + 1000);
    vi.setSystemTime(new Date('2026-03-06T12:00:02.000Z'));
    await coordinator.alarm();

    const response = await coordinatorRequest(coordinator, '/scheduler/v2/begin', { holdSeconds: 30, maxCandidates: 2 });
    await expect(response.json()).resolves.toMatchObject({ acquired: true, candidates: [] });
  });
});
