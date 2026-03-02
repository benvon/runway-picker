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

## 3) Configure Wrangler
- `wrangler.jsonc` already contains:
  - `name: runway-picker`
  - `pages_build_output_dir: ./dist`
  - `compatibility_date: 2026-03-02`

## 4) Create API token and account settings
In Cloudflare:
1. Create an API token with Pages edit/deploy permissions for the account/project.
2. Copy account ID from Cloudflare dashboard.

In GitHub repo settings:
- Secrets:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`
- Variable:
  - `CLOUDFLARE_PROJECT_NAME` (exact Pages project name)

## 5) Validate locally
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

## 6) CI and preview deployment
- Open a PR to `main`.
- `CI` workflow runs typecheck/lint/test/build.
- `Deploy Preview` workflow deploys to Cloudflare and comments preview URL on the PR.

## 7) Bootstrap release baseline
Before automated version tagging, create baseline tag once:
```bash
git tag -a v0.1.0 -m "Bootstrap v0.1.0"
git push origin v0.1.0
```

## 8) Release flow
- Merge PR to `main`.
- `Release Tag` workflow computes next semver from source branch name:
  - `release/*` => major
  - `feature/*` => minor
  - other => patch
- New tag push triggers `Deploy Production` workflow.

## 9) Branch protections (recommended)
In GitHub branch protection for `main`:
- Require pull request before merge
- Require status check `CI / validate`
- Prevent direct pushes

