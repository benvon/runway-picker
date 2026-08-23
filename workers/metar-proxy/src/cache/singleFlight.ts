import type { CacheEngineEnv, DurableObjectNamespaceLike, DurableObjectStub, KvNamespaceLike } from './types';
import { OwnedSchedulerCoordinator } from './schedulerOwner';

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

interface SchedulerDemandRecord {
  version: number;
  lastAccessedAt: string;
}

interface SchedulerDemandBody {
  resource: SchedulerResource;
  normalizedKey: string;
  lastAccessedAt: string;
  expirationTtl: number;
}

interface SchedulerState {
  schemaVersion: 1;
  cursors: Partial<Record<SchedulerResource, string>>;
  demands: Record<string, SchedulerDemandRecord>;
  failures: Record<string, SchedulerFailureRecord>;
  pendingDequeues: Record<string, SchedulerFailureRecord>;
  activeRun?: SchedulerRunRecord;
  completedRuns: Record<string, string[]>;
}

interface BeginRunBody { holdSeconds: number; }
interface CommitRunBody {
  runId: string;
  cursors: Partial<Record<SchedulerResource, string>>;
  outcomes: Array<{ identity: string; outcome: SchedulerMaintenanceOutcome; lastAccessedAt: string; demandVersion?: number }>;
  inactivityTtlSeconds: number;
}
interface AbortRunBody { runId: string; }
interface RenewRunBody { runId: string; holdSeconds: number; }
interface AcknowledgeDequeueBody { runId: string; identities: string[]; }

export interface SchedulerRunLease {
  runId: string;
  cursors: Partial<Record<SchedulerResource, string>>;
}

export interface SchedulerCommitResult { dequeueIdentities: string[]; }

const SCHEDULER_OBJECT_NAME = '__cache-refresh-scheduler-v1__';
const SCHEDULER_STATE_KEY = 'scheduler-state';
const MAX_COMPLETED_RUNS = 20;
const HOT_DEMAND_SCHEMA_VERSION = 5;
const HOT_DEMAND_KEY_PREFIX = 'v2:hot:';

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

function readSchedulerCursors(raw: Partial<Record<SchedulerResource, string>>): Partial<Record<SchedulerResource, string>> {
  const cursors: Partial<Record<SchedulerResource, string>> = {};
  for (const resource of ['metar', 'airport'] as const) {
    const cursor = raw[resource];
    if (typeof cursor === 'string' && cursor.length > 0) {
      cursors[resource] = cursor;
    }
  }
  return cursors;
}

function isFailureRecord(value: unknown): value is SchedulerFailureRecord {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as Partial<SchedulerFailureRecord>).lastAccessedAt === 'string' &&
    Number.isFinite((value as Partial<SchedulerFailureRecord>).consecutiveFailures)
  );
}

function readPendingDequeues(
  failures: Record<string, SchedulerFailureRecord>,
  rawPending: unknown
): Record<string, SchedulerFailureRecord> {
  const pendingDequeues: Record<string, SchedulerFailureRecord> = {};
  if (!rawPending || typeof rawPending !== 'object') return pendingDequeues;
  for (const [identity, pending] of Object.entries(rawPending)) {
    const failure = failures[identity];
    if (isFailureRecord(failure)) {
      pendingDequeues[identity] = failure;
    } else if (isFailureRecord(pending)) {
      pendingDequeues[identity] = pending;
    }
  }
  return pendingDequeues;
}

function isDemandRecord(value: unknown): value is SchedulerDemandRecord {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Number.isSafeInteger((value as Partial<SchedulerDemandRecord>).version) &&
    (value as Partial<SchedulerDemandRecord>).version! > 0 &&
    typeof (value as Partial<SchedulerDemandRecord>).lastAccessedAt === 'string' &&
    Number.isFinite(Date.parse((value as Partial<SchedulerDemandRecord>).lastAccessedAt ?? ''))
  );
}

function readDemandRecords(raw: unknown): Record<string, SchedulerDemandRecord> {
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, SchedulerDemandRecord] => isDemandRecord(entry[1]))
  );
}

function emptySchedulerState(): SchedulerState {
  return { schemaVersion: 1, cursors: {}, demands: {}, failures: {}, pendingDequeues: {}, completedRuns: {} };
}

function readSchedulerState(raw: unknown): SchedulerState {
  if (!raw || typeof raw !== 'object') return emptySchedulerState();
  const candidate = raw as Partial<SchedulerState>;
  if (candidate.schemaVersion !== 1 || !candidate.cursors || !candidate.failures || !candidate.completedRuns) {
    return emptySchedulerState();
  }
  return {
    schemaVersion: 1,
    cursors: readSchedulerCursors(candidate.cursors),
    demands: readDemandRecords(candidate.demands),
    failures: candidate.failures,
    pendingDequeues: readPendingDequeues(candidate.failures, candidate.pendingDequeues),
    completedRuns: candidate.completedRuns,
    activeRun: candidate.activeRun
  };
}

