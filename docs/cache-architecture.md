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
- `expiresAt`
- `freshnessRemainingSeconds` (whole seconds remaining, capped to the resource policy TTL)
- `servedAt`
- `ttlSeconds`
- `key`
- `resource`

Headers:

- `X-Runway-Cache-Status`: canonical status header.
- Successful fresh responses use `Cache-Control` values derived from
  `freshnessRemainingSeconds` (`max-age` is capped at 60 seconds). Stale or
  zero-remaining responses use `no-store`, so downstream caches cannot extend
  the cache engine's freshness policy.

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

`deserialize(cached)` is a cache trust boundary. It must validate every
semantic invariant required for a response to be safely reused (including that
the cached identity exactly matches the normalized request key). Tightening an
invariant requires a schema-version bump so incompatible records are refreshed.
For METAR records, this includes agreement among the envelope key, cached ICAO,
and the station token anchored at the start of the raw observation.

Registered adapters live in:

- `workers/metar-proxy/src/resources/index.ts`

Current adapters:

- `metar`
- `airport` (AirportDB-backed; daily-refresh policy)
- `airport-location` (AirportDB-backed reference coordinates; long-lived and intentionally excluded from the hot-refresh queue)

The hot-refresh queue is only for resources whose complete refresh input can be reconstructed from a normalized ICAO key. Resource variants with different payload contracts must be modeled as distinct resources, not query-mode flags on a shared cache key.

Hot metadata uses a versioned namespace (`v2:hot:*`) and stores only resource
plus normalized key. The scheduler derives the payload key from that canonical
identity, rather than trusting a separately persisted cache key. Older queue
namespaces are deliberately not scanned and expire through their existing KV
inactivity TTL.

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
