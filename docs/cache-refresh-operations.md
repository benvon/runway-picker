# Cache Refresh Operations Runbook

This runbook covers day-2 operations for the scheduled hot-cache refresher in `workers/metar-proxy`.

## Scheduler behavior

- Worker cron trigger runs every `15` minutes (`*/15 * * * *`).
- Every successful `/api/metar` and `/api/airport` response updates a hot-entry key:
  - `v2:hot:metar:{ICAO}`
  - `v2:hot:airport:{ICAO}`
- Queue metadata contains only the resource and normalized ICAO. The worker derives the payload cache key, so queue metadata cannot redirect a refresh to another resource or payload variant. Legacy `v1:hot:*` entries are not scanned and expire using their already-written inactivity TTL; no manual migration or cleanup is required.
- Each resource is scanned independently (`v2:hot:metar:` and `v2:hot:airport:`). Its opaque continuation is stored separately at `v2:control:hot-refresh-cursor:{resource}`, outside the hot-entry namespace. These two small control records are scheduler state only; they never contain payload keys or airport/METAR data.
- `/api/airport-location` is deliberately not hot-refreshed. It is long-lived reference data and has its own normal cache policy, so it cannot be accidentally refreshed as a runway profile.
- Scheduled runs:
  1. Scan bounded pages for each resource. The global scan cap is ten times `CACHE_REFRESH_MAX_ITEMS_PER_RUN`, split between resources; unused budget from a short page is available to the other resource without exceeding that cap.
  2. Persist each next cursor immediately after a successful page read, or clear it after the resource scan wraps. A failed item refresh therefore cannot pin a scan at the same page.
  3. Evict entries inactive longer than inactivity TTL (also purges cache payload key).
  4. Sort due entries oldest-first within each resource and refresh them round-robin, up to `CACHE_REFRESH_MAX_ITEMS_PER_RUN`.
  5. Leave failed refreshes queued for later retries.
- If a saved cursor is malformed or rejected by KV, the worker clears only that resource's cursor record, retries once from the beginning, and writes one `Scheduled cache refresh cursor checkpoint reset` warning. It does not delete hot entries or cache payloads during cursor recovery.

## Runtime controls

Configured in [`workers/metar-proxy/wrangler.jsonc`](../workers/metar-proxy/wrangler.jsonc):

- `CACHE_REFRESH_ENABLED` (`true`/`false`)
- `CACHE_REFRESH_METAR_INTERVAL_SECONDS` (default `1800`)
- `CACHE_REFRESH_AIRPORT_INTERVAL_SECONDS` (default `86400`)
- `CACHE_REFRESH_INACTIVITY_TTL_SECONDS` (default `432000`)
- `CACHE_REFRESH_MAX_ITEMS_PER_RUN` (default `25`)

Emergency stop:

1. Set `CACHE_REFRESH_ENABLED=false`.
2. Deploy worker.
3. Re-enable after upstream/provider stability is restored.

   > Note: Disabling the refresher also stops inactivity-based eviction (eviction runs inside the scheduled job). During an extended emergency stop, hot-entry keys will not be purged for inactivity and the hot queue/KV usage can grow over time. Consider ensuring hot-entry keys have an appropriate KV TTL and monitor hot-set size while the refresher is disabled.
> **Note:** Disabling the refresher also stops inactivity-based eviction (eviction runs inside the scheduled job). During an extended emergency stop, hot-entry keys will not be purged for inactivity by the scheduler. Hot-entry keys do carry a KV TTL aligned to `CACHE_REFRESH_INACTIVITY_TTL_SECONDS` so they will eventually self-expire, but monitor hot-set size via KV list counts while the refresher is disabled to avoid unexpected growth.

## Monitoring checklist

Use Cloudflare dashboard metrics for `runway-picker-metar-api`:

- `Cron Trigger Invocations`: should run every 15 minutes.
- `Worker Errors`: indicates unexpected worker or runtime faults; individual cache refresh failures are caught and logged (not surfaced as Worker Errors — check Worker logs for `Scheduled cache refresh failed` entries instead).
- `CPU Time`: monitor spikes when hot set grows.
- `KV Operations` (`METAR_CACHE`): watch read/write/delete trends after releases and correlate with `X-Runway-Cache-Status` patterns to infer refresh health.

Operational API signal:

- Track `X-Runway-Cache-Status` distribution for `/api/metar` and `/api/airport`.
- A healthy pattern includes frequent `kv_hit`/`edge_hit`, with lower `upstream_refresh`.

## Manual inspection commands

List hot queue entries:

```bash
npx wrangler kv key list \
  --binding METAR_CACHE \
  --prefix "v2:hot:" \
  --config workers/metar-proxy/wrangler.jsonc
```

Inspect one hot-entry payload:

```bash
npx wrangler kv key get "v2:hot:metar:KJFK" \
  --binding METAR_CACHE \
  --config workers/metar-proxy/wrangler.jsonc
```

Inspect one cache payload:

```bash
npx wrangler kv key get "v1:metar:KJFK" \
  --binding METAR_CACHE \
  --config workers/metar-proxy/wrangler.jsonc
```

Inspect a resource scan cursor (normally absent immediately after a full scan):

```bash
npx wrangler kv key get "v2:control:hot-refresh-cursor:metar" \
  --binding METAR_CACHE \
  --config workers/metar-proxy/wrangler.jsonc
```

Remove a stuck hot-entry key (surgical cleanup):

```bash
npx wrangler kv key delete "v2:hot:metar:KJFK" \
  --binding METAR_CACHE \
  --config workers/metar-proxy/wrangler.jsonc
```

## Troubleshooting playbook

### Cron not running

- Confirm `triggers.crons` exists in Worker config.
- Confirm latest deploy succeeded.
- Check dashboard invocation chart for gaps.

### High upstream traffic / higher cost than expected

- Reduce `CACHE_REFRESH_MAX_ITEMS_PER_RUN` (first lever).
- Increase `CACHE_REFRESH_METAR_INTERVAL_SECONDS` and/or `CACHE_REFRESH_AIRPORT_INTERVAL_SECONDS`.
- Temporarily set `CACHE_REFRESH_ENABLED=false` during provider incidents.

### Queue growth without cleanup

- Verify `CACHE_REFRESH_INACTIVITY_TTL_SECONDS` is set and positive.
- Sample `v2:hot:*` keys and validate `lastAccessedAt`/`lastRefreshedAt` fields.
- Ensure deployment includes recent scheduler code and env vars.

## Cost guardrails

Baseline scheduled invocations:

- `4` runs/hour * `24` hours/day * `30` days/month = `2,880` cron runs/month.

Approximate monthly refresh attempts for `N` continuously active ICAOs:

- `N * (METAR refreshes/day + Airport refreshes/day) * 30`
- Default intervals: `N * (48 + 1) * 30`
- Example (`N=100`): `100 * 49 * 30 = 147,000` refresh attempts/month

Primary cost levers:

1. `CACHE_REFRESH_MAX_ITEMS_PER_RUN`
2. METAR/airport refresh intervals
3. Inactivity TTL

When tuning, change one lever at a time and compare Cloudflare metrics over at least 24 hours.