function requestString(raw: unknown, field: string): string | null {
  return typeof raw === 'object' && raw !== null && typeof (raw as Record<string, unknown>)[field] === 'string'
    ? (raw as Record<string, string>)[field]
    : null;
}

function isSchedulerResource(value: unknown): value is SchedulerResource {
  return value === 'metar' || value === 'airport';
}

function readDemandBody(raw: unknown): SchedulerDemandBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Partial<SchedulerDemandBody>;
  if (
    !isSchedulerResource(body.resource) ||
    typeof body.normalizedKey !== 'string' ||
    body.normalizedKey.length === 0 ||
    typeof body.lastAccessedAt !== 'string' ||
    !Number.isFinite(Date.parse(body.lastAccessedAt)) ||
    typeof body.expirationTtl !== 'number' ||
    !Number.isFinite(body.expirationTtl) ||
    body.expirationTtl <= 0
  ) {
    return null;
  }
  return body as SchedulerDemandBody;
}

function hotDemandIdentity(resource: SchedulerResource, normalizedKey: string): string {
  return `${HOT_DEMAND_KEY_PREFIX}${resource}:${normalizedKey}`;
}

async function handleDemandTouch(
  raw: unknown,
  state: SchedulerState,
  storage: DurableObjectStorageLike,
  cache: KvNamespaceLike | undefined
): Promise<Response> {
  const body = readDemandBody(raw);
  if (!body) return Response.json({ error: 'Invalid request body.' }, { status: 400 });
  if (!cache) return Response.json({ error: 'Cache binding unavailable.' }, { status: 503 });
  const identity = hotDemandIdentity(body.resource, body.normalizedKey);
  const previousDemand = state.demands[identity];
  const lastAccessedAt =
    previousDemand && Date.parse(previousDemand.lastAccessedAt) > Date.parse(body.lastAccessedAt)
      ? previousDemand.lastAccessedAt
      : body.lastAccessedAt;
  const demandVersion = (previousDemand?.version ?? 0) + 1;

  // Persist the newer demand version before writing its KV projection. A later
  // dequeue request is serialized behind this transition and cannot remove it.
  // Client traffic is neutral: it cannot reset ordinary scheduler failure history.
  state.demands[identity] = { version: demandVersion, lastAccessedAt };
  delete state.pendingDequeues[identity];
  await storage.put(SCHEDULER_STATE_KEY, state);
  try {
    await cache.put(
      identity,
      JSON.stringify({
        schemaVersion: HOT_DEMAND_SCHEMA_VERSION,
        resource: body.resource,
        normalizedKey: body.normalizedKey,
        lastAccessedAt,
        demandVersion
      }),
      { expirationTtl: body.expirationTtl as number }
    );
  } catch {
    return Response.json({ error: 'Demand write failed.' }, { status: 503 });
  }
  return new Response(null, { status: 204 });
}

async function handlePendingDequeues(
  state: SchedulerState,
  storage: DurableObjectStorageLike,
  cache: KvNamespaceLike | undefined
): Promise<Response> {
  if (!cache?.delete) return Response.json({ error: 'Cache delete unavailable.' }, { status: 503 });
  for (const identity of Object.keys(state.pendingDequeues)) {
    try {
      await cache.delete(identity);
    } catch {
      await storage.put(SCHEDULER_STATE_KEY, state);
      return Response.json({ error: 'Demand deletion failed.' }, { status: 503 });
    }
    delete state.pendingDequeues[identity];
    delete state.failures[identity];
    delete state.demands[identity];
  }
  await storage.put(SCHEDULER_STATE_KEY, state);
  return new Response(null, { status: 204 });
}

