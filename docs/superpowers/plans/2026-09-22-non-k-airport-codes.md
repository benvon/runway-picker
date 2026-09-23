# Non-K Airport Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow primary airport lookup for 3–4 alphanumeric identifiers (`1C8`, `C25`, `KJFK`) while keeping METAR as strict 4-character ICAO, skipping METAR and prompting for an alternate when the primary code is 3 characters.

**Architecture:** Widen only the airport-side validators (`normalizeAirportIcao`, Pages airport-ident validation, frontend `airportApi`) to `^[A-Z0-9]{3,4}$`. Leave `normalizeIcao` / METAR clients at 4 characters. In `runPrimaryLookup`, if the primary code length is 3 after normalize, return `prompt-alternate` without calling `fetchMetarByIcao`.

**Tech Stack:** TypeScript, Vitest, Cloudflare Pages Functions, metar-proxy Worker, Vite frontend.

**Spec:** `docs/superpowers/specs/2026-09-22-non-k-airport-codes-design.md`

## Global Constraints

- Airport identifiers: exact match only; `^[A-Z0-9]{3,4}$`; no `K`-prefix guessing.
- METAR / alternate METAR: remain `^[A-Z0-9]{4}$`.
- Keep internal names (`icao`, `requestedIcao`, error code `INVALID_ICAO`).
- Airport validation message: `Invalid airport code. Expected 3–4 alphanumeric characters.`
- Primary UI label: `Airport code`; placeholder: `KJFK or 1C8`; alternate stays ICAO-labeled.
- Test candidates: `1C8`, `C25`.
- Conventional Commits; do not push unless asked.

## File map

| File | Responsibility |
|---|---|
| `workers/metar-proxy/src/resources/airport/adapter.ts` | `normalizeAirportIcao`, `resolveAirportPayloadIcao` |
| `workers/metar-proxy/src/index.test.ts` | Worker airport normalize / lookup tests |
| `functions/api/_shared/validation.ts` | Add `validateAirportIdentParam`; keep `validateIcaoParam` at 4 chars |
| `functions/api/_shared/validation.test.ts` | Pages validation tests |
| `functions/api/airport-location.ts` | Use airport-ident validator |
| `functions/api/airport-location.test.ts` | Accept 3-char; reject 2-char |
| `src/services/airportApi.ts` | Client-side airport code validation (3–4) |
| `src/services/airportApi.test.ts` | Accept `1C8`; reject malformed |
| `src/application/lookup/useCase.ts` | Skip METAR for 3-char primary |
| `src/application/lookup/useCase.test.ts` | Assert no METAR call for `1C8` |
| `src/ui/layout.ts` | Primary label + placeholder |
| `src/test/app.integration.test.ts` | End-to-end `1C8` + alternate METAR |

---

### Task 1: Worker airport identifier validation

**Files:**
- Modify: `workers/metar-proxy/src/resources/airport/adapter.ts` (`normalizeAirportIcao`, `resolveAirportPayloadIcao`)
- Test: `workers/metar-proxy/src/index.test.ts`

**Interfaces:**
- Consumes: none new
- Produces: `normalizeAirportIcao(value: string): string` accepts 3–4 alphanum; `resolveAirportPayloadIcao(payload, requestedIcao): string` accepts matching 3–4 char `icao_code`/`ident`

- [ ] **Step 1: Write the failing tests**

In `workers/metar-proxy/src/index.test.ts`, inside `describe('airport worker', ...)`, extend/replace the normalize test and add payload + rejection cases:

```typescript
it('normalizes airport identifiers including 3-character FAA LIDs', () => {
  expect(normalizeAirportIcao(' kjfk ')).toBe('KJFK');
  expect(normalizeAirportIcao('1c8')).toBe('1C8');
  expect(normalizeAirportIcao('c25')).toBe('C25');
});

it('rejects airport identifiers that are not 3–4 alphanumeric characters', () => {
  expect(() => normalizeAirportIcao('AB')).toThrow(AirportWorkerError);
  expect(() => normalizeAirportIcao('ABCDE')).toThrow(AirportWorkerError);
  expect(() => normalizeAirportIcao('')).toThrow(AirportWorkerError);
});

it('resolves airport payload identity for matching 3-character ident without icao_code', () => {
  expect(
    resolveAirportPayloadIcao({ ident: '1C8', icao_code: null }, '1C8')
  ).toBe('1C8');
  expect(
    resolveAirportPayloadIcao({ ident: 'C25', icao_code: '' }, 'C25')
  ).toBe('C25');
});
```

