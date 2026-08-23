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
