# Cache Architecture

This repository uses a shared, adapter-driven cache framework in the METAR Worker to protect upstream APIs and support future cacheable resources.

## Goals

- Reuse cache entries across users.
- Minimize upstream calls for expensive APIs.
- Support stale serving when upstream is slow or unavailable.
- Add new resources (airport info and future data sources) without rewriting cache orchestration.

## Request flow

For each resource request, the worker executes this sequence:

1. Normalize input and build a versioned cache key: `v1:{resource}:{normalizedKey}`.
2. Check edge cache (`caches.default`).
3. Check KV (`METAR_CACHE`).
4. If missing/expired, acquire a per-key lock via Durable Object (`CACHE_COORDINATOR`).
5. Only the lock owner refreshes upstream and writes cache.
6. Non-owners either:
   - wait for a fresh KV write, or
   - serve stale when allowed by policy.

## Cache metadata contract

Successful API responses include a `cache` object with:

- `status`: `edge_hit`, `kv_hit`, `upstream_refresh`, `stale_while_refresh`, `stale_on_error`
- `source`: `edge`, `kv`, `upstream`, `stale`
- `ageSeconds`
- `fetchedAt`
- `servedAt`
- `ttlSeconds`
- `key`
- `resource`

Headers:

- `X-Runway-Cache-Status`: canonical status header.

## Adapter model

Each resource adapter implements:

- `resource`
- `normalizeKey(input)`
- `fetchUpstream(input, ctx)`
- `validate(upstream, input, ctx)`
- `serialize(data, key, resource)`
- `deserialize(cached)`
- `policy` (`ttlSeconds`, `staleWhileRevalidateSeconds`, `staleOnErrorSeconds`, `negativeCacheTtlSeconds`, `policyVersion`)
- `observability(input, key)`

Registered adapters live in:

- `workers/metar-proxy/src/resources/index.ts`

Current adapters:

- `metar`
- `airport` (AirportDB-backed; daily-refresh policy)

## Adding a new resource

1. Create `workers/metar-proxy/src/resources/<resource>/adapter.ts` implementing the adapter interface.
2. Add the adapter to `workers/metar-proxy/src/resources/index.ts`.
3. Add route handler wiring (if exposing a new endpoint).
4. Add tests:
   - adapter contract tests
   - engine behavior tests for the resource policy
   - endpoint tests for response and cache metadata
5. Choose policy values according to upstream constraints:
   - daily-refresh sources should use longer TTLs and stale windows.

## Runtime bindings

`workers/metar-proxy/wrangler.jsonc` requires:

- KV namespace binding: `METAR_CACHE`
- Durable Object binding: `CACHE_COORDINATOR`
- migration entry for `CacheSingleFlightCoordinator`

The preview environment also binds `CACHE_COORDINATOR`.

## Operations

- Scheduler monitoring and operational procedures are in [cache-refresh-operations.md](./cache-refresh-operations.md).
