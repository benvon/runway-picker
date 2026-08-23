import type { DurableObjectNamespaceLike, DurableObjectStub } from './types';

export type OwnedSchedulerResource = 'metar' | 'airport';
export type OwnedSchedulerOutcome = 'refreshed' | 'upstream_failed' | 'neutral';

export interface OwnedSchedulerCandidate {
  resource: OwnedSchedulerResource;
  normalizedKey: string;
  lastAccessedAt: string;
}

interface SqlStorageLike {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Iterable<T>;
}

interface StorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  sql?: SqlStorageLike;
  transactionSync?<T>(closure: () => T): T;
  getAlarm?(): Promise<number | null>;
  setAlarm?(scheduledTime: number | Date): Promise<void>;
}

interface StateLike { storage: StorageLike; }
interface Demand {
  resource: OwnedSchedulerResource;
  normalizedKey: string;
  lastAccessedAt: string;
  demandVersion: number;
  expiresAtMs: number;
  failures: number;
  suppressedAtMs?: number;
}
interface StoredCandidate extends OwnedSchedulerCandidate { demandVersion: number; }
interface Run {
  expiresAtMs: number;
  status: 'active' | 'completed';
  candidates: StoredCandidate[];
  applied: Record<string, true>;
  completedAtMs?: number;
}
interface FallbackState { schemaVersion: 1; demands: Record<string, Demand>; runs: Record<string, Run>; progress: Partial<Record<OwnedSchedulerResource, OwnedSchedulerCandidate>>; }
interface DemandRow { resource: string; normalized_key: string; last_accessed_at: string; demand_version: number; }
interface RunRow { expires_at_ms: number; status: string; }
interface ItemRow { applied: number; demand_version: number; }

const OBJECT_NAME = '__cache-refresh-scheduler-v1__';
const FALLBACK_KEY = 'owned-scheduler-test-fallback';
const RUN_RETENTION_MS = 24 * 60 * 60 * 1000;

