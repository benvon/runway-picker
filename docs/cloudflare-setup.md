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
```
2. Copy the returned production ID into [`workers/metar-proxy/wrangler.jsonc`](../workers/metar-proxy/wrangler.jsonc):
   - `kv_namespaces[].id`
3. Ensure Durable Object bindings and migrations are present in [`workers/metar-proxy/wrangler.jsonc`](../workers/metar-proxy/wrangler.jsonc):
   - `durable_objects.bindings[]` contains `CACHE_COORDINATOR -> CacheSingleFlightCoordinator`
   - `durable_objects.bindings[]` contains `API_RATE_LIMITER -> ApiRateLimiter`
   - `migrations[]` includes:
     - `new_sqlite_classes: ["CacheSingleFlightCoordinator"]`
     - `new_sqlite_classes: ["ApiRateLimiter"]`
4. Deploy the worker:
```bash
npx wrangler deploy --config workers/metar-proxy/wrangler.jsonc
```
5. Confirm the worker name is `runway-picker-metar-api` (matches Pages service binding in root `wrangler.jsonc`).

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
```

## 4) Configure Wrangler
- `wrangler.jsonc` already contains:
  - `name: runway-picker`
  - `pages_build_output_dir: ./dist`
  - `compatibility_date: 2026-03-02`
  - strict static security headers via `public/_headers`
  - `services` binding:
    - `METAR_API` -> `runway-picker-metar-api`
- Preview Pages deployments use the checked-in production service binding. Preview workflow artifacts contain only the static frontend; no pull-request Worker code or AirportDB token is deployed.

## 5) Create API token and account settings
In Cloudflare:
1. Create an API token with Pages edit/deploy permissions for the account/project.
2. Copy account ID from Cloudflare dashboard.

In GitHub environment settings:
- Create a protected `preview` environment. Require reviewer approval and store a least-privilege `CLOUDFLARE_PREVIEW_API_TOKEN` scoped to Pages preview deployments, plus `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_PROJECT_NAME`.
- Create a protected `production` environment. Require reviewer approval, restrict it to the protected `main` branch, and store the production deployment credentials.
- Production environment secrets:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`
  - `AIRPORT_IO_TOKEN` (CI maps this into Worker secret key `AIRPORTDB_API_TOKEN`)
- Repository secrets:
  - `RELEASE_AUTOMATION_TOKEN` (bot/App token with `contents:write` to publish GitHub Releases)
- Environment variables:
  - `CLOUDFLARE_PROJECT_NAME` (exact Pages project name)

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
  - is triggered only after the PR CI run succeeds and runs trusted workflow code from `main`
  - downloads the CI-built `dist` artifact without checking out or executing PR code
  - waits for protected `preview` environment approval before it receives the least-privilege Pages credential
  - deploys Pages preview for the validated PR branch and commit
  - runs preview smoke tests against `/api/metar` to verify cache metadata contract and repeated-request cache reuse
  - runs browser E2E tests in a separate read-only job that checks out the PR test suite without persisted credentials or deployment secrets
  - comments preview URL on the PR

## 8) Release flow
- Merge PR to `main`.
- `Conventional PR Title` workflow enforces Conventional Commit PR titles.
- `Release Create` runs after successful `CI` push checks on `main` and computes next semver from commit signals:
  - `BREAKING CHANGE` footer or `!` in header => major
  - `feat` => minor
  - `fix`/`perf` => patch
  - all other commit types => no release
  - publishes a GitHub Release using `RELEASE_AUTOMATION_TOKEN`
- `.github/release.yml` defines the base structure for autogenerated GitHub release notes.
- `Release Create` publishes the release, then invokes the Pages and Worker production deploy workflows with the release tag and exact CI-green `main` SHA. Both workflows validate that the tag resolves to that SHA and wait for protected `production` environment approval.
- Release publication and production deployment remain separate concerns: a deployment failure is retried by re-running the protected release workflow jobs, without redefining the release artifact.

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
