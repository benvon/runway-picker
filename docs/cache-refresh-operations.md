# Cache Refresh Operations Runbook

This runbook covers the scheduled demand refresh system in
`workers/metar-proxy`. For data ownership and safety guarantees, see
[cache-architecture.md](./cache-architecture.md).

## Normal behavior

- Cloudflare runs the Worker cron every 15 minutes.
- Successful METAR and airport responses record a short demand record in KV:
  `v2:hot:metar:{ICAO}` or `v2:hot:airport:{ICAO}`.
- `CACHE_COORDINATOR` owns the scheduler cursor, active lease, failure count,
  and pending-dequeue intent. Do not attempt to reconstruct or edit that state
  in KV.
- Each run scans no more than ten times its effective refresh capacity and
  makes no more than `CACHE_REFRESH_MAX_ITEMS_PER_RUN` real upstream attempts.
  The default is 25 attempts per run.
- METAR and airport demand are scanned separately and selected in alternating
  order when both have work. This prevents one resource type from starving the
  other.
- A request touch updates demand only. It does not make an entry fresh or reset
  a scheduler failure count.

## Runtime controls

Configured in [`workers/metar-proxy/wrangler.jsonc`](../workers/metar-proxy/wrangler.jsonc):

| Variable | Default | Effect |
| --- | ---: | --- |
| `CACHE_REFRESH_ENABLED` | `true` | Enables scheduled scanning and refresh. |
| `CACHE_REFRESH_METAR_INTERVAL_SECONDS` | `1800` | METAR refresh interval. |
| `CACHE_REFRESH_AIRPORT_INTERVAL_SECONDS` | `86400` | Airport refresh interval. |
| `CACHE_REFRESH_INACTIVITY_TTL_SECONDS` | `432000` | Demand-record TTL and inactivity eviction interval. |
| `CACHE_REFRESH_MAX_ITEMS_PER_RUN` | `25` | Maximum real upstream attempts; values below 2 become 2. |

Change one control at a time and observe metrics for at least 24 hours before
making another tuning change. Changes require a Worker deployment.

## Failure behavior

- Each upstream attempt has a 10-second abortable timeout, including METAR
  station validation.
- The scheduler starts with a 300-second lease and renews a token-bound
  60-second lease after each processed entry. A lost renewal aborts the run
  without committing progress.
- A cache hit or contention result is neutral. A true upstream refresh clears
  that entry's failure count; stale-on-error and failed upstream work increment
  it.
- On the third consecutive failure, the demand record is queued for removal.
  Its payload remains under normal cache policy. The coordinator performs the
  KV deletion itself, retains the removal intent until KV confirms it, and
  serializes a later client re-enqueue ahead of any stale removal attempt.
  A transient delete failure is retried rather than resetting the count.
- Invalid JSON or malformed demand metadata is removed/skipped. A genuine KV
  list/read failure stops the run and leaves the prior cursor in place.
- An invalid opaque cursor is retried once from the resource prefix. A
  transient KV failure is not a cursor-reset condition.
- METAR data at or beyond the 90-minute hard payload age is never returned.

## Monitoring checklist

Use the Cloudflare dashboard for `runway-picker-metar-api`:

- `Cron Trigger Invocations`: one roughly every 15 minutes.
- `Worker Errors`: unexpected runtime/coordinator errors. Individual provider
  failures are caught and logged; check logs for scheduled-refresh messages.
- `CPU Time`: unexpected growth can indicate a large or malformed hot set.
- `KV Operations` for `METAR_CACHE`: compare reads/writes/deletes with release
  timing and the active demand set.
- `X-Runway-Cache-Status`: healthy traffic normally contains mostly `edge_hit`
  and `kv_hit`, with fewer `upstream_refresh` responses.

Investigate repeated messages such as:

- `Scheduled cache refresh coordinator unavailable or busy.`
- `Scheduled cache refresh coordinator lease renewal failed.`
- `Scheduled cache refresh demand deletion will retry.`
- `Malformed hot cache demand entry removed.`
- `Scheduled cache refresh cursor checkpoint reset.`

The logs intentionally include resource/category context but not opaque cursor
values or payload contents.

## Manual inspection

List active demand records:

```bash
npx wrangler kv key list \
  --binding METAR_CACHE \
  --prefix "v2:hot:" \
  --config workers/metar-proxy/wrangler.jsonc
```

Inspect one demand record:

```bash
npx wrangler kv key get "v2:hot:metar:KJFK" \
  --binding METAR_CACHE \
  --config workers/metar-proxy/wrangler.jsonc
```

Inspect one payload:

```bash
npx wrangler kv key get "v1:metar:KJFK" \
  --binding METAR_CACHE \
  --config workers/metar-proxy/wrangler.jsonc
```

Do not manually create, edit, or delete scheduler cursors, leases, or failure
records. Those live in `CACHE_COORDINATOR` and are intentionally not a KV
operator interface.

## Safe interventions

### Disable refresh during a provider incident

1. Set `CACHE_REFRESH_ENABLED=false`.
2. Deploy the Worker through the normal release process.
3. Continue serving requests according to the normal cache policy.
4. Monitor `v2:hot:` count and provider recovery.
5. Re-enable the refresher and deploy after stability is restored.

Demand records have a KV TTL matching the inactivity setting, so they will
eventually expire while the refresher is disabled. The scheduler's inactivity
eviction is also disabled, however, so do not leave it off longer than needed.

### Remove one abusive or obsolete demand entry

Only when there is a specific, confirmed key:

```bash
npx wrangler kv key delete "v2:hot:metar:KJFK" \
  --binding METAR_CACHE \
  --config workers/metar-proxy/wrangler.jsonc
```

This stops scheduled refresh for that key. It does not delete the payload; a
later successful client request can re-enqueue it. Do not bulk-delete the hot
prefix or the whole KV namespace as a response to a scheduler incident.

## Cost guardrails

There are about 2,880 scheduled invocations in a 30-day month. Refresh cost is
primarily controlled by active demand count, per-resource intervals, and the
per-run attempt cap. As a rough upper bound for `N` continuously active ICAOs
at default intervals:

`N × (48 METAR refreshes/day + 1 airport refresh/day) × 30 days`.

For 100 continuously active ICAOs, that is roughly 147,000 upstream refresh
attempts per month. Start tuning with `CACHE_REFRESH_MAX_ITEMS_PER_RUN`, then
refresh intervals, and finally inactivity TTL.
