# Security Hardening

## Threat model summary
- Public unauthenticated API endpoints can be abused for request floods and malformed inputs.
- Provider-derived payloads are treated as untrusted content when rendered in the browser.
- CI/CD and source control need guardrails against secret leakage and vulnerable dependencies.

## Implemented controls

### Input validation and request boundaries
- Pages API layer validates `icao` query values with strict `^[A-Z0-9]{4}$` checks before proxying.
- Worker adapters independently validate ICAO input as a second boundary.
- Error responses follow stable shape: `{ error, code, requestId }`.

### XSS and rendering safety
- Frontend result rendering uses DOM construction APIs and `textContent` for dynamic values.
- Dynamic `innerHTML` writes for provider/user data were removed.

### Abuse controls and rate limiting
- Worker Durable Object `ApiRateLimiter` enforces balanced limits per client + endpoint:
  - burst: 20 requests / 10 seconds
  - sustained: 60 requests / 60 seconds
- Repeated invalid ICAO requests trigger a temporary penalty window.
- Rate-limited responses return `429 RATE_LIMITED` with `Retry-After` and rate headers.

### Error disclosure and observability
- `X-Request-Id` is emitted for correlation.
- Production responses suppress debug payloads by default.
- Preview/dev can enable debug payloads through Wrangler vars.

### Browser/API security headers
- Static content headers are set in `public/_headers` (strict CSP + hardening headers).
- Static CSP allows Cloudflare Insights script loading from `https://static.cloudflareinsights.com`.
- Build pipeline inlines the app stylesheet into `dist/index.html` and injects a matching `style-src 'sha256-...'` token into `dist/_headers`.
- API responses include hardening headers and `X-Request-Id`.

### Worker exposure
- `workers_dev: false` disables direct public worker URL exposure.
- Access path is through Pages service binding.

## CI and local guardrails
- `make ci` runs local validation parity checks.
- Security gates include:
  - secret scanning (`scripts/scan-secrets.mjs`)
  - workflow linting (`scripts/lint-workflows.mjs`)
  - dependency audit (`npm audit --audit-level=high` via `scripts/run-audit.mjs`)
  - CodeQL analysis in GitHub Actions

## Operational notes
- Tune rate limits in `workers/metar-proxy/src/security/rateLimiter.ts` if false positives or abuse patterns change.
- Keep AirportDB token in Worker secrets only; never commit tokens in source.
- If debug responses are needed for incident triage, enable `ENABLE_DEBUG_ERRORS=true` only in non-production environments.
