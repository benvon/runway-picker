# Cache Refresh Operations Runbook

This runbook covers the scheduled demand refresh system in
`workers/metar-proxy`. For data ownership and safety guarantees, see
[cache-architecture.md](./cache-architecture.md).

## Normal behavior

- Cloudflare runs the Worker cron every 15 minutes.
- Successful METAR and airport responses make a best-effort demand touch to
  `CACHE_COORDINATOR`; KV holds payloads only.
- `CACHE_COORDINATOR` owns demand expiry, active leases, failure counts, run
  claims, and suppression state in its SQLite storage. Do not attempt to
  reconstruct or edit this state in KV.
- Each run scans no more than ten times its effective refresh capacity and
  makes no more than `CACHE_REFRESH_MAX_ITEMS_PER_RUN` real upstream attempts.
  The default is 25 attempts per run.
- METAR and airport demand are scanned separately and selected in alternating
  order when both have work. This prevents one resource type from starving the
  other.
- A request touch updates demand expiry only. It does not make an entry fresh,
  reset a scheduler failure count, or reactivate a suppressed entry.

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
  failure and suppression state; stale-on-error and failed upstream work
  increment the count. Cache/KV and coordinator failures abort the run without
  mutating failure state.
- A valid negative-cache entry (for example, an airport 404) is not due for a
  scheduled refresh before its recorded expiry. It is retained rather than
  treated as malformed cache data.
- On the third consecutive failure, the coordinator suppresses the demand.
  The payload remains under normal cache policy, while cache-hit traffic cannot
  immediately re-enqueue the stuck background work. A later successful payload
  refresh reactivates it.
- An idempotent Durable Object alarm removes inactive demand rows and old run
  records, including while refresh is disabled.
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

Inspect one payload:

```bash
npx wrangler kv key get "v1:metar:KJFK" \
  --binding METAR_CACHE \
  --config workers/metar-proxy/wrangler.jsonc
```

Do not manually create, edit, or delete demand, lease, failure, or suppression
records. They live in `CACHE_COORDINATOR` and are intentionally not a KV
operator interface.

## Safe interventions

### Disable refresh during a provider incident

1. Set `CACHE_REFRESH_ENABLED=false`.
2. Deploy the Worker through the normal release process.
3. Continue serving requests according to the normal cache policy.
4. Monitor provider recovery and Worker errors; existing inactive demand rows
   are removed by the coordinator alarm.
5. Re-enable the refresher and deploy after stability is restored.

Demand records remain in coordinator SQLite while refresh is disabled. The
coordinator alarm continues to remove inactive records without a scheduler run
or a KV TTL, so disabling refresh does not create a manual cleanup burden.

There is no manual per-demand deletion procedure. If a specific demand must be
suppressed operationally, disable refresh while investigating the provider or
deploy a narrowly reviewed policy change; do not bulk-delete payload KV.

## Cost guardrails

There are about 2,880 scheduled invocations in a 30-day month. Refresh cost is
primarily controlled by active demand count, per-resource intervals, and the
per-run attempt cap. As a rough upper bound for `N` continuously active ICAOs
at default intervals:

`N × (48 METAR refreshes/day + 1 airport refresh/day) × 30 days`.

For 100 continuously active ICAOs, that is roughly 147,000 upstream refresh
attempts per month. Start tuning with `CACHE_REFRESH_MAX_ITEMS_PER_RUN`, then
refresh intervals, and finally inactivity TTL.
