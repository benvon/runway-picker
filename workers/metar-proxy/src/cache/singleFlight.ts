import type { DurableObjectNamespaceLike, DurableObjectStub } from './types';

interface AcquireLockBody {
  key: string;
  holdSeconds: number;
}

interface ReleaseLockBody {
  key: string;
  token: string;
}

interface LockRecord {
  token: string;
  expiresAtMs: number;
}

interface DurableObjectStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
}

interface AcquireResponse {
  acquired: boolean;
  token?: string;
}

export type SchedulerResource = 'metar' | 'airport';
export type SchedulerMaintenanceOutcome = 'refreshed' | 'upstream_failed' | 'neutral';

interface SchedulerRunRecord {
  id: string;
  expiresAtMs: number;
}

interface SchedulerFailureRecord {
  consecutiveFailures: number;
  lastAccessedAt: string;
}

interface SchedulerState {
  schemaVersion: 1;
  cursors: Partial<Record<SchedulerResource, string>>;
  failures: Record<string, SchedulerFailureRecord>;
  activeRun?: SchedulerRunRecord;
  completedRuns: Record<string, string[]>;
}

interface BeginRunBody { holdSeconds: number; }
interface CommitRunBody {
  runId: string;
  cursors: Partial<Record<SchedulerResource, string>>;
  outcomes: Array<{ identity: string; outcome: SchedulerMaintenanceOutcome; lastAccessedAt: string }>;
  inactivityTtlSeconds: number;
}
interface AbortRunBody { runId: string; }

export interface SchedulerRunLease {
  runId: string;
  cursors: Partial<Record<SchedulerResource, string>>;
}

export interface SchedulerCommitResult { dequeueIdentities: string[]; }

const SCHEDULER_OBJECT_NAME = '__cache-refresh-scheduler-v1__';
const SCHEDULER_STATE_KEY = 'scheduler-state';
const MAX_COMPLETED_RUNS = 20;

export interface SingleFlightLease {
  key: string;
  token: string;
}

function createToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readStringField(rawBody: unknown, field: string): string {
  if (!rawBody || typeof rawBody !== 'object') {
    return '';
  }

  const value = (rawBody as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : '';
}

async function parseRequestBody(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return null;
  }
}

function readHoldSeconds(rawBody: unknown): number {
  if (!rawBody || typeof rawBody !== 'object') {
    return Number.NaN;
  }

  return Number((rawBody as { holdSeconds?: unknown }).holdSeconds);
}

