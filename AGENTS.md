# Runway Picker Coding Agent Instructions

This file is the canonical instruction source for coding agents in this repository.

## Architecture and Separation of Concerns
- Preserve the existing layering: `src/domain` (pure rules/calculations), `src/application` (use cases/orchestration), `src/services` (I/O adapters), and `src/ui` (presentation/controller/layout).
- Keep domain/application logic free of DOM, network, and platform-specific side effects.
- Keep UI code focused on state transitions and rendering; put parsing/business rules in domain/application modules.
- Prefer small, composable functions and explicit interfaces over implicit object shapes.

## TypeScript Standards
- Keep `strict` TypeScript compatibility and do not introduce `any` where a specific type can be defined.
- Model request/response contracts with explicit interfaces and validate external payloads defensively.
- Avoid mixing transport-layer models directly into domain models; map at boundaries.

## Testing and Quality Gates
- Maintain at least the current repository coverage threshold (80% statements/branches/functions/lines).
- Add or update tests for every behavior change, including edge/error paths when relevant.
- Keep complexity manageable (respect existing ESLint complexity limits).
- Before merge, ensure local parity with CI checks:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run test:coverage`
  - `npm run build`
  - `npm run lint:workflows`

## Commit and Release Policy
- Use Conventional Commits for PR titles and squash commits:
  - Format: `<type>(optional-scope)!: summary`
  - Accepted types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `revert`.
- Release bump policy is commit-signal based:
  - `BREAKING CHANGE` footer or `!` => major
  - `feat` => minor
  - `fix` or `perf` => patch
  - others => no release
- Do not manually push release tags; releases are created by GitHub Actions from `main` after successful CI.

## Workflow and Deployment Expectations
- Standard flow: PR checks + review + preview deploy -> merge to `main` -> automated GitHub Release -> production deploy.
- Production deploys must be tied to published stable GitHub Releases (not direct tag pushes or manual ad hoc deploys).
- Frontend builds must expose `VITE_APP_VERSION` and `VITE_APP_COMMIT_SHA` so deployed UI includes traceable build identity.