Import `resolveAirportPayloadIcao` and `AirportWorkerError` from `./resources/airport/adapter` (they are not re-exported from `index.ts`; keep using `normalizeAirportIcao` from the existing index import if already present).

Also add an HTTP smoke that fetches `?icao=1C8` with a stubbed upstream report where `ident: '1C8'` and `icao_code` is null/omitted, expecting `200` and `payload.icao === '1C8'`. Reuse `buildAirportReport` carefully: for this case build a report with `ident: '1C8'` and `icao_code: null` (do not set `icao_code` to a 4-char value).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run workers/metar-proxy/src/index.test.ts -t "normalizes airport identifiers including|rejects airport identifiers that are not|resolves airport payload identity"`

Expected: FAIL — 3-char still rejected by `^[A-Z0-9]{4}$` and/or `resolveAirportPayloadIcao` not imported / still 4-only.

- [ ] **Step 3: Implement minimal worker changes**

In `workers/metar-proxy/src/resources/airport/adapter.ts`:

```typescript
export function normalizeAirportIcao(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,4}$/.test(normalized)) {
    throw new AirportWorkerError(
      'Invalid airport code. Expected 3–4 alphanumeric characters.',
      400,
      'INVALID_ICAO'
    );
  }

  return normalized;
}
```

```typescript
export function resolveAirportPayloadIcao(payload: AirportDbPayload, requestedIcao: string): string {
  const returnedIcao =
    toStringValue(payload.icao_code)?.toUpperCase() ??
    toStringValue(payload.ident)?.toUpperCase();
  if (!returnedIcao || !/^[A-Z0-9]{3,4}$/.test(returnedIcao) || returnedIcao !== requestedIcao) {
    throw new AirportWorkerError(
      'Airport provider returned a record that does not match the requested ICAO code.',
      502,
      'PROVIDER_PAYLOAD_INVALID'
    );
  }

  return returnedIcao;
}
```

Do **not** change `normalizeIcao` in the METAR adapter.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run workers/metar-proxy/src/index.test.ts -t "airport worker"`

Expected: PASS for new cases; existing airport worker tests still pass. Also confirm METAR still rejects 3-char:

Run: `npx vitest run workers/metar-proxy/src/index.test.ts -t "rejects invalid ICAO values"`

Expected: PASS (`normalizeIcao('ABC')` still throws).

- [ ] **Step 5: Commit**

```bash
git add workers/metar-proxy/src/resources/airport/adapter.ts workers/metar-proxy/src/index.test.ts
git commit -m "$(cat <<'EOF'
feat(airport): accept 3–4 character airport identifiers in worker

EOF
)"
```

---

### Task 2: Pages airport-location validation

**Files:**
- Modify: `functions/api/_shared/validation.ts`
- Modify: `functions/api/_shared/validation.test.ts`
- Modify: `functions/api/airport-location.ts`
- Modify: `functions/api/airport-location.test.ts`

**Interfaces:**
- Consumes: Task 1 worker behavior (indirect)
- Produces:
  - `validateAirportIdentParam(value: string | null): IcaoValidationResult` — success `icao` is 3–4 alphanum
  - `validateIcaoParam` remains 4-char only

- [ ] **Step 1: Write the failing tests**

In `functions/api/_shared/validation.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { validateAirportIdentParam, validateIcaoParam } from './validation';

describe('ICAO validation', () => {
  it('accepts normalized ICAO values', () => {
    expect(validateIcaoParam(' kjfk ')).toEqual({ ok: true, icao: 'KJFK' });
  });

  it('rejects null and malformed ICAO values', () => {
    expect(validateIcaoParam(null)).toMatchObject({ ok: false, code: 'INVALID_ICAO' });
    expect(validateIcaoParam('ABC')).toMatchObject({ ok: false, code: 'INVALID_ICAO' });
    expect(validateIcaoParam('ABCDE')).toMatchObject({ ok: false, code: 'INVALID_ICAO' });
  });
});

describe('airport ident validation', () => {
  it('accepts 3–4 alphanumeric airport codes', () => {
    expect(validateAirportIdentParam('1c8')).toEqual({ ok: true, icao: '1C8' });
    expect(validateAirportIdentParam('c25')).toEqual({ ok: true, icao: 'C25' });
    expect(validateAirportIdentParam(' kjfk ')).toEqual({ ok: true, icao: 'KJFK' });
  });

  it('rejects codes outside 3–4 alphanumeric length', () => {
    expect(validateAirportIdentParam(null)).toMatchObject({ ok: false, code: 'INVALID_ICAO' });
    expect(validateAirportIdentParam('AB')).toMatchObject({
      ok: false,
      code: 'INVALID_ICAO',
      error: 'Invalid airport code. Expected 3–4 alphanumeric characters.'
    });
    expect(validateAirportIdentParam('ABCDE')).toMatchObject({ ok: false, code: 'INVALID_ICAO' });
  });
});
```

