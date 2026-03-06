import type { DurableObjectNamespaceLike } from '../cache/types';

const BURST_LIMIT = 20;
const BURST_WINDOW_SECONDS = 10;
const SUSTAINED_LIMIT = 60;
const SUSTAINED_WINDOW_SECONDS = 60;
const INVALID_ICAO_LIMIT = 8;
const INVALID_ICAO_WINDOW_SECONDS = 60;
const INVALID_ICAO_PENALTY_SECONDS = 120;

interface CounterWindow {
  count: number;
  resetAtMs: number;
}

interface RateLimitState {
  burst: CounterWindow;
  sustained: CounterWindow;
  invalidIcao: CounterWindow;
  penaltyUntilMs: number;
}

interface DurableObjectStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
}

interface CheckRequestBody {
  nowMs?: number;
}

interface PenalizeRequestBody {
  nowMs?: number;
}

interface RateLimitDecisionResponse {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
  retryAfterSeconds: number | null;
}

interface PenalizeResponse {
  penalized: boolean;
}

export interface RateLimitHeaders {
  limit: number;
  remaining: number;
  resetSeconds: number;
  retryAfterSeconds: number | null;
}

export interface RateLimitDecision {
  allowed: boolean;
  headers: RateLimitHeaders;
}

const STATE_KEY = 'state';

function createWindow(nowMs: number, windowSeconds: number): CounterWindow {
  return {
    count: 0,
    resetAtMs: nowMs + windowSeconds * 1000
  };
}

function toSafeNow(nowMsCandidate: unknown): number {
  const candidate = Number(nowMsCandidate);
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return Date.now();
  }

  return candidate;
}

function ensureWindow(window: CounterWindow | undefined, nowMs: number, windowSeconds: number): CounterWindow {
  if (!window || nowMs >= window.resetAtMs) {
    return createWindow(nowMs, windowSeconds);
  }

  return window;
}

function createState(nowMs: number): RateLimitState {
  return {
    burst: createWindow(nowMs, BURST_WINDOW_SECONDS),
    sustained: createWindow(nowMs, SUSTAINED_WINDOW_SECONDS),
    invalidIcao: createWindow(nowMs, INVALID_ICAO_WINDOW_SECONDS),
    penaltyUntilMs: 0
  };
}

function secondsUntilReset(nowMs: number, resetAtMs: number): number {
  return Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
}

function toHeadersFromDecision(decision: RateLimitDecisionResponse): RateLimitHeaders {
  return {
    limit: decision.limit,
    remaining: decision.remaining,
    resetSeconds: decision.resetSeconds,
    retryAfterSeconds: decision.retryAfterSeconds
  };
}

function createAllowedHeaders(): RateLimitHeaders {
  return {
    limit: SUSTAINED_LIMIT,
    remaining: SUSTAINED_LIMIT,
    resetSeconds: SUSTAINED_WINDOW_SECONDS,
    retryAfterSeconds: null
  };
}

async function parseBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

async function loadRateLimitState(
  storage: DurableObjectStorageLike,
  nowMs: number
): Promise<RateLimitState> {
  const rawState = (await storage.get<RateLimitState>(STATE_KEY)) ?? createState(nowMs);
  return {
    ...rawState,
    burst: ensureWindow(rawState.burst, nowMs, BURST_WINDOW_SECONDS),
    sustained: ensureWindow(rawState.sustained, nowMs, SUSTAINED_WINDOW_SECONDS),
    invalidIcao: ensureWindow(rawState.invalidIcao, nowMs, INVALID_ICAO_WINDOW_SECONDS),
    penaltyUntilMs: rawState.penaltyUntilMs ?? 0
  };
}

function buildPenaltyDecision(nowMs: number, penaltyUntilMs: number): RateLimitDecisionResponse {
  const retryAfterSeconds = secondsUntilReset(nowMs, penaltyUntilMs);
  return {
    allowed: false,
    limit: SUSTAINED_LIMIT,
    remaining: 0,
    resetSeconds: retryAfterSeconds,
    retryAfterSeconds
  };
}

function toExceededResetMs(nowMs: number, state: RateLimitState, nextBurst: number, nextSustained: number): number {
  const burstExceeded = nextBurst > BURST_LIMIT;
  const sustainedExceeded = nextSustained > SUSTAINED_LIMIT;
  if (burstExceeded && sustainedExceeded) {
    return Math.max(state.burst.resetAtMs, state.sustained.resetAtMs);
  }

  if (burstExceeded) {
    return state.burst.resetAtMs;
  }

  if (sustainedExceeded) {
    return state.sustained.resetAtMs;
  }

  return nowMs;
}

function buildAllowedDecision(nowMs: number, state: RateLimitState): RateLimitDecisionResponse {
  const remainingBurst = BURST_LIMIT - state.burst.count;
  const remainingSustained = SUSTAINED_LIMIT - state.sustained.count;
  return {
    allowed: true,
    limit: SUSTAINED_LIMIT,
    remaining: Math.max(0, Math.min(remainingBurst, remainingSustained)),
    resetSeconds: Math.min(
      secondsUntilReset(nowMs, state.burst.resetAtMs),
      secondsUntilReset(nowMs, state.sustained.resetAtMs)
    ),
    retryAfterSeconds: null
  };
}