function token(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function resource(value: unknown): value is OwnedSchedulerResource { return value === 'metar' || value === 'airport'; }
function identity(entry: Pick<OwnedSchedulerCandidate, 'resource' | 'normalizedKey'>): string { return `${entry.resource}:${entry.normalizedKey}`; }
function numberField(body: unknown, name: string): number {
  return body && typeof body === 'object' ? Number((body as Record<string, unknown>)[name]) : Number.NaN;
}
function stringField(body: unknown, name: string): string { return body && typeof body === 'object' && typeof (body as Record<string, unknown>)[name] === 'string' ? (body as Record<string, string>)[name] : ''; }
function validPositive(value: number): boolean { return Number.isFinite(value) && value > 0; }

class SchedulerState {
  constructor(private readonly storage: StorageLike) {}
  private get sql(): SqlStorageLike | undefined { return this.storage.sql; }
  private transaction<T>(closure: () => T): T {
    if (!this.storage.transactionSync) throw new Error('Durable Object SQLite transactions are unavailable.');
    return this.storage.transactionSync(closure);
  }
  private rows<T>(query: string, ...bindings: unknown[]): T[] { return [...(this.sql?.exec<T>(query, ...bindings) ?? [])]; }
  private setup(): void {
    const sql = this.sql;
    if (!sql) return;
    sql.exec('CREATE TABLE IF NOT EXISTS scheduler_demands (resource TEXT NOT NULL, normalized_key TEXT NOT NULL, last_accessed_at TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0, suppressed_at_ms INTEGER, PRIMARY KEY(resource, normalized_key))');
    // This version changes only when a foreground upstream refresh reactivates
    // the demand; neutral cache-hit touches must not discard real failures.
    sql.exec('CREATE TABLE IF NOT EXISTS scheduler_demand_versions (resource TEXT NOT NULL, normalized_key TEXT NOT NULL, demand_version INTEGER NOT NULL, PRIMARY KEY(resource, normalized_key))');
    sql.exec('CREATE TABLE IF NOT EXISTS scheduler_runs (id TEXT PRIMARY KEY, expires_at_ms INTEGER NOT NULL, status TEXT NOT NULL, completed_at_ms INTEGER)');
    sql.exec('CREATE TABLE IF NOT EXISTS scheduler_run_items (run_id TEXT NOT NULL, resource TEXT NOT NULL, normalized_key TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0, demand_version INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(run_id, resource, normalized_key))');
    if (!this.rows<{ name: string }>('PRAGMA table_info(scheduler_run_items)').some((column) => column.name === 'demand_version')) {
      sql.exec('ALTER TABLE scheduler_run_items ADD COLUMN demand_version INTEGER NOT NULL DEFAULT 0');
    }
    sql.exec('CREATE TABLE IF NOT EXISTS scheduler_run_progress (run_id TEXT NOT NULL, resource TEXT NOT NULL, last_accessed_at TEXT NOT NULL, normalized_key TEXT NOT NULL, PRIMARY KEY(run_id, resource))');
    sql.exec('CREATE TABLE IF NOT EXISTS scheduler_progress (resource TEXT PRIMARY KEY, last_accessed_at TEXT NOT NULL, normalized_key TEXT NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS scheduler_demand_candidates ON scheduler_demands(resource, suppressed_at_ms, last_accessed_at)');
  }
  private async fallback(): Promise<FallbackState> {
    const state = await this.storage.get<Partial<FallbackState>>(FALLBACK_KEY);
    return state?.schemaVersion === 1 && state.demands && state.runs ? { ...state, progress: state.progress ?? {} } as FallbackState : { schemaVersion: 1, demands: {}, runs: {}, progress: {} };
  }
  private async save(state: FallbackState): Promise<void> { await this.storage.put(FALLBACK_KEY, state); }
  private cleanFallback(state: FallbackState, now: number): void {
    for (const [key, demand] of Object.entries(state.demands)) if (demand.expiresAtMs <= now) delete state.demands[key];
    for (const [key, run] of Object.entries(state.runs)) if (run.status === 'completed' && (run.completedAtMs ?? now) <= now - RUN_RETENTION_MS) delete state.runs[key];
  }
  private cleanSql(now: number): void {
    this.rows('DELETE FROM scheduler_demands WHERE expires_at_ms <= ?', now);
    this.rows('DELETE FROM scheduler_demand_versions WHERE NOT EXISTS (SELECT 1 FROM scheduler_demands WHERE scheduler_demands.resource = scheduler_demand_versions.resource AND scheduler_demands.normalized_key = scheduler_demand_versions.normalized_key)');
    this.rows('DELETE FROM scheduler_run_items WHERE run_id IN (SELECT id FROM scheduler_runs WHERE status = ? AND completed_at_ms <= ?)', 'completed', now - RUN_RETENTION_MS);
    this.rows('DELETE FROM scheduler_run_progress WHERE run_id IN (SELECT id FROM scheduler_runs WHERE status = ? AND completed_at_ms <= ?)', 'completed', now - RUN_RETENTION_MS);
    this.rows('DELETE FROM scheduler_run_items WHERE run_id IN (SELECT id FROM scheduler_runs WHERE status = ? AND expires_at_ms <= ?)', 'active', now);
    this.rows('DELETE FROM scheduler_run_progress WHERE run_id IN (SELECT id FROM scheduler_runs WHERE status = ? AND expires_at_ms <= ?)', 'active', now);
    this.rows('DELETE FROM scheduler_runs WHERE status = ? AND completed_at_ms <= ?', 'completed', now - RUN_RETENTION_MS);
    this.rows('DELETE FROM scheduler_runs WHERE status = ? AND expires_at_ms <= ?', 'active', now);
  }
  async touch(entry: Pick<Demand, 'resource' | 'normalizedKey'>, ttlSeconds: number, reactivated: boolean, now: number): Promise<void> {
    const expiresAtMs = now + ttlSeconds * 1000;
    const lastAccessedAt = new Date(now).toISOString();
    if (this.sql) {
      this.transaction(() => {
        this.setup();
        this.rows('INSERT INTO scheduler_demand_versions(resource, normalized_key, demand_version) VALUES (?, ?, CASE WHEN ? THEN 1 ELSE 0 END) ON CONFLICT(resource, normalized_key) DO UPDATE SET demand_version = demand_version + CASE WHEN ? THEN 1 ELSE 0 END', entry.resource, entry.normalizedKey, reactivated ? 1 : 0, reactivated ? 1 : 0);
        this.rows('INSERT INTO scheduler_demands(resource, normalized_key, last_accessed_at, expires_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT(resource, normalized_key) DO UPDATE SET last_accessed_at = excluded.last_accessed_at, expires_at_ms = excluded.expires_at_ms, failures = CASE WHEN ? THEN 0 ELSE failures END, suppressed_at_ms = CASE WHEN ? THEN NULL ELSE suppressed_at_ms END', entry.resource, entry.normalizedKey, lastAccessedAt, expiresAtMs, reactivated ? 1 : 0, reactivated ? 1 : 0);
      });
      return;
    }
    const state = await this.fallback(); this.cleanFallback(state, now);
    const previous = state.demands[identity(entry)];
    state.demands[identity(entry)] = { ...entry, lastAccessedAt, demandVersion: (previous?.demandVersion ?? 0) + (reactivated ? 1 : 0), expiresAtMs, failures: reactivated ? 0 : previous?.failures ?? 0, suppressedAtMs: reactivated ? undefined : previous?.suppressedAtMs };
    await this.save(state);
  }
  // The transaction deliberately contains selection, claim, and run-item
  // creation so no candidate can be completed without an owned run.
  async begin(holdSeconds: number, maxCandidates: number, now: number): Promise<{ runId: string; candidates: OwnedSchedulerCandidate[] } | null> {
    const runId = token(); const max = Math.max(2, Math.floor(maxCandidates)); const metarLimit = Math.ceil(max / 2); const airportLimit = Math.floor(max / 2);
    if (this.sql) {
      return this.transaction(() => {
      this.setup(); this.cleanSql(now);
      if (this.rows<RunRow>('SELECT expires_at_ms, status FROM scheduler_runs WHERE status = ? AND expires_at_ms > ? LIMIT 1', 'active', now).length) return null;
      const select = (kind: OwnedSchedulerResource, limit: number, offset = 0): StoredCandidate[] => {
        const progress = this.rows<{ last_accessed_at: string; normalized_key: string }>('SELECT last_accessed_at, normalized_key FROM scheduler_progress WHERE resource = ? LIMIT 1', kind)[0];
        const total = limit + offset;
        const rows = progress
          ? this.rows<DemandRow>('SELECT demands.resource, demands.normalized_key, demands.last_accessed_at, COALESCE(versions.demand_version, 0) AS demand_version FROM scheduler_demands AS demands LEFT JOIN scheduler_demand_versions AS versions ON versions.resource = demands.resource AND versions.normalized_key = demands.normalized_key WHERE demands.resource = ? AND demands.suppressed_at_ms IS NULL ORDER BY CASE WHEN demands.last_accessed_at > ? OR (demands.last_accessed_at = ? AND demands.normalized_key > ?) THEN 0 ELSE 1 END ASC, demands.last_accessed_at ASC, demands.normalized_key ASC LIMIT ?', kind, progress.last_accessed_at, progress.last_accessed_at, progress.normalized_key, total)
          : this.rows<DemandRow>('SELECT demands.resource, demands.normalized_key, demands.last_accessed_at, COALESCE(versions.demand_version, 0) AS demand_version FROM scheduler_demands AS demands LEFT JOIN scheduler_demand_versions AS versions ON versions.resource = demands.resource AND versions.normalized_key = demands.normalized_key WHERE demands.resource = ? AND demands.suppressed_at_ms IS NULL ORDER BY demands.last_accessed_at ASC, demands.normalized_key ASC LIMIT ?', kind, total);
        return rows.slice(offset).map((row) => ({ resource: row.resource as OwnedSchedulerResource, normalizedKey: row.normalized_key, lastAccessedAt: row.last_accessed_at, demandVersion: row.demand_version }));
      };
      const metar = select('metar', metarLimit); const airport = select('airport', airportLimit); const remaining = max - metar.length - airport.length;
      if (remaining > 0) { const kind: OwnedSchedulerResource = metar.length < metarLimit ? 'airport' : 'metar'; (kind === 'metar' ? metar : airport).push(...select(kind, remaining, kind === 'metar' ? metar.length : airport.length)); }
      const candidates = [...metar, ...airport];
      this.rows('INSERT INTO scheduler_runs(id, expires_at_ms, status) VALUES (?, ?, ?)', runId, now + holdSeconds * 1000, 'active');
      for (const candidate of candidates) this.rows('INSERT INTO scheduler_run_items(run_id, resource, normalized_key, demand_version) VALUES (?, ?, ?, ?)', runId, candidate.resource, candidate.normalizedKey, candidate.demandVersion);
      for (const kind of ['metar', 'airport'] as const) { const last = candidates.filter((candidate) => candidate.resource === kind).at(-1); if (last) this.rows('INSERT INTO scheduler_run_progress(run_id, resource, last_accessed_at, normalized_key) VALUES (?, ?, ?, ?)', runId, kind, last.lastAccessedAt, last.normalizedKey); }
        return { runId, candidates: candidates.map((candidate) => ({ resource: candidate.resource, normalizedKey: candidate.normalizedKey, lastAccessedAt: candidate.lastAccessedAt })) };
      });
    }
    const state = await this.fallback(); this.cleanFallback(state, now);
    if (Object.values(state.runs).some((run) => run.status === 'active' && run.expiresAtMs > now)) return null;
    const select = (kind: OwnedSchedulerResource, limit: number, offset = 0) => { const all = Object.values(state.demands).filter((demand) => demand.resource === kind && !demand.suppressedAtMs).sort((left, right) => left.lastAccessedAt.localeCompare(right.lastAccessedAt) || left.normalizedKey.localeCompare(right.normalizedKey)); const progress = state.progress[kind]; const after = progress ? all.filter((demand) => demand.lastAccessedAt > progress.lastAccessedAt || (demand.lastAccessedAt === progress.lastAccessedAt && demand.normalizedKey > progress.normalizedKey)) : []; return [...after, ...all.filter((demand) => !after.includes(demand))].slice(offset, offset + limit).map(({ resource: candidateResource, normalizedKey, lastAccessedAt, demandVersion }) => ({ resource: candidateResource, normalizedKey, lastAccessedAt, demandVersion })); };
    const metar = select('metar', metarLimit); const airport = select('airport', airportLimit); const remaining = max - metar.length - airport.length;
    if (remaining > 0) { const kind: OwnedSchedulerResource = metar.length < metarLimit ? 'airport' : 'metar'; (kind === 'metar' ? metar : airport).push(...select(kind, remaining, kind === 'metar' ? metar.length : airport.length)); }
    const candidates = [...metar, ...airport]; state.runs[runId] = { expiresAtMs: now + holdSeconds * 1000, status: 'active', candidates, applied: {} }; await this.save(state); return { runId, candidates: candidates.map((candidate) => ({ resource: candidate.resource, normalizedKey: candidate.normalizedKey, lastAccessedAt: candidate.lastAccessedAt })) };
  }
  async renew(runId: string, holdSeconds: number, now: number): Promise<boolean> {
    if (this.sql) return this.transaction(() => { this.setup(); const run = this.rows<RunRow>('SELECT expires_at_ms, status FROM scheduler_runs WHERE id = ? LIMIT 1', runId)[0]; if (!run || run.status !== 'active' || run.expires_at_ms <= now) return false; this.rows('UPDATE scheduler_runs SET expires_at_ms = ? WHERE id = ?', now + holdSeconds * 1000, runId); return true; });
    const state = await this.fallback(); const run = state.runs[runId]; if (!run || run.status !== 'active' || run.expiresAtMs <= now) return false; run.expiresAtMs = now + holdSeconds * 1000; await this.save(state); return true;
  }
  async abort(runId: string): Promise<void> {
    if (this.sql) { this.transaction(() => { this.setup(); this.rows('DELETE FROM scheduler_run_items WHERE run_id = ?', runId); this.rows('DELETE FROM scheduler_run_progress WHERE run_id = ?', runId); this.rows('DELETE FROM scheduler_runs WHERE id = ? AND status = ?', runId, 'active'); }); return; }
    const state = await this.fallback(); if (state.runs[runId]?.status === 'active') delete state.runs[runId]; await this.save(state);
  }
  // Completion validates claimed work, applies outcomes, and advances durable
  // continuation together; splitting those branches would weaken that contract.
  // eslint-disable-next-line complexity
  async complete(runId: string, outcomes: Array<OwnedSchedulerCandidate & { outcome: OwnedSchedulerOutcome }>, now: number): Promise<string[] | null> {
    if (this.sql) {
      // The claimed-item check and state transition must share one transaction.
      // eslint-disable-next-line complexity
      return this.transaction(() => {
      this.setup(); this.cleanSql(now); const run = this.rows<RunRow>('SELECT expires_at_ms, status FROM scheduler_runs WHERE id = ? LIMIT 1', runId)[0]; if (!run || run.status !== 'active' || run.expires_at_ms <= now) return null;
      const suppressed: string[] = [];
      for (const outcome of outcomes) {
        if (!resource(outcome.resource) || !outcome.normalizedKey || !['refreshed', 'upstream_failed', 'neutral'].includes(outcome.outcome)) continue;
        const item = this.rows<ItemRow>('SELECT applied, demand_version FROM scheduler_run_items WHERE run_id = ? AND resource = ? AND normalized_key = ? LIMIT 1', runId, outcome.resource, outcome.normalizedKey)[0]; if (!item || item.applied !== 0) continue;
        this.rows('UPDATE scheduler_run_items SET applied = 1 WHERE run_id = ? AND resource = ? AND normalized_key = ?', runId, outcome.resource, outcome.normalizedKey);
        if (outcome.outcome === 'refreshed') this.rows('UPDATE scheduler_demands SET failures = 0, suppressed_at_ms = NULL WHERE resource = ? AND normalized_key = ?', outcome.resource, outcome.normalizedKey);
        if (outcome.outcome === 'upstream_failed') { const demand = this.rows<{ failures: number; demand_version: number }>('SELECT demands.failures, COALESCE(versions.demand_version, 0) AS demand_version FROM scheduler_demands AS demands LEFT JOIN scheduler_demand_versions AS versions ON versions.resource = demands.resource AND versions.normalized_key = demands.normalized_key WHERE demands.resource = ? AND demands.normalized_key = ? LIMIT 1', outcome.resource, outcome.normalizedKey)[0]; if (demand && demand.demand_version === item.demand_version) { const failures = demand.failures + 1; this.rows('UPDATE scheduler_demands SET failures = ?, suppressed_at_ms = CASE WHEN ? >= 3 THEN ? ELSE suppressed_at_ms END WHERE resource = ? AND normalized_key = ?', failures, failures, now, outcome.resource, outcome.normalizedKey); if (failures >= 3) suppressed.push(identity(outcome)); } }
      }
        this.rows('INSERT INTO scheduler_progress(resource, last_accessed_at, normalized_key) SELECT resource, last_accessed_at, normalized_key FROM scheduler_run_progress WHERE run_id = ? ON CONFLICT(resource) DO UPDATE SET last_accessed_at = excluded.last_accessed_at, normalized_key = excluded.normalized_key', runId);
        this.rows('UPDATE scheduler_runs SET status = ?, completed_at_ms = ? WHERE id = ?', 'completed', now, runId); return suppressed;
      });
    }
    const state = await this.fallback(); this.cleanFallback(state, now); const run = state.runs[runId]; if (!run || run.status !== 'active' || run.expiresAtMs <= now) return null;
    const candidates = new Map(run.candidates.map((candidate) => [identity(candidate), candidate])); const suppressed: string[] = [];
    for (const outcome of outcomes) { const key = identity(outcome); const candidate = candidates.get(key); if (!candidate || run.applied[key]) continue; run.applied[key] = true; const demand = state.demands[key]; if (!demand) continue; if (outcome.outcome === 'refreshed') { demand.failures = 0; delete demand.suppressedAtMs; } else if (outcome.outcome === 'upstream_failed' && demand.demandVersion === candidate.demandVersion) { demand.failures += 1; if (demand.failures >= 3) { demand.suppressedAtMs = now; suppressed.push(key); } } }
    for (const kind of ['metar', 'airport'] as const) { const last = run.candidates.filter((candidate) => candidate.resource === kind).at(-1); if (last) state.progress[kind] = last; }
    run.status = 'completed'; run.completedAtMs = now; await this.save(state); return suppressed;
  }
  async cleanup(now: number): Promise<number | null> {
    if (this.sql) return this.transaction(() => { this.setup(); this.cleanSql(now); return this.rows<{ expires_at_ms: number }>('SELECT expires_at_ms FROM scheduler_demands ORDER BY expires_at_ms ASC LIMIT 1')[0]?.expires_at_ms ?? null; });
    const state = await this.fallback(); this.cleanFallback(state, now); const next = Object.values(state.demands).reduce<number | null>((earliest, demand) => earliest === null || demand.expiresAtMs < earliest ? demand.expiresAtMs : earliest, null); await this.save(state); return next;
  }
}

export class OwnedSchedulerCoordinator {
  private readonly state: SchedulerState;
  constructor(private readonly durableState: StateLike) { this.state = new SchedulerState(durableState.storage); }
  private async schedule(expiry: number): Promise<void> { const storage = this.durableState.storage; if (!storage.setAlarm) return; const existing = await storage.getAlarm?.(); if (existing === undefined || existing === null || expiry < existing) await storage.setAlarm(expiry); }
  // Route validation is kept at the coordinator trust boundary.
  // eslint-disable-next-line complexity
  async fetch(request: Request, path: string): Promise<Response> {
    const body = await request.json().catch(() => null) as unknown; const now = Date.now();
    if (path === '/scheduler/v2/touch') { const kind = body && typeof body === 'object' ? (body as Record<string, unknown>).resource : undefined; const normalizedKey = stringField(body, 'normalizedKey'); const ttl = numberField(body, 'inactivityTtlSeconds'); const reactivated = Boolean(body && typeof body === 'object' && (body as Record<string, unknown>).reactivated === true); if (!resource(kind) || !normalizedKey || !validPositive(ttl)) return Response.json({ error: 'Invalid request body.' }, { status: 400 }); await this.state.touch({ resource: kind, normalizedKey }, ttl, reactivated, now); await this.schedule(now + ttl * 1000); return Response.json({ ok: true }); }
    if (path === '/scheduler/v2/begin') { const hold = numberField(body, 'holdSeconds'); const max = numberField(body, 'maxCandidates'); if (!validPositive(hold) || !validPositive(max)) return Response.json({ error: 'Invalid request body.' }, { status: 400 }); const lease = await this.state.begin(hold, max, now); return Response.json(lease ? { acquired: true, ...lease } : { acquired: false }); }
    const runId = stringField(body, 'runId'); if (!runId) return Response.json({ error: 'Invalid request body.' }, { status: 400 });
    if (path === '/scheduler/v2/abort') { await this.state.abort(runId); return Response.json({ ok: true }); }
    if (path === '/scheduler/v2/renew') { const hold = numberField(body, 'holdSeconds'); if (!validPositive(hold) || !(await this.state.renew(runId, hold, now))) return Response.json({ error: 'Run is not active.' }, { status: 409 }); return Response.json({ ok: true }); }
    if (path === '/scheduler/v2/complete') { const outcomes = body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>).outcomes) ? (body as { outcomes: Array<OwnedSchedulerCandidate & { outcome: OwnedSchedulerOutcome }> }).outcomes : null; if (!outcomes) return Response.json({ error: 'Invalid request body.' }, { status: 400 }); const suppressedIdentities = await this.state.complete(runId, outcomes, now); return suppressedIdentities === null ? Response.json({ error: 'Run is not active.' }, { status: 409 }) : Response.json({ suppressedIdentities }); }
    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
  async alarm(): Promise<void> { const next = await this.state.cleanup(Date.now()); if (next !== null && this.durableState.storage.setAlarm) await this.durableState.storage.setAlarm(next); }
}