In `functions/api/airport-location.test.ts`, add:

```typescript
it('accepts 3-character airport identifiers', async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({ icao: '1C8', coordinates: { latitudeDeg: 41.5, longitudeDeg: -88.0 } })
  );

  const response = await onRequestGet({
    request: new Request('https://example.com/api/airport-location?icao=1c8'),
    env: { METAR_API: { fetch } },
    params: {},
    data: {},
    waitUntil: () => {},
    next: async () => new Response('')
  });

  expect(response.status).toBe(200);
  const proxiedRequest = fetch.mock.calls[0]?.[0] as Request;
  expect(new URL(proxiedRequest.url).searchParams.get('icao')).toBe('1C8');
});
```

Keep the existing `rejects malformed ICAO values` case with `icao=A1` (still invalid).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run functions/api/_shared/validation.test.ts functions/api/airport-location.test.ts`

Expected: FAIL — `validateAirportIdentParam` not exported; location still rejects `1c8` if not yet wired.

- [ ] **Step 3: Implement Pages validation**

In `functions/api/_shared/validation.ts`:

```typescript
const ICAO_REGEX = /^[A-Z0-9]{4}$/;
const AIRPORT_IDENT_REGEX = /^[A-Z0-9]{3,4}$/;

// keep existing IcaoValidation* types and validateIcaoParam unchanged

export function validateAirportIdentParam(value: string | null): IcaoValidationResult {
  const normalized = value?.trim().toUpperCase() ?? '';
  if (!AIRPORT_IDENT_REGEX.test(normalized)) {
    return {
      ok: false,
      code: 'INVALID_ICAO',
      error: 'Invalid airport code. Expected 3–4 alphanumeric characters.'
    };
  }

  return {
    ok: true,
    icao: normalized
  };
}
```

In `functions/api/airport-location.ts`, replace `validateIcaoParam` with `validateAirportIdentParam`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run functions/api/_shared/validation.test.ts functions/api/airport-location.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add functions/api/_shared/validation.ts functions/api/_shared/validation.test.ts functions/api/airport-location.ts functions/api/airport-location.test.ts
git commit -m "$(cat <<'EOF'
feat(pages): validate 3–4 character airport location idents

EOF
)"
```

---

### Task 3: Frontend airportApi client validation

**Files:**
- Modify: `src/services/airportApi.ts`
- Modify: `src/services/airportApi.test.ts`

**Interfaces:**
- Consumes: none
- Produces: `fetchAirportByIcao` / `fetchAirportCoordinatesByIcao` accept 3–4 alphanum; reject others with airport-oriented message; METAR client untouched

- [ ] **Step 1: Write the failing tests**

In `src/services/airportApi.test.ts`, change the current `KSF` rejection case (3-char will become valid) and add acceptance:

```typescript
it('rejects airport codes outside 3–4 alphanumeric characters', async () => {
  await expect(fetchAirportByIcao('AB')).rejects.toMatchObject({
    status: 400,
    code: 'INVALID_ICAO'
  });
  await expect(fetchAirportByIcao('ABCDE')).rejects.toMatchObject({
    status: 400,
    code: 'INVALID_ICAO'
  });
});

it('accepts 3-character airport codes and calls the airport API', async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      requestedIcao: '1C8',
      icao: '1C8',
      name: 'Casey Municipal',
      municipality: 'Casey',
      countryCode: 'US',
      countryName: 'United States',
      elevationFt: 645,
      runwayEnds: [{ id: '18', headingDegTrue: 180, isClosed: false, lengthFt: 4000 }],
      frequencies: [],
      source: 'airportdb',
      fetchedAt: '2026-03-02T00:00:00.000Z',
      cache: {
        status: 'upstream_refresh',
        source: 'upstream',
        ageSeconds: 0,
        fetchedAt: '2026-03-02T00:00:00.000Z',
        servedAt: '2026-03-02T00:00:00.000Z',
        ttlSeconds: 86400,
        key: 'v1:airport:1C8',
        resource: 'airport'
      }
    })
  );
  vi.stubGlobal('fetch', fetch);

  const payload = await fetchAirportByIcao('1c8');
  expect(payload.icao).toBe('1C8');
  expect(fetch).toHaveBeenCalledWith('/api/airport?icao=1C8', expect.any(Object));
});
```

