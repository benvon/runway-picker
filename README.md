# runway-picker

Runway Picker is a high-contrast, mobile-first web app for pilots to compare runway headwind and crosswind components from METAR wind data.

## Features

- ICAO-first input flow (primary airport + optional alternate for missing runway/weather data)
- Airport lookup via local API proxy (`/api/airport`) backed by the dedicated Cloudflare Worker
- METAR lookup via local API proxy (`/api/metar`) backed by a dedicated Cloudflare Worker
- Shared adapter-driven caching (edge cache + KV + Durable Object single-flight)
- Structured cache provenance metadata returned from `/api/metar` and `/api/airport` (`cache` object + `X-Runway-Cache-Status`)
- Sustained and gust component calculations for each runway
- Closed runways are always excluded from best-runway recommendation logic
- Best-runway selection by:
  1. greatest headwind
  2. lowest crosswind tie-break
  3. longest runway tie-break
  4. smallest runway number tie-break
  5. alphanumeric runway ID tie-break

## Local development

```bash
npm install
npm run dev
```

## Quality checks

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

## Cloudflare runtime

- Static frontend served by Cloudflare Pages (`dist`)
- Pages Functions API boundary under `functions/api/`
- API endpoints:
  - `/api/health`
  - `/api/airport?icao=KJFK`
  - `/api/metar?icao=KJFK`
- Dedicated Worker API backend:
  - `workers/metar-proxy/` (service name: `runway-picker-metar-api`)
  - Uses KV namespace binding `METAR_CACHE`

See setup details in [docs/cloudflare-setup.md](./docs/cloudflare-setup.md).
Cache design details are documented in [docs/cache-architecture.md](./docs/cache-architecture.md).

## CI/CD workflows

- `CI`: typecheck, lint, test, build on PRs and pushes to `main`
- `Release Tag`: on merged PRs to `main`, semver bump by branch prefix
  - `release/*` => major
  - `feature/*` => minor
  - other => patch
- `Deploy Preview`: generate preview-specific Wrangler config from GitHub vars, deploy Worker preview env, deploy Pages preview from PR branch ref, and comment URL
- `Deploy Production`: deploy on pushed tags (`v*.*.*`)
- `Deploy METAR Worker Production`: deploy METAR Worker on pushed tags (`v*.*.*`)

## Bootstrap release tag

Before automated tagging, create baseline tag once:

```bash
git tag -a v0.1.0 -m "Bootstrap v0.1.0"
git push origin v0.1.0
```
