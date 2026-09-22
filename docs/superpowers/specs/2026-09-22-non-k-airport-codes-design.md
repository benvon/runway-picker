# Non-K Airport Codes — Design

**Date:** 2026-09-22  
**Status:** Approved for implementation planning  
**Test candidates:** `1C8`, `C25`

## Problem

Airport lookup currently requires exactly 4 alphanumeric characters end-to-end (`^[A-Z0-9]{4}$`). That fits ICAO identifiers such as `KJFK`, but rejects common US FAA location identifiers (LIDs) used by private and small airports (e.g. `1C8`, `C25`).

## Goals

- Allow primary airport lookup for 3–4 alphanumeric identifiers via exact match (no `K`-prefix guessing).
- Keep METAR / alternate-METAR inputs as strict 4-character ICAO.
- For 3-character primary codes, skip METAR lookup and go straight to the existing alternate-METAR prompt.
- Relabel the primary field to “Airport code”; keep alternate labeled as ICAO.
- Preserve internal field names (`icao`, `requestedIcao`, error code `INVALID_ICAO`) to avoid API/cache contract churn.

## Non-goals

- Auto-prefixing 3-letter all-alpha codes with `K` (e.g. `ORD` → `KORD`).
- Accepting METAR for non-4-character identifiers.
- Renaming airport-path types/fields from `icao` to `ident` across the stack.
- Broadening identifiers beyond 3–4 alphanumeric characters.

## Approach

**Split airport vs METAR validation** (existing `normalizeAirportIcao` / `normalizeIcao` split), widening only the airport side to `^[A-Z0-9]{3,4}$`.

## Architecture & validation

| Layer | Airport / airport-location | METAR / alternate METAR |
|---|---|---|
| UI | Primary: 3–4 alphanumeric; label “Airport code” | Alternate: 4 alphanumeric; label stays ICAO |
| Pages | Airport-ident validator `^[A-Z0-9]{3,4}$` for airport-location (and any Pages-side airport validation added later) | Worker continues to enforce 4-char ICAO |
| Worker | `normalizeAirportIcao` → 3–4 alphanumeric | `normalizeIcao` → still 4 alphanumeric |
| Upstream identity | `resolveAirportPayloadIcao` requires exact match of returned `icao_code` or `ident` to the requested code; allow 3–4 character values | Unchanged |

Query parameter name remains `icao` for compatibility.

## Data flow

### Primary airport code (3 or 4 characters)

1. User enters code → trim + uppercase.
2. Client allows up to 4 characters; submits 3–4 alphanumeric values.
3. `/api/airport?icao=<code>` → worker `normalizeAirportIcao` → AirportDB exact ident lookup.
4. Response `requestedIcao` and `icao` both carry the matched identifier (e.g. `1C8`).
5. **METAR branch:**
   - If primary code length is **3**: do **not** call METAR; transition immediately to alternate-METAR stage with the existing prompt UX.
   - If primary code length is **4**: keep current behavior (fetch METAR; on miss/unavailable, prompt for alternate).

### Alternate METAR

- Unchanged: requires 4-character ICAO.
- Alternate distance checks still use airport-location for primary and alternate stations; location validation must accept 3–4 so primary coordinates for codes like `1C8` resolve.

## UI copy

- Primary label: **Airport code**
- Primary placeholder: e.g. `KJFK or 1C8`
- Primary `maxLength`: 4 (still allows 3-character entry)
- Alternate label: **Alternate METAR ICAO code** (unchanged)
- Airport validation message: `Invalid airport code. Expected 3–4 alphanumeric characters.`
- METAR validation messages: keep ICAO wording

## Error handling

| Condition | Behavior |
|---|---|
| Airport code wrong length/charset | `400` with code `INVALID_ICAO` (stable API code) and airport-oriented message |
| Airport not in AirportDB | Existing `404 ICAO_NOT_FOUND` |
| Provider `ident`/`icao_code` missing, not 3–4 alphanum, or ≠ requested | Existing `PROVIDER_PAYLOAD_INVALID` |
| 3-char primary | No METAR upstream call; app enters alternate-METAR stage |
| Alternate / METAR non-4-char | Existing METAR `INVALID_ICAO` |

## Testing

Use `1C8` and `C25` as fixtures where useful.

- Worker: `normalizeAirportIcao` accepts `1C8`, `C25`, `KJFK`; rejects `AB`, `ABCDE`, empty.
- Worker: `resolveAirportPayloadIcao` accepts matching 3-character `ident`.
- Worker: `normalizeIcao` / METAR path still rejects `1C8`.
- Application: primary `1C8` with successful airport → `prompt-alternate` **without** calling METAR gateway.
- Application: primary `KJFK` unchanged (airport + METAR).
- UI: primary label/placeholder updated; `maxLength` remains 4.
- Integration (mocked): `1C8` airport + alternate 4-char METAR happy path.

## Implementation touchpoints (expected)

- `workers/metar-proxy/src/resources/airport/adapter.ts` — `normalizeAirportIcao`, `resolveAirportPayloadIcao`
- `functions/api/_shared/validation.ts` (+ airport-location usage) — airport-ident validator
- `src/application/lookup/useCase.ts` — skip METAR for 3-char primary
- `src/ui/layout.ts` — labels, placeholder
- Corresponding unit/integration tests

## Success criteria

- Looking up `1C8` or `C25` returns airport/runway data when present in AirportDB.
- Those lookups prompt for alternate METAR without attempting a METAR request for the 3-char code.
- `KJFK`-style 4-char primary behavior is unchanged.
- METAR endpoints continue to reject non-4-character codes.
