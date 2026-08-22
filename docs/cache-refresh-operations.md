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
  1. Scan bounded pages for each resource. The global scan cap is ten times the effective refresh capacity, split between resources; unused budget from a short page is available to the other resource without exceeding that cap.
  2. Load and validate every listed metadata record before any entry is processed.
  3. Evict entries inactive longer than inactivity TTL (also purges cache payload key), then refresh due entries oldest-first within each resource and round-robin, up to the effective refresh capacity. When both resource types have due work, the first two refreshes are one METAR and one airport entry. A missing resource or lack of due work never creates work.
  4. Persist each next cursor or clear it after the resource scan wraps. A metadata, eviction, or checkpoint failure leaves the prior cursor in place for retry; an individual refresh failure is recorded and does not pin the scan.
  5. A scheduled refresh failure increments that entry's consecutive failure count. A successful scheduled refresh resets it. On the third consecutive scheduled failure, the worker removes only the hot-entry metadata; the payload cache remains subject to its normal TTL and a later client request can re-enqueue the ICAO.
- If a saved cursor is malformed (including invalid JSON) or KV specifically rejects it as invalid, the worker clears only that resource's cursor record, retries once from the beginning, and writes one `Scheduled cache refresh cursor checkpoint reset` warning. Transient KV/list communication failures retain a valid cursor for retry. Cursor recovery never deletes hot entries or cache payloads.
- A scheduled refresh resets its failure count only after a real upstream refresh. A stale-on-error fallback is recorded as a failed refresh; client access updates demand time only and never changes scheduled refresh outcome state.
- METAR payloads at or beyond 90 minutes from trusted `fetchedAt` are purged and never delivered. This payload safety cleanup does not remove hot demand metadata.

## Runtime controls

Configured in [`workers/metar-proxy/wrangler.jsonc`](../workers/metar-proxy/wrangler.jsonc):

- `CACHE_REFRESH_ENABLED` (`true`/`false`)
- `CACHE_REFRESH_METAR_INTERVAL_SECONDS` (default `1800`)
- `CACHE_REFRESH_AIRPORT_INTERVAL_SECONDS` (default `86400`)
- `CACHE_REFRESH_INACTIVITY_TTL_SECONDS` (default `432000`)
- `CACHE_REFRESH_MAX_ITEMS_PER_RUN` (default `25`; configured values below `2` are normalized to an effective capacity of `2`)

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

- Reduce `CACHE_REFRESH_MAX_ITEMS_PER_RUN` (first lever; `1` is still an effective capacity of `2`).
- Increase `CACHE_REFRESH_METAR_INTERVAL_SECONDS` and/or `CACHE_REFRESH_AIRPORT_INTERVAL_SECONDS`.
- Temporarily set `CACHE_REFRESH_ENABLED=false` during provider incidents.

### Queue growth without cleanup

- Verify `CACHE_REFRESH_INACTIVITY_TTL_SECONDS` is set and positive.
- Sample `v2:hot:*` keys and validate `lastAccessedAt` and scheduled failure fields.
- Ensure deployment includes recent scheduler code and env vars.

## Cost guardrails

Baseline scheduled invocations:

- `4` runs/hour * `24` hours/day * `30` days/month = `2,880` cron runs/month.

Approximate monthly refresh attempts for `N` continuously active ICAOs:

- `N * (METAR refreshes/day + Airport refreshes/day) * 30`
- Default intervals: `N * (48 + 1) * 30`
- Example (`N=100`): `100 * 49 * 30 = 147,000` refresh attempts/month

Primary cost levers:

1. `CACHE_REFRESH_MAX_ITEMS_PER_RUN` (minimum effective value: `2`)
2. METAR/airport refresh intervals
3. Inactivity TTL

When tuning, change one lever at a time and compare Cloudflare metrics over at least 24 hours.