// The Durable Object serializes this protocol; keeping request validation here makes its atomic state transition explicit.
// eslint-disable-next-line complexity
async function handleSchedulerRequest(
  request: Request,
  storage: DurableObjectStorageLike,
  pathname: string,
  cache: KvNamespaceLike | undefined
): Promise<Response> {
  const raw = await parseRequestBody(request);
  const state = readSchedulerState(await storage.get<SchedulerState>(SCHEDULER_STATE_KEY));
  const now = Date.now();
  if (state.activeRun && state.activeRun.expiresAtMs <= now) {
    delete state.activeRun;
  }
  if (pathname === '/scheduler/touch-demand') {
    return handleDemandTouch(raw, state, storage, cache);
  }
  if (pathname === '/scheduler/process-dequeues') {
    return handlePendingDequeues(state, storage, cache);
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
  if (pathname === '/scheduler/renew') {
    const holdSeconds = readHoldSeconds(raw);
    if (state.activeRun?.id !== runId || !Number.isFinite(holdSeconds)) return Response.json({ error: 'Run is not active.' }, { status: 409 });
    state.activeRun.expiresAtMs = now + Math.max(1, holdSeconds) * 1000;
    await storage.put(SCHEDULER_STATE_KEY, state);
    return new Response(null, { status: 204 });
  }
  if (pathname === '/scheduler/ack-dequeues') {
    const body = raw as Partial<AcknowledgeDequeueBody>;
    if (!state.completedRuns[runId] || !Array.isArray(body.identities)) return Response.json({ error: 'Run is not committed.' }, { status: 409 });
    for (const identity of body.identities) {
      if (typeof identity === 'string' && state.pendingDequeues[identity]) {
        delete state.pendingDequeues[identity];
        delete state.failures[identity];
        delete state.demands[identity];
      }
    }
    await storage.put(SCHEDULER_STATE_KEY, state);
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
  const dequeueIdentities = Object.keys(state.pendingDequeues);
  for (const outcome of body.outcomes) {
    if (!outcome || typeof outcome.identity !== 'string' || !outcome.identity || typeof outcome.lastAccessedAt !== 'string') continue;
    const demand = state.demands[outcome.identity];
    const staleDemandOutcome = Boolean(demand && outcome.demandVersion !== demand.version);
    if (outcome.outcome === 'refreshed') {
      delete state.failures[outcome.identity];
    } else if (outcome.outcome === 'upstream_failed') {
      if (staleDemandOutcome) continue;
      const next = (state.failures[outcome.identity]?.consecutiveFailures ?? 0) + 1;
      if (next >= 3) {
        state.failures[outcome.identity] = { consecutiveFailures: next, lastAccessedAt: outcome.lastAccessedAt };
        state.pendingDequeues[outcome.identity] = state.failures[outcome.identity];
        if (!dequeueIdentities.includes(outcome.identity)) dequeueIdentities.push(outcome.identity);
      } else {
        state.failures[outcome.identity] = { consecutiveFailures: next, lastAccessedAt: outcome.lastAccessedAt };
      }
    }
  }
  for (const [identity, failure] of Object.entries(state.failures)) {
    if (Date.parse(failure.lastAccessedAt) <= now - inactivityTtlSeconds * 1000) delete state.failures[identity];
  }
  for (const [identity, demand] of Object.entries(state.demands)) {
    if (Date.parse(demand.lastAccessedAt) <= now - inactivityTtlSeconds * 1000) delete state.demands[identity];
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
  // Scheduler state is shared by demand touches, run commits, and dequeues.
  // Unlike Durable Object storage, the hot-demand projection lives in external
  // KV and opens the input gate while awaited. Serialize the scheduler protocol
  // explicitly so a later request cannot overwrite a transition in progress.
  private schedulerRequestTail: Promise<void> = Promise.resolve();
  private readonly ownedScheduler: OwnedSchedulerCoordinator;

  constructor(
    private readonly state: DurableObjectStateLike,
    private readonly env?: Pick<CacheEngineEnv, 'METAR_CACHE'>
  ) {
    this.ownedScheduler = new OwnedSchedulerCoordinator(state);
  }

  private async runSerializedSchedulerRequest(operation: () => Promise<Response>): Promise<Response> {
    const previous = this.schedulerRequestTail;
    let release: (() => void) | undefined;
    this.schedulerRequestTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

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

    if (url.pathname.startsWith('/scheduler/v2/')) {
      return this.ownedScheduler.fetch(request, url.pathname);
    }

    if (url.pathname.startsWith('/scheduler/')) {
      return this.runSerializedSchedulerRequest(() =>
        handleSchedulerRequest(request, this.state.storage, url.pathname, this.env?.METAR_CACHE)
      );
    }

    return Response.json({ error: 'Not found.' }, { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.ownedScheduler.alarm();
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

export async function renewSchedulerRun(namespace: DurableObjectNamespaceLike | undefined, runId: string, holdSeconds: number): Promise<boolean> {
  const stub = schedulerStub(namespace);
  if (!stub) return false;
  try {
    const response = await stub.fetch('https://cache-coordinator.internal/scheduler/renew', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId, holdSeconds } satisfies RenewRunBody)
    });
    return response.ok;
  } catch { return false; }
}

export async function acknowledgeSchedulerDequeues(namespace: DurableObjectNamespaceLike | undefined, runId: string, identities: string[]): Promise<boolean> {
  const stub = schedulerStub(namespace);
  if (!stub) return false;
  try {
    const response = await stub.fetch('https://cache-coordinator.internal/scheduler/ack-dequeues', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId, identities } satisfies AcknowledgeDequeueBody)
    });
    return response.ok;
  } catch { return false; }
}

async function schedulerMutation(
  namespace: DurableObjectNamespaceLike | undefined,
  path: string,
  body: unknown
): Promise<boolean> {
  const stub = schedulerStub(namespace);
  if (!stub) return false;
  try {
    const response = await stub.fetch(`https://cache-coordinator.internal${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function recordSchedulerDemand(
  namespace: DurableObjectNamespaceLike | undefined,
  body: SchedulerDemandBody
): Promise<boolean> {
  return schedulerMutation(namespace, '/scheduler/touch-demand', body);
}

export async function processSchedulerDequeues(
  namespace: DurableObjectNamespaceLike | undefined
): Promise<boolean> {
  return schedulerMutation(namespace, '/scheduler/process-dequeues', {});
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
