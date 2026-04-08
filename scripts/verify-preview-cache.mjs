#!/usr/bin/env node

const ALLOWED_STATUSES = new Set([
  'edge_hit',
  'kv_hit',
  'upstream_refresh',
  'stale_while_refresh',
  'stale_on_error'
]);

const ICAO_CANDIDATES = ['KJFK', 'KLAX', 'KORD', 'KMCI'];
const RESOURCES = ['metar', 'airport'];

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

async function fetchResource(baseUrl, resource, icao) {
  const url = `${baseUrl}/api/${resource}?icao=${encodeURIComponent(icao)}`;
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

function validateCacheContract(lookup, label, resource) {
  assert(lookup.response.ok, `${label} expected 2xx but received ${lookup.response.status}`);
  assert(lookup.body && typeof lookup.body === 'object', `${label} response body must be JSON object`);

  const statusHeader = lookup.response.headers.get('X-Runway-Cache-Status');

  assert(statusHeader && ALLOWED_STATUSES.has(statusHeader), `${label} invalid X-Runway-Cache-Status: ${statusHeader}`);

  const cache = lookup.body.cache;
  assert(cache && typeof cache === 'object', `${label} body.cache must exist`);

  assert(typeof cache.status === 'string' && ALLOWED_STATUSES.has(cache.status), `${label} cache.status invalid`);
  assert(typeof cache.source === 'string', `${label} cache.source missing`);
  assert(typeof cache.ageSeconds === 'number' && cache.ageSeconds >= 0, `${label} cache.ageSeconds invalid`);
  assert(typeof cache.fetchedAt === 'string' && cache.fetchedAt.length > 0, `${label} cache.fetchedAt invalid`);
  assert(typeof cache.servedAt === 'string' && cache.servedAt.length > 0, `${label} cache.servedAt invalid`);
  assert(typeof cache.ttlSeconds === 'number' && cache.ttlSeconds > 0, `${label} cache.ttlSeconds invalid`);
  assert(typeof cache.key === 'string' && cache.key.startsWith(`v1:${resource}:`), `${label} cache.key invalid`);
  assert(cache.resource === resource, `${label} cache.resource must be ${resource}`);
}

async function findWorkingIcao(baseUrl, resource) {
  for (const icao of ICAO_CANDIDATES) {
    const lookup = await fetchResource(baseUrl, resource, icao);
    if (lookup.response.ok) {
      return { icao, lookup };
    }
  }

  fail(`None of the ICAO candidates returned 2xx for ${resource}: ${ICAO_CANDIDATES.join(', ')}`);
}

async function ensureRepeatedRequestShowsCacheReuse(baseUrl, resource, icao) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const lookup = await fetchResource(baseUrl, resource, icao);
    validateCacheContract(lookup, `${resource} repeat attempt ${attempt}`, resource);

    const status = lookup.body.cache.status;

    if (status !== 'upstream_refresh') {
      return;
    }

    await sleep(1000);
  }

  fail(`Repeated ${resource} requests for ${icao} never showed cache reuse (non-upstream_refresh).`);
}

async function verifyResource(baseUrl, resource) {
  const { icao, lookup } = await findWorkingIcao(baseUrl, resource);
  console.log(`Using ICAO ${icao} for ${resource} smoke checks`);
  validateCacheContract(lookup, `${resource} initial request`, resource);
  await ensureRepeatedRequestShowsCacheReuse(baseUrl, resource, icao);
}

async function runAllResourceChecks(baseUrl) {
  for (const resource of RESOURCES) {
    await verifyResource(baseUrl, resource);
  }
}

async function main() {
  const baseUrl = parsePreviewUrl(process.argv[2] ?? process.env.PREVIEW_URL);
  const maxAttempts = Math.max(1, Number(process.env.PREVIEW_VERIFY_ATTEMPTS ?? '6'));
  const delayMs = Math.max(0, Number(process.env.PREVIEW_VERIFY_DELAY_MS ?? '5000'));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    console.log(`Verifying preview cache behavior at ${baseUrl} (attempt ${attempt}/${maxAttempts})`);

    try {
      await runAllResourceChecks(baseUrl);
      console.log('Preview cache smoke checks passed.');
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === maxAttempts) {
        throw error;
      }
      console.warn(`${message} — retrying in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
