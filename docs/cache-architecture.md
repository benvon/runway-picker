# Cache Architecture

The METAR Worker uses a Cloudflare-native, adapter-driven cache. Its design has
two deliberately separate concerns:

1. serve validated resource data safely and efficiently; and
2. refresh recently requested data fairly, without allowing cache bookkeeping to
   corrupt request behavior.

The boundary is important: cached payloads and client demand live in KV, while
the Durable Object owns the small amount of state that needs atomic updates.

## Design goals

- Reuse validated data across users and avoid unnecessary provider traffic.
- Fail safely when a cached record is malformed, too old, or inconsistent with
  the request.
- Permit bounded stale serving where a resource policy allows it, but never
  extend a hard payload-age limit.
- Keep client demand independent of refresh scheduling so a busy client cannot
  overwrite scheduler state.
- Make scheduled refreshes bounded, fair between METAR and airport data, and
  recoverable after a Worker, KV, or provider failure.

## Components and ownership

| Component | Owns | Does not own |
| --- | --- | --- |
| Edge cache (`caches.default`) | Disposable local copy of a validated payload | Scheduler state or source of truth |
| KV (`METAR_CACHE`) | Versioned payload envelopes and hot-demand records | Cursors, leases, or refresh failure counters |
| `CACHE_COORDINATOR` Durable Object | Per-key single-flight locks and one durable scheduler state machine | Cached payload bodies or client demand |
| Resource adapter | Input normalization, provider access, data validation, and resource policy | Cross-resource scheduling |

This split is intentional. KV is excellent for read-heavy payload data and
short-lived demand hints, but it is not used as a compare-and-swap coordination
store. The Durable Object provides serialized, durable transitions for the
state that must not race: active scheduler ownership, opaque continuations,
failure counts, and pending removals. No external cache service, queue, or
additional namespace is required.

## Request path

For a cacheable request, the Worker:

1. normalizes the input and derives a versioned key such as
   `v1:metar:KJFK`;
2. checks the edge cache, then KV;
3. validates every reusable envelope before delivery;
4. on a miss or unusable copy, obtains a token-bound, per-key single-flight
   lease from `CACHE_COORDINATOR`;
5. lets only the lease owner call the provider and write the new envelope;
6. lets other requests wait briefly for the fresh KV entry or use stale data
   only when the resource policy permits it; and
7. records successful client access as a best-effort, independent hot-demand
   update. A demand-write failure never fails the user request.

The cache engine, rather than a resource adapter, writes authoritative envelope
metadata. On both edge and KV reads it checks envelope identity, resource,
policy version, canonical timestamps, and the resource validity horizon.
Malformed or incompatible copies are cache misses and are removed best-effort;
cleanup failure never makes an invalid copy deliverable.

## Payload freshness and public contract

Successful API responses include a `cache` object with `status`, `source`,
`ageSeconds`, `fetchedAt`, `expiresAt`, `maxPayloadAgeSeconds`,
`freshnessRemainingSeconds`, `servedAt`, `ttlSeconds`, `key`, and `resource`.
`X-Runway-Cache-Status` carries the same canonical status in a header.

Fresh response headers are derived from remaining freshness and cap downstream
`max-age` at 60 seconds. Stale and zero-remaining responses are `no-store`, so
a downstream cache cannot lengthen the Worker policy.

METAR has a 30-minute fresh interval and a strict 90-minute payload-age limit
measured from trusted `fetchedAt`. At or beyond that hard limit, METAR data is
not served—even during an upstream outage. The Worker removes payload copies
from KV and edge cache when possible, while retaining demand metadata so a
later scheduler run or client request can recover the entry. Airport policies
are defined by their adapter and are independent of METAR's hard limit.

## Hot demand and scheduled refresh

Only successful `/api/metar` and `/api/airport` responses enter the hot set.
The KV record is a schema-5 demand record at:

- `v2:hot:metar:{ICAO}`
- `v2:hot:airport:{ICAO}`

It contains only the resource identity and `lastAccessedAt`. It does **not**
contain a payload timestamp, refresh cursor, lease, or failure count. A client
touch therefore cannot undo a concurrent scheduler outcome. Older hot-record
shapes are accepted only for lazy migration and are rewritten on their next
safe demand update.

