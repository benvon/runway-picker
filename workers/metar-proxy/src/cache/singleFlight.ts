import type { DurableObjectNamespaceLike } from './types';

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

export class CacheSingleFlightCoordinator {
  constructor(private readonly state: DurableObjectStateLike) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed.' }, { status: 405 });
    }

    if (url.pathname === '/acquire') {
      const rawBody = (await request.json()) as unknown;

      const key =
        rawBody &&
        typeof rawBody === 'object' &&
        typeof (rawBody as { key?: unknown }).key === 'string'
          ? (rawBody as { key: string }).key
          : '';

      const holdSecondsValue =
        rawBody && typeof rawBody === 'object'
          ? (rawBody as { holdSeconds?: unknown }).holdSeconds
          : undefined;
      const holdSecondsNumber = Number(holdSecondsValue);

      if (!key || !Number.isFinite(holdSecondsNumber)) {
        return Response.json({ error: 'Invalid request body.' }, { status: 400 });
      }

      const now = Date.now();
      const lock = await this.state.storage.get<LockRecord>(key);

      if (lock && lock.expiresAtMs > now) {
        return Response.json({ acquired: false } satisfies AcquireResponse);
      }

      const safeHoldSeconds = Math.max(1, holdSecondsNumber);
      const token = createToken();
      await this.state.storage.put(key, {
        token,
        expiresAtMs: now + safeHoldSeconds * 1000
      } satisfies LockRecord);

      return Response.json({ acquired: true, token } satisfies AcquireResponse);
    }

    if (url.pathname === '/release') {
      const rawBody = (await request.json()) as unknown;

      const key =
        rawBody &&
        typeof rawBody === 'object' &&
        typeof (rawBody as { key?: unknown }).key === 'string'
          ? (rawBody as { key: string }).key
          : '';
      const token =
        rawBody &&
        typeof rawBody === 'object' &&
        typeof (rawBody as { token?: unknown }).token === 'string'
          ? (rawBody as { token: string }).token
          : '';

      if (!key || !token) {
        return Response.json({ error: 'Invalid request body.' }, { status: 400 });
      }

      const lock = await this.state.storage.get<LockRecord>(key);
      if (lock && lock.token === token) {
        await this.state.storage.delete(key);
      }
      return new Response(null, { status: 204 });
    }

    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
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