async function handleCheckRequest(
  request: Request,
  storage: DurableObjectStorageLike
): Promise<Response> {
  const body = (await parseBody<CheckRequestBody>(request)) ?? {};
  const nowMs = toSafeNow(body.nowMs);
  const state = await loadRateLimitState(storage, nowMs);

  if (state.penaltyUntilMs > nowMs) {
    const responseBody = buildPenaltyDecision(nowMs, state.penaltyUntilMs);
    await storage.put(STATE_KEY, state);
    return Response.json(responseBody);
  }

  const nextBurst = state.burst.count + 1;
  const nextSustained = state.sustained.count + 1;
  if (nextBurst > BURST_LIMIT || nextSustained > SUSTAINED_LIMIT) {
    const exceededResetMs = toExceededResetMs(nowMs, state, nextBurst, nextSustained);
    const retryAfterSeconds = secondsUntilReset(nowMs, exceededResetMs);
    const responseBody: RateLimitDecisionResponse = {
      allowed: false,
      limit: SUSTAINED_LIMIT,
      remaining: 0,
      resetSeconds: retryAfterSeconds,
      retryAfterSeconds
    };
    await storage.put(STATE_KEY, state);
    return Response.json(responseBody);
  }

  state.burst.count = nextBurst;
  state.sustained.count = nextSustained;
  await storage.put(STATE_KEY, state);
  return Response.json(buildAllowedDecision(nowMs, state));
}

async function handleInvalidIcaoRequest(
  request: Request,
  storage: DurableObjectStorageLike
): Promise<Response> {
  const body = (await parseBody<PenalizeRequestBody>(request)) ?? {};
  const nowMs = toSafeNow(body.nowMs);
  const state = await loadRateLimitState(storage, nowMs);

  state.invalidIcao.count += 1;
  let penalized = false;
  if (state.invalidIcao.count >= INVALID_ICAO_LIMIT) {
    state.penaltyUntilMs = Math.max(state.penaltyUntilMs, nowMs + INVALID_ICAO_PENALTY_SECONDS * 1000);
    state.invalidIcao = createWindow(nowMs, INVALID_ICAO_WINDOW_SECONDS);
    penalized = true;
  }

  await storage.put(STATE_KEY, state);
  return Response.json({ penalized } satisfies PenalizeResponse);
}

export class ApiRateLimiter {
  constructor(private readonly state: DurableObjectStateLike) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed.' }, { status: 405 });
    }

    if (url.pathname === '/check') {
      return handleCheckRequest(request, this.state.storage);
    }

    if (url.pathname === '/invalid-icao') {
      return handleInvalidIcaoRequest(request, this.state.storage);
    }

    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
}

export async function enforceRateLimit(
  namespace: DurableObjectNamespaceLike | undefined,
  clientId: string,
  endpoint: string
): Promise<RateLimitDecision> {
  if (!namespace) {
    return {
      allowed: true,
      headers: createAllowedHeaders()
    };
  }

  try {
    const id = namespace.idFromName(`rl:${clientId}:${endpoint}`);
    const stub = namespace.get(id);
    const response = await stub.fetch('https://rate-limiter.internal/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nowMs: Date.now() } satisfies CheckRequestBody)
    });

    if (!response.ok) {
      return {
        allowed: true,
        headers: createAllowedHeaders()
      };
    }

    const body = (await response.json()) as Partial<RateLimitDecisionResponse>;
    const decision: RateLimitDecisionResponse = {
      allowed: Boolean(body.allowed),
      limit: typeof body.limit === 'number' && body.limit > 0 ? body.limit : SUSTAINED_LIMIT,
      remaining: typeof body.remaining === 'number' && body.remaining >= 0 ? body.remaining : 0,
      resetSeconds: typeof body.resetSeconds === 'number' && body.resetSeconds > 0 ? body.resetSeconds : 1,
      retryAfterSeconds:
        typeof body.retryAfterSeconds === 'number' && body.retryAfterSeconds > 0 ? body.retryAfterSeconds : null
    };

    return {
      allowed: decision.allowed,
      headers: toHeadersFromDecision(decision)
    };
  } catch {
    return {
      allowed: true,
      headers: createAllowedHeaders()
    };
  }
}

export async function noteInvalidIcao(
  namespace: DurableObjectNamespaceLike | undefined,
  clientId: string,
  endpoint: string
): Promise<void> {
  if (!namespace) {
    return;
  }

  try {
    const id = namespace.idFromName(`rl:${clientId}:${endpoint}`);
    const stub = namespace.get(id);

    await stub.fetch('https://rate-limiter.internal/invalid-icao', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nowMs: Date.now() } satisfies PenalizeRequestBody)
    });
  } catch {
    // Best-effort abuse signal.
  }
}