Mirror a coordinates acceptance case for `fetchAirportCoordinatesByIcao('c25')` → `/api/airport-location?icao=C25`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/airportApi.test.ts`

Expected: FAIL — `1c8` still rejected by client regex / message still 4-character ICAO wording.

- [ ] **Step 3: Implement client validation**

In `src/services/airportApi.ts`, update both `fetchAirportByIcao` and `fetchAirportCoordinatesByIcao`:

```typescript
if (!/^[A-Z0-9]{3,4}$/.test(icao)) {
  throw new AirportLookupError(
    'Invalid airport code. Expected 3–4 alphanumeric characters.',
    400,
    'INVALID_ICAO'
  );
}
```

Do **not** change `src/services/metarApi.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/airportApi.test.ts src/services/metarApi.test.ts`

Expected: PASS; METAR still rejects short codes.

- [ ] **Step 5: Commit**

```bash
git add src/services/airportApi.ts src/services/airportApi.test.ts
git commit -m "$(cat <<'EOF'
feat(airportApi): accept 3–4 character airport codes in client

EOF
)"
```

---

### Task 4: Skip METAR for 3-character primary lookup

**Files:**
- Modify: `src/application/lookup/useCase.ts`
- Modify: `src/application/lookup/useCase.test.ts`

**Interfaces:**
- Consumes: `LookupGateway.fetchAirportByIcao`, `fetchMetarByIcao`
- Produces: `runPrimaryLookup(primaryIcao, gateway)` — when `normalizeIcaoInput(primaryIcao).length === 3` and airport succeeds, returns `{ type: 'prompt-alternate', ... }` without calling `fetchMetarByIcao`

- [ ] **Step 1: Write the failing test**

In `src/application/lookup/useCase.test.ts`:

```typescript
it('prompts for alternate METAR without calling METAR when primary airport code is 3 characters', async () => {
  let metarCalls = 0;
  const gateway = buildGateway({
    fetchMetarByIcao: async () => {
      metarCalls += 1;
      throw new Error('METAR should not be requested for 3-character airport codes');
    }
  });

  const result = await runPrimaryLookup('1C8', gateway);

  expect(result.type).toBe('prompt-alternate');
  expect(metarCalls).toBe(0);
  if (result.type === 'prompt-alternate') {
    expect(result.state.stage).toBe('alternate-metar');
    expect(result.state.primaryIcao).toBe('1C8');
    expect(result.state.primaryAirport?.icao).toBe('1C8');
    expect(result.message).toContain('1C8');
  }
});

