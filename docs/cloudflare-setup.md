# Cloudflare Pages + Functions Setup Guide

This guide matches the repository workflows and runtime shape.

## 1) Create Pages project
1. In Cloudflare Dashboard, go to **Workers & Pages**.
2. Create a **Pages** project and connect this GitHub repository.
3. Set build command to `npm run build`.
4. Set build output directory to `dist`.

## 2) Confirm Functions directory
- This repo uses `functions/` for Pages Functions.
- `functions/api/health.ts` provides a starter API endpoint at `/api/health`.
- `functions/api/metar.ts` is a proxy endpoint to the dedicated Worker API at `/api/metar?icao=KJFK`.
- `functions/api/airport.ts` is a proxy endpoint to the dedicated Worker API at `/api/airport?icao=KJFK`.

## 3) Provision and deploy the METAR Worker
1. Create a KV namespace for shared METAR cache:
```bash
npx wrangler kv namespace create METAR_CACHE
npx wrangler kv namespace create METAR_CACHE --preview
```
2. Copy the returned production ID into [`workers/metar-proxy/wrangler.jsonc`](../workers/metar-proxy/wrangler.jsonc):
   - `kv_namespaces[].id`
3. Keep `env.preview.kv_namespaces[]` binding-only in repo config (`{ "binding": "METAR_CACHE" }`).
4. Ensure Durable Object bindings and migrations are present in [`workers/metar-proxy/wrangler.jsonc`](../workers/metar-proxy/wrangler.jsonc):
   - `durable_objects.bindings[]` contains `CACHE_COORDINATOR -> CacheSingleFlightCoordinator`
   - `durable_objects.bindings[]` contains `API_RATE_LIMITER -> ApiRateLimiter`
   - `migrations[]` includes:
     - `new_sqlite_classes: ["CacheSingleFlightCoordinator"]`
     - `new_sqlite_classes: ["ApiRateLimiter"]`
5. Save the preview KV namespace ID as GitHub variable `CLOUDFLARE_METAR_CACHE_PREVIEW_NAMESPACE_ID` (used by preview deploy workflow to generate runtime config).
6. Deploy the worker:
```bash
npx wrangler deploy --config workers/metar-proxy/wrangler.jsonc
```
7. Deploy the preview worker environment:
```bash
npx wrangler deploy --config workers/metar-proxy/wrangler.jsonc --env preview
```
8. Confirm the worker name is `runway-picker-metar-api` (matches Pages service binding in root `wrangler.jsonc`).

Worker behavior:
- Upstream source: `https://aviationweather.gov/api/data/metar`
- Upstream user agent: `benvon-runway-picker`
- Airport source: `https://airportdb.io/api/v1/airport/{ICAO}?apiToken={TOKEN}`
- Shared cache stores: edge cache + Worker KV (`METAR_CACHE`)
- Single-flight refresh coordinator: Durable Object (`CACHE_COORDINATOR`)
- Public abuse protection: Durable Object rate limiter (`API_RATE_LIMITER`)
- Cache TTL: 30 minutes (with stale windows configured in adapter policy)
- Airport cache TTL: 24 hours (with stale windows configured in adapter policy)
- Direct `workers.dev` access is disabled (`workers_dev: false`) to reduce public exposure; use Pages service binding.
- Configure the AirportDB token in Worker secrets (never in client code):
```bash
npx wrangler secret put AIRPORTDB_API_TOKEN --config workers/metar-proxy/wrangler.jsonc
npx wrangler secret put AIRPORTDB_API_TOKEN --config workers/metar-proxy/wrangler.jsonc --env preview
```

## 4) Configure Wrangler
- `wrangler.jsonc` already contains:
  - `name: runway-picker`
  - `pages_build_output_dir: ./dist`
  - `compatibility_date: 2026-03-02`
  - strict static security headers via `public/_headers`
  - `services` binding:
    - `METAR_API` -> `runway-picker-metar-api`
- Worker runtime env flags are configured in `workers/metar-proxy/wrangler.jsonc`:
  - production: `APP_ENV=production`, `ENABLE_DEBUG_ERRORS=false`
  - preview: `APP_ENV=preview`, `ENABLE_DEBUG_ERRORS=true`
- Preview service binding is generated in CI as:
  - `METAR_API` -> `${CLOUDFLARE_METAR_WORKER_NAME:-runway-picker-metar-api}-preview`

## 5) Create API token and account settings
In Cloudflare:
1. Create an API token with Pages edit/deploy permissions for the account/project.
2. Copy account ID from Cloudflare dashboard.

In GitHub repo settings:
- Secrets:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`
  - `AIRPORT_IO_TOKEN` (CI maps this into Worker secret key `AIRPORTDB_API_TOKEN`)
- Variables:
  - `CLOUDFLARE_PROJECT_NAME` (exact Pages project name)
  - `CLOUDFLARE_METAR_CACHE_PREVIEW_NAMESPACE_ID` (preview KV namespace ID from `wrangler kv namespace create ... --preview`)
  - Optional `CLOUDFLARE_METAR_WORKER_NAME` (defaults to `runway-picker-metar-api`)

## 6) Validate locally
Run:
```bash
npm install
npm run test
npm run build
npx wrangler pages dev dist
```
Open local URL and verify:
- UI renders
- calculator works
- `/api/health` returns JSON
- `/api/airport?icao=KJFK` returns airport JSON with runway ends + `cache` metadata and `X-Runway-Cache-Status`
- `/api/metar?icao=KJFK` returns METAR JSON with `cache` metadata and `X-Runway-Cache-Status`

## 7) CI and preview deployment
- Open a PR to `main`.
- `CI` workflow runs typecheck/lint/test/build.
- `Deploy Preview` workflow:
  - generates temporary preview wrangler configs from GitHub variables
  - deploys Worker env `preview` with preview KV namespace ID from `CLOUDFLARE_METAR_CACHE_PREVIEW_NAMESPACE_ID`
  - deploys Pages preview for the PR branch ref (`github.event.pull_request.head.ref`)
  - runs preview smoke tests against `/api/metar` to verify cache metadata contract and repeated-request cache reuse
  - binds `METAR_API` to `${CLOUDFLARE_METAR_WORKER_NAME:-runway-picker-metar-api}-preview`
  - comments preview URL on the PR

## 8) Release flow
- Merge PR to `main`.
- `Conventional PR Title` workflow enforces Conventional Commit PR titles.
- `Release Create` runs after successful `CI` push checks on `main` and computes next semver from commit signals:
  - `BREAKING CHANGE` footer or `!` in header => major
  - `feat` => minor
  - `fix`/`perf` => patch
  - all other commit types => no release
- `.github/release.yml` defines the base structure for autogenerated GitHub release notes.
- Published stable GitHub Releases trigger:
  - `Deploy Production` (Pages app)
  - `Deploy METAR Worker Production` (Worker API)

## 9) Branch protections (recommended)
In GitHub branch protection for `main`:
- Require pull request before merge
- Require squash merge strategy for release signal consistency
- Require status checks:
  - `Conventional PR Title / conventional-pr-title`
  - `CI / validate`
  - `CI / security`
  - `CI / codeql (javascript-typescript)`
- Prevent direct pushes

## 10) Cache refresher operations
- The hot-cache scheduler runbook is documented in [docs/cache-refresh-operations.md](./cache-refresh-operations.md).
- Use it for monitoring, troubleshooting, and cost tuning of the scheduled cache refresh process.