A cron runs every 15 minutes. It obtains the named scheduler lease from
`CACHE_COORDINATOR`, then:

1. scans bounded pages for METAR and airport demand independently, using the
   durable per-resource cursor held by the Durable Object;
2. validates raw-text metadata defensively; malformed metadata is removed or
   skipped, while a real KV operation failure aborts the run without advancing
   its cursor;
3. rechecks inactivity before eviction to avoid racing a client touch;
4. derives due state from the validated payload envelope—not from demand
   metadata—and selects the oldest due work in alternating resource order;
5. performs at most the configured number of real upstream attempts (25 by
   default); cache hits and contention are neutral and do not consume this
   budget;
6. renews its token-bound scheduler lease after each processed entry, commits
   cursor movement and typed outcomes atomically, then releases ownership; and
7. asks the Durable Object to process pending demand removals. The coordinator
   serializes the full scheduler protocol, including KV demand deletion, with
   later client demand writes.

The initial lease is 300 seconds, which covers the default maximum of 25
sequential ten-second attempts. Each processed entry renews a 60-second lease
with the active run token. If renewal or commit fails, the Worker aborts without
committing new cursors or outcomes; another cron can retry safely. Every
upstream attempt, including METAR station validation, receives the same
10-second abort signal.

## Failure and recovery semantics

An actual upstream refresh resets that entry's failure count. A stale-on-error
result or a failure after a provider attempt increments it. Client accesses and
cache hits are neutral and never change the count. Cache reads/writes,
single-flight coordination, and other scheduler infrastructure failures abort
the run instead: they do not increment a provider-failure count or advance its
cursors.

After three consecutive upstream failures, the Durable Object persists a
pending-dequeue intent while retaining the failure state. The coordinator itself
deletes only the KV demand entry (not the payload) and clears that intent only
after KV confirms the deletion. If deletion fails, a later scheduled run
retries it with the same durable intent. A new client access is also serialized
through the coordinator: it clears an older pending intent before writing its
new demand projection, so a stale removal can never delete newly re-enqueued
demand.

The scheduler also fails closed when its coordinator is unavailable or already
owned. An invalid opaque KV cursor is retried once from the resource prefix;
transient KV/list errors leave the old cursor intact. Cursor recovery never
deletes a payload or demand record.

## Why this approach is sound

The architecture uses Cloudflare primitives for the responsibilities they are
good at: KV provides inexpensive cache data and the Durable Object serializes
the small authoritative control plane. Keeping those roles separate prevents
the lost-update and stale-checkpoint failures that arise when client touches,
cursor movement, and failure accounting share one eventually consistent KV
record.

The scheduler has explicit bounds (scan cap, attempt cap, per-attempt timeout,
lease renewal, and completed-run retention), typed outcomes, and serialized
demand mutations. Validation is at the cache trust boundary, so malformed or
future/incompatible data is not made safe by accident. These are concrete
properties covered by regression tests for slow runs, lease loss, corrupt
metadata, cursor recovery, concurrent touches, and failed dequeue deletion.

This is intentionally a small custom policy layer, not a reimplementation of a
general cache service. It contains the application-specific contracts that a
generic HTTP cache cannot know: resource validation, the METAR hard-age rule,
fairness between resource types, and the three-failure dequeue policy.

## Adapter model and extension

Each adapter defines `resource`, `normalizeKey`, `fetchUpstream`, `validate`,
`serialize`, `deserialize`, `policy`, and `observability`. `deserialize` is a
trust boundary: it must prove every semantic invariant required for a safely
reusable response. Tightening an invariant requires a policy/schema-version
bump so incompatible records refresh.

To add a hot-refreshed resource, add an adapter and route, define its policy,
register it, and add adapter, engine, endpoint, and scheduler tests. The full
refresh input must be reconstructable from the normalized key; variants with
different payload contracts are separate resources. Long-lived reference data
such as `airport-location` remains outside the hot scheduler.

## Runtime bindings and operations

`workers/metar-proxy/wrangler.jsonc` binds `METAR_CACHE` and
`CACHE_COORDINATOR`; preview uses the corresponding isolated bindings. The
coordinator is a SQLite-backed Durable Object declared by the
`v1-cache-coordinator` migration.

Operational controls, diagnostics, and safe intervention procedures are in
[cache-refresh-operations.md](./cache-refresh-operations.md).