it('still attempts METAR for 4-character primary codes', async () => {
  let metarCalls = 0;
  const gateway = buildGateway({
    fetchMetarByIcao: async (icao) => {
      metarCalls += 1;
      return buildGateway().fetchMetarByIcao(icao);
    }
  });

  const result = await runPrimaryLookup('KJFK', gateway);
  expect(result.type).toBe('success');
  expect(metarCalls).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/application/lookup/useCase.test.ts -t "prompts for alternate METAR without calling METAR"`

Expected: FAIL — METAR is still called (metarCalls > 0 or thrown error).

- [ ] **Step 3: Implement skip branch**

In `src/application/lookup/useCase.ts`, inside `runPrimaryLookup`, after a successful airport fetch and before the METAR try/catch:

```typescript
if (primaryIcao.length === 3) {
  return {
    type: 'prompt-alternate',
    state: createAlternateState(primaryIcao, airport),
    message: `No METAR is currently available for ICAO ${primaryIcao}. Enter an alternate ICAO code for METAR data.`
  };
}
```

Assume callers already pass normalized uppercase input (controller uses `normalizeIcaoInput`). Do not change alternate-lookup METAR requirements.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/application/lookup/useCase.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/application/lookup/useCase.ts src/application/lookup/useCase.test.ts
git commit -m "$(cat <<'EOF'
feat(lookup): skip METAR for 3-character primary airport codes

EOF
)"
```

---

### Task 5: UI copy + integration coverage

**Files:**
- Modify: `src/ui/layout.ts`
- Modify: `src/test/app.integration.test.ts`

**Interfaces:**
- Consumes: Task 3–4 behavior via mounted app
- Produces: Primary label `Airport code`, placeholder `KJFK or 1C8`; integration path for `1C8` → alternate → success with 4-char METAR

- [ ] **Step 1: Write the failing integration test**

In `src/test/app.integration.test.ts`, add (match neighboring tests: reset the `#app` root the same way they do, then):

```typescript
it('looks up a 3-character airport code and prompts for alternate METAR without requesting METAR for the primary', async () => {
  // Reset document body with a <main id="app"> root exactly as sibling tests do.
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url === '/api/airport?icao=1C8') {
      return Promise.resolve(Response.json(airportPayload('1C8')));
    }

    if (url === '/api/metar?icao=1C8') {
      return Promise.reject(new Error('METAR must not be requested for 1C8'));
    }

    if (url === '/api/metar?icao=KMCI') {
      return Promise.resolve(
        Response.json(
          metarPayload('KMCI', {
            raw: '18008KT',
            directionType: 'fixed',
            directionDegTrue: 180,
            speedKt: 8,
            gustKt: null
          })
        )
      );
    }

    if (url === '/api/airport-location?icao=KMCI') {
      return Promise.resolve(
        Response.json({ icao: 'KMCI', coordinates: { latitudeDeg: 39.1, longitudeDeg: -94.6 } })
      );
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const root = document.querySelector<HTMLElement>('#app');
  if (!root) {
    throw new Error('Expected #app root element in test.');
  }

  mountApp(root);

  const icaoInput = root.querySelector<HTMLInputElement>('#icao');
  const alternateGroup = root.querySelector<HTMLElement>('#alternate-group');
  const alternateInput = root.querySelector<HTMLInputElement>('#alternate-icao');
  const form = root.querySelector<HTMLFormElement>('#calculator-form');
  if (!icaoInput || !alternateGroup || !alternateInput || !form) {
    throw new Error('Expected form elements not found.');
  }

  expect(root.textContent).toContain('Airport code');
  expect(icaoInput.placeholder).toContain('1C8');

  icaoInput.value = '1C8';
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => alternateGroup.hidden === false);

  expect(fetchMock).toHaveBeenCalledWith('/api/airport?icao=1C8', expect.any(Object));
  expect(fetchMock.mock.calls.some(([request]) => {
    const url = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url;
    return url.includes('/api/metar?icao=1C8');
  })).toBe(false);

  alternateInput.value = 'KMCI';
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => (root.textContent?.includes('Weather airport: KMCI') ?? false));
});
```

- [ ] **Step 2: Run test to verify it fails on UI copy**

Run: `npx vitest run src/test/app.integration.test.ts -t "looks up a 3-character airport code"`

Expected: FAIL on label/placeholder until layout is updated (lookup behavior may already pass from Task 4).

- [ ] **Step 3: Update UI copy**

In `src/ui/layout.ts`:

```typescript
const primaryIcaoLabel = createElement('label', { textContent: 'Airport code' });
```

and

```typescript
placeholder: 'KJFK or 1C8',
```

Keep `maxLength = 4`. Leave alternate label as `Alternate METAR ICAO code`.

- [ ] **Step 4: Run integration + quality gates**

Run:

```bash
npx vitest run src/test/app.integration.test.ts -t "looks up a 3-character airport code"
npm run typecheck
npm run lint
npm run test:coverage
```

Expected: PASS; coverage thresholds still met.

- [ ] **Step 5: Commit**

```bash
git add src/ui/layout.ts src/test/app.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(ui): label primary field as airport code for non-K idents

EOF
)"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|---|---|
| Airport 3–4 alphanum exact match (worker) | Task 1 |
| `resolveAirportPayloadIcao` allows 3–4 | Task 1 |
| METAR stays 4-char | Tasks 1 & 3 (explicit non-change + regression runs) |
| Pages airport-location 3–4 | Task 2 |
| Frontend airportApi 3–4 | Task 3 |
| Skip METAR for 3-char primary | Task 4 |
| UI label/placeholder | Task 5 |
| Integration `1C8` + alternate | Task 5 |
| Keep `INVALID_ICAO` code / `icao` field names | All tasks |
| No K-prefix guessing | All tasks (exact match only) |