async function handleAcquire(
  request: Request,
  storage: DurableObjectStorageLike
): Promise<Response> {
  const rawBody = await parseRequestBody(request);
  const key = readStringField(rawBody, 'key');
  const holdSecondsNumber = readHoldSeconds(rawBody);

  if (!key || !Number.isFinite(holdSecondsNumber)) {
    return Response.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const now = Date.now();
  const lock = await storage.get<LockRecord>(key);
  if (lock && lock.expiresAtMs > now) {
    return Response.json({ acquired: false } satisfies AcquireResponse);
  }

  const safeHoldSeconds = Math.max(1, holdSecondsNumber);
  const token = createToken();
  await storage.put(key, {
    token,
    expiresAtMs: now + safeHoldSeconds * 1000
  } satisfies LockRecord);

  return Response.json({ acquired: true, token } satisfies AcquireResponse);
}

async function handleRelease(
  request: Request,
  storage: DurableObjectStorageLike
): Promise<Response> {
  const rawBody = await parseRequestBody(request);
  const key = readStringField(rawBody, 'key');
  const token = readStringField(rawBody, 'token');
  if (!key || !token) {
    return Response.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const lock = await storage.get<LockRecord>(key);
  if (lock && lock.token === token) {
    await storage.delete(key);
  }
  return new Response(null, { status: 204 });
}

function readSchedulerState(raw: unknown): SchedulerState {
  if (!raw || typeof raw !== 'object') {
    return { schemaVersion: 1, cursors: {}, failures: {}, completedRuns: {} };
  }
  const candidate = raw as Partial<SchedulerState>;
  if (candidate.schemaVersion !== 1 || !candidate.cursors || !candidate.failures || !candidate.completedRuns) {
    return { schemaVersion: 1, cursors: {}, failures: {}, completedRuns: {} };
  }
  const cursors: Partial<Record<SchedulerResource, string>> = {};
  for (const resource of ['metar', 'airport'] as const) {
    const cursor = candidate.cursors[resource];
    if (typeof cursor === 'string' && cursor.length > 0) {
      cursors[resource] = cursor;
    }
  }
  return {
    schemaVersion: 1,
    cursors,
    failures: candidate.failures,
    completedRuns: candidate.completedRuns,
    activeRun: candidate.activeRun
  };
}

function requestString(raw: unknown, field: string): string | null {
  return typeof raw === 'object' && raw !== null && typeof (raw as Record<string, unknown>)[field] === 'string'
    ? (raw as Record<string, string>)[field]
    : null;
}

// The Durable Object serializes this protocol; keeping request validation here makes its atomic state transition explicit.
// eslint-disable-next-line complexity
async function handleSchedulerRequest(request: Request, storage: DurableObjectStorageLike, pathname: string): Promise<Response> {
  const raw = await parseRequestBody(request);
  const state = readSchedulerState(await storage.get<SchedulerState>(SCHEDULER_STATE_KEY));
  const now = Date.now();
  if (state.activeRun && state.activeRun.expiresAtMs <= now) {
    delete state.activeRun;
  }
  if (pathname === '/scheduler/begin') {
    const holdSeconds = readHoldSeconds(raw);
    if (!Number.isFinite(holdSeconds)) return Response.json({ error: 'Invalid request body.' }, { status: 400 });
    if (state.activeRun) return Response.json({ acquired: false });
    const runId = createToken();
    state.activeRun = { id: runId, expiresAtMs: now + Math.max(1, holdSeconds) * 1000 };
    await storage.put(SCHEDULER_STATE_KEY, state);
    return Response.json({ acquired: true, runId, cursors: state.cursors });
  }
  const runId = requestString(raw, 'runId');
  if (!runId) return Response.json({ error: 'Invalid request body.' }, { status: 400 });
  if (pathname === '/scheduler/abort') {
    if (state.activeRun?.id === runId) {
      delete state.activeRun;
      await storage.put(SCHEDULER_STATE_KEY, state);
    }
    return new Response(null, { status: 204 });
  }
  if (pathname !== '/scheduler/commit') return Response.json({ error: 'Not found.' }, { status: 404 });
  const alreadyCommitted = state.completedRuns[runId];
  if (alreadyCommitted) return Response.json({ dequeueIdentities: alreadyCommitted } satisfies SchedulerCommitResult);
  if (state.activeRun?.id !== runId) return Response.json({ error: 'Run is not active.' }, { status: 409 });
  const body = raw as Partial<CommitRunBody>;
  const inactivityTtlSeconds = Number(body.inactivityTtlSeconds);
  if (!body.cursors || !Array.isArray(body.outcomes) || !Number.isFinite(inactivityTtlSeconds) || inactivityTtlSeconds <= 0) return Response.json({ error: 'Invalid request body.' }, { status: 400 });
  const cursors: Partial<Record<SchedulerResource, string>> = {};
  for (const resource of ['metar', 'airport'] as const) {
    const cursor = body.cursors[resource];
    if (typeof cursor === 'string' && cursor.length > 0) cursors[resource] = cursor;
  }
  const dequeueIdentities: string[] = [];
  for (const outcome of body.outcomes) {
    if (!outcome || typeof outcome.identity !== 'string' || !outcome.identity || typeof outcome.lastAccessedAt !== 'string') continue;
    if (outcome.outcome === 'refreshed') {
      delete state.failures[outcome.identity];
    } else if (outcome.outcome === 'upstream_failed') {
      const next = (state.failures[outcome.identity]?.consecutiveFailures ?? 0) + 1;
      if (next >= 3) {
        delete state.failures[outcome.identity];
        dequeueIdentities.push(outcome.identity);
      } else {
        state.failures[outcome.identity] = { consecutiveFailures: next, lastAccessedAt: outcome.lastAccessedAt };
      }
    }
  }
  for (const [identity, failure] of Object.entries(state.failures)) {
    if (Date.parse(failure.lastAccessedAt) <= now - inactivityTtlSeconds * 1000) delete state.failures[identity];
  }
  state.cursors = cursors;
  state.completedRuns[runId] = dequeueIdentities;
  const completedIds = Object.keys(state.completedRuns);
  for (const stale of completedIds.slice(0, Math.max(0, completedIds.length - MAX_COMPLETED_RUNS))) delete state.completedRuns[stale];
  delete state.activeRun;
  await storage.put(SCHEDULER_STATE_KEY, state);
  return Response.json({ dequeueIdentities } satisfies SchedulerCommitResult);
}

export class CacheSingleFlightCoordinator {
  constructor(private readonly state: DurableObjectStateLike) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed.' }, { status: 405 });
    }

    if (url.pathname === '/acquire') {
      return handleAcquire(request, this.state.storage);
    }

    if (url.pathname === '/release') {
      return handleRelease(request, this.state.storage);
    }

    if (url.pathname.startsWith('/scheduler/')) {
      return handleSchedulerRequest(request, this.state.storage, url.pathname);
    }

    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
}

function schedulerStub(namespace: DurableObjectNamespaceLike | undefined): DurableObjectStub | null {
  if (!namespace) return null;
  return namespace.get(namespace.idFromName(SCHEDULER_OBJECT_NAME));
}

async function schedulerRequest<T>(namespace: DurableObjectNamespaceLike | undefined, path: string, body: unknown): Promise<T | null> {
  const stub = schedulerStub(namespace);
  if (!stub) return null;
  let response: Response;
  try {
    response = await stub.fetch(`https://cache-coordinator.internal${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try { return await response.json() as T; } catch { return null; }
}

export async function beginSchedulerRun(namespace: DurableObjectNamespaceLike | undefined, holdSeconds: number): Promise<SchedulerRunLease | null> {
  const response = await schedulerRequest<{ acquired?: unknown; runId?: unknown; cursors?: unknown }>(namespace, '/scheduler/begin', { holdSeconds } satisfies BeginRunBody);
  if (!response || response.acquired !== true || typeof response.runId !== 'string' || !response.cursors || typeof response.cursors !== 'object') return null;
  const cursors: Partial<Record<SchedulerResource, string>> = {};
  for (const resource of ['metar', 'airport'] as const) {
    const cursor = (response.cursors as Record<string, unknown>)[resource];
    if (typeof cursor === 'string' && cursor.length > 0) cursors[resource] = cursor;
  }
  return { runId: response.runId, cursors };
}

export async function commitSchedulerRun(namespace: DurableObjectNamespaceLike | undefined, body: CommitRunBody): Promise<SchedulerCommitResult | null> {
  const response = await schedulerRequest<SchedulerCommitResult>(namespace, '/scheduler/commit', body);
  return response && Array.isArray(response.dequeueIdentities) ? response : null;
}

export async function abortSchedulerRun(namespace: DurableObjectNamespaceLike | undefined, runId: string): Promise<void> {
  await schedulerRequest(namespace, '/scheduler/abort', { runId } satisfies AbortRunBody);
}

export async function acquireSingleFlightLease(
  namespace: DurableObjectNamespaceLike | undefined,
  key: string,
  holdSeconds: number
): Promise<SingleFlightLease | null> {
  if (!namespace) {
    return null;
  }

  const id = namespace.idFromName(key);
  const stub = namespace.get(id);
  const response = await stub.fetch('https://cache-coordinator.internal/acquire', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, holdSeconds } satisfies AcquireLockBody)
  });

  if (!response.ok) {
    return null;
  }

  const body = (await response.json()) as AcquireResponse;
  if (!body.acquired || !body.token) {
    return null;
  }

  return {
    key,
    token: body.token
  };
}

export async function releaseSingleFlightLease(
  namespace: DurableObjectNamespaceLike | undefined,
  lease: SingleFlightLease | null
): Promise<void> {
  if (!namespace || !lease) {
    return;
  }

  const id = namespace.idFromName(lease.key);
  const stub = namespace.get(id);
  await stub.fetch('https://cache-coordinator.internal/release', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: lease.key, token: lease.token } satisfies ReleaseLockBody)
  });
}
