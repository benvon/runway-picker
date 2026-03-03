#!/usr/bin/env node

const ALLOWED_STATUSES = new Set([
  'edge_hit',
  'kv_hit',
  'upstream_refresh',
  'stale_while_refresh',
  'stale_on_error'
]);

const ICAO_CANDIDATES = ['KJFK', 'KLAX', 'KORD', 'KMCI'];

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function parsePreviewUrl(input) {
  if (!input) {
    fail('Missing preview URL argument.');
  }

  let url;
  try {
    url = new globalThis.URL(input);
  } catch {
    fail(`Invalid preview URL: ${input}`);
  }

  return url.origin;
}

async function fetchMetar(baseUrl, icao) {
  const url = `${baseUrl}/api/metar?icao=${encodeURIComponent(icao)}`;
  const response = await globalThis.fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-store'
    }
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    // keep null when body is invalid
  }

  return {
    response,
    body
  };
}

function validateCacheContract(lookup, label) {
  assert(lookup.response.ok, `${label} expected 2xx but received ${lookup.response.status}`);
  assert(lookup.body && typeof lookup.body === 'object', `${label} response body must be JSON object`);

  const statusHeader = lookup.response.headers.get('X-Runway-Cache-Status');
  const legacyHeader = lookup.response.headers.get('X-Cache');

  assert(statusHeader && ALLOWED_STATUSES.has(statusHeader), `${label} invalid X-Runway-Cache-Status: ${statusHeader}`);
  assert(legacyHeader === 'HIT' || legacyHeader === 'MISS', `${label} invalid X-Cache header: ${legacyHeader}`);

  const cache = lookup.body.cache;
  assert(cache && typeof cache === 'object', `${label} body.cache must exist`);

  assert(typeof cache.status === 'string' && ALLOWED_STATUSES.has(cache.status), `${label} cache.status invalid`);
  assert(typeof cache.source === 'string', `${label} cache.source missing`);
  assert(typeof cache.ageSeconds === 'number' && cache.ageSeconds >= 0, `${label} cache.ageSeconds invalid`);
  assert(typeof cache.fetchedAt === 'string' && cache.fetchedAt.length > 0, `${label} cache.fetchedAt invalid`);
  assert(typeof cache.servedAt === 'string' && cache.servedAt.length > 0, `${label} cache.servedAt invalid`);
  assert(typeof cache.ttlSeconds === 'number' && cache.ttlSeconds > 0, `${label} cache.ttlSeconds invalid`);
  assert(typeof cache.key === 'string' && cache.key.startsWith('v1:metar:'), `${label} cache.key invalid`);
  assert(cache.resource === 'metar', `${label} cache.resource must be metar`);
}

async function findWorkingIcao(baseUrl) {
  for (const icao of ICAO_CANDIDATES) {
    const lookup = await fetchMetar(baseUrl, icao);
    if (lookup.response.ok) {
      return { icao, lookup };
    }
  }

  fail(`None of the ICAO candidates returned 2xx: ${ICAO_CANDIDATES.join(', ')}`);
}

async function ensureRepeatedRequestShowsCacheReuse(baseUrl, icao) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const lookup = await fetchMetar(baseUrl, icao);
    validateCacheContract(lookup, `repeat attempt ${attempt}`);

    const status = lookup.body.cache.status;
    const legacy = lookup.response.headers.get('X-Cache');

    if (status !== 'upstream_refresh' && legacy === 'HIT') {
      return;
    }

    await sleep(1000);
  }

  fail(
    `Repeated requests for ${icao} never showed cache reuse. Expected a non-upstream_refresh status with X-Cache=HIT.`
  );
}

async function main() {
  const baseUrl = parsePreviewUrl(process.argv[2] ?? process.env.PREVIEW_URL);
  console.log(`Verifying preview cache behavior at ${baseUrl}`);

  const { icao, lookup } = await findWorkingIcao(baseUrl);
  console.log(`Using ICAO ${icao} for smoke checks`);
  validateCacheContract(lookup, 'initial request');

  await ensureRepeatedRequestShowsCacheReuse(baseUrl, icao);
  console.log('Preview cache smoke checks passed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
