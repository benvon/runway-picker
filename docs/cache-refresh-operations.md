# Cache Refresh Operations Runbook

This runbook covers day-2 operations for the scheduled hot-cache refresher in `workers/metar-proxy`.

## Scheduler behavior

- Worker cron trigger runs every `15` minutes (`*/15 * * * *`).
- Every successful `/api/metar` and `/api/airport` response updates a hot-entry key:
  - `v1:hot:metar:{ICAO}`
  - `v1:hot:airport:{ICAO}`
- Scheduled runs:
  1. Load hot entries.
  2. Evict entries inactive longer than inactivity TTL (also purges cache payload key).
  3. Refresh due entries (oldest first), up to `CACHE_REFRESH_MAX_ITEMS_PER_RUN`.
  4. Leave failed refreshes queued for later retries.

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

## Monitoring checklist

Use Cloudflare dashboard metrics for `runway-picker-metar-api`:

- `Cron Trigger Invocations`: should run every 15 minutes.
- `Worker Errors`: sustained increase indicates refresh failures or provider issues.
- `CPU Time`: monitor spikes when hot set grows.
- `KV Operations` (`METAR_CACHE`): watch read/write/delete trends after releases.

Operational API signal:

- Track `X-Runway-Cache-Status` distribution for `/api/metar` and `/api/airport`.
- A healthy pattern includes frequent `kv_hit`/`edge_hit`, with lower `upstream_refresh`.

## Manual inspection commands

List hot queue entries:

```bash
npx wrangler kv key list \
  --binding METAR_CACHE \
  --prefix "v1:hot:" \
  --config workers/metar-proxy/wrangler.jsonc
```

Inspect one hot-entry payload:

```bash
npx wrangler kv key get "v1:hot:metar:KJFK" \
  --binding METAR_CACHE \
  --config workers/metar-proxy/wrangler.jsonc
```

Inspect one cache payload:

```bash
npx wrangler kv key get "v1:metar:KJFK" \
  --binding METAR_CACHE \
  --config workers/metar-proxy/wrangler.jsonc
```

Remove a stuck hot-entry key (surgical cleanup):

```bash
npx wrangler kv key delete "v1:hot:metar:KJFK" \
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
- Sample `v1:hot:*` keys and validate `lastAccessedAt`/`lastRefreshedAt` fields.
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