function stub(namespace: DurableObjectNamespaceLike | undefined): DurableObjectStub | null { return namespace ? namespace.get(namespace.idFromName(OBJECT_NAME)) : null; }
async function request<T>(namespace: DurableObjectNamespaceLike | undefined, path: string, body: unknown): Promise<T | null> { const target = stub(namespace); if (!target) return null; try { const response = await target.fetch(`https://cache-coordinator.internal${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return response.ok ? await response.json() as T : null; } catch { return null; } }
export async function recordOwnedSchedulerDemand(namespace: DurableObjectNamespaceLike | undefined, resource: OwnedSchedulerResource, normalizedKey: string, inactivityTtlSeconds: number, reactivated = false): Promise<boolean> { return Boolean(await request(namespace, '/scheduler/v2/touch', { resource, normalizedKey, inactivityTtlSeconds, reactivated })); }
export async function beginOwnedSchedulerRun(namespace: DurableObjectNamespaceLike | undefined, holdSeconds: number, maxCandidates: number): Promise<{ runId: string; candidates: OwnedSchedulerCandidate[] } | null> { const result = await request<{ acquired?: boolean; runId?: string; candidates?: OwnedSchedulerCandidate[] }>(namespace, '/scheduler/v2/begin', { holdSeconds, maxCandidates }); return result?.acquired && typeof result.runId === 'string' && Array.isArray(result.candidates) ? { runId: result.runId, candidates: result.candidates } : null; }
export async function renewOwnedSchedulerRun(namespace: DurableObjectNamespaceLike | undefined, runId: string, holdSeconds: number): Promise<boolean> { return Boolean(await request(namespace, '/scheduler/v2/renew', { runId, holdSeconds })); }
export async function abortOwnedSchedulerRun(namespace: DurableObjectNamespaceLike | undefined, runId: string): Promise<void> { await request(namespace, '/scheduler/v2/abort', { runId }); }
export async function completeOwnedSchedulerRun(namespace: DurableObjectNamespaceLike | undefined, runId: string, outcomes: Array<OwnedSchedulerCandidate & { outcome: OwnedSchedulerOutcome }>): Promise<string[] | null> { const result = await request<{ suppressedIdentities?: unknown }>(namespace, '/scheduler/v2/complete', { runId, outcomes }); return result && Array.isArray(result.suppressedIdentities) && result.suppressedIdentities.every((value) => typeof value === 'string') ? result.suppressedIdentities : null; }
