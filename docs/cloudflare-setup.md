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

## 3) Provision and deploy the METAR Worker
1. Create a KV namespace for shared METAR cache:
```bash
npx wrangler kv namespace create METAR_CACHE
npx wrangler kv namespace create METAR_CACHE --preview
```
2. Copy the returned IDs into [`workers/metar-proxy/wrangler.jsonc`](../workers/metar-proxy/wrangler.jsonc):
   - `kv_namespaces[].id`
   - `env.preview.kv_namespaces[].id`
3. Deploy the worker:
```bash
npx wrangler deploy --config workers/metar-proxy/wrangler.jsonc
```
4. Deploy the preview worker environment:
```bash
npx wrangler deploy --config workers/metar-proxy/wrangler.jsonc --env preview
```
5. Confirm the worker name is `runway-picker-metar-api` (matches Pages service binding in root `wrangler.jsonc`).

Worker behavior:
- Upstream source: `https://aviationweather.gov/api/data/metar`
- Upstream user agent: `benvon-runway-picker`
- Shared cache store: Worker KV (`METAR_CACHE`)
- Cache TTL: 30 minutes

## 4) Configure Wrangler
- `wrangler.jsonc` already contains:
  - `name: runway-picker`
  - `pages_build_output_dir: ./dist`
  - `compatibility_date: 2026-03-02`
  - `services` binding:
    - `METAR_API` -> `runway-picker-metar-api`
  - `env.preview.services` binding:
    - `METAR_API` -> `runway-picker-metar-api` (environment `preview`)

## 5) Create API token and account settings
In Cloudflare:
1. Create an API token with Pages edit/deploy permissions for the account/project.
2. Copy account ID from Cloudflare dashboard.

In GitHub repo settings:
- Secrets:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`
- Variable:
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
- `/api/metar?icao=KJFK` returns METAR JSON with cache headers

## 7) CI and preview deployment
- Open a PR to `main`.
- `CI` workflow runs typecheck/lint/test/build.
- `Deploy Preview` workflow:
  - deploys Worker env `preview`
  - deploys Pages preview
  - comments preview URL on the PR

## 8) Bootstrap release baseline
Before automated version tagging, create baseline tag once:
```bash
git tag -a v0.1.0 -m "Bootstrap v0.1.0"
git push origin v0.1.0
```

## 9) Release flow
- Merge PR to `main`.
- `Release Tag` workflow computes next semver from source branch name:
  - `release/*` => major
  - `feature/*` => minor
  - other => patch
- New tag push triggers:
  - `Deploy Production` (Pages app)
  - `Deploy METAR Worker Production` (Worker API)

## 10) Branch protections (recommended)
In GitHub branch protection for `main`:
- Require pull request before merge
- Require status check `CI / validate`
- Prevent direct pushes
