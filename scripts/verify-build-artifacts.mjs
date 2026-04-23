#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT_DIR = process.cwd();
const DIST_DIR = path.join(ROOT_DIR, 'dist');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n');
}

async function main() {
  const [distIndexHtml, distHeadersRaw, publicRobotsRaw, distRobotsRaw, distVersionManifestRaw] = await Promise.all([
    readFile(path.join(DIST_DIR, 'index.html'), 'utf8'),
    readFile(path.join(DIST_DIR, '_headers'), 'utf8'),
    readFile(path.join(ROOT_DIR, 'public', 'robots.txt'), 'utf8'),
    readFile(path.join(DIST_DIR, 'robots.txt'), 'utf8'),
    readFile(path.join(DIST_DIR, 'version.json'), 'utf8')
  ]);

  assert(/<style>[\s\S]+<\/style>/i.test(distIndexHtml), 'dist/index.html must contain an inline <style> block.');
  assert(
    !/<link\b[^>]*\brel=(["'])stylesheet\1[^>]*\bhref=(["'])\/?assets\/[^"']+\.css\2[^>]*>/i.test(distIndexHtml),
    'dist/index.html must not contain an external app stylesheet link after postbuild.'
  );

  assert(
    /script-src[^;\n]*\shttps:\/\/static\.cloudflareinsights\.com(?:\s|['";])/i.test(distHeadersRaw),
    'dist/_headers CSP script-src must include https://static.cloudflareinsights.com as a source.'
  );
  assert(
    /style-src[^;]*'sha256-[^']+'/i.test(distHeadersRaw),
    "dist/_headers CSP style-src must include a sha256 hash token for inline styles."
  );
  assert(
    /(^|\n)\/version\.json\s*\n\s+Cache-Control:\s*no-store,\s*max-age=0\s*$/m.test(distHeadersRaw),
    'dist/_headers must mark /version.json as non-cacheable.'
  );

  const expectedRobots = 'User-agent: *\nAllow: /\n';
  assert(normalizeEol(publicRobotsRaw) === expectedRobots, 'public/robots.txt must match expected crawl policy.');
  assert(normalizeEol(distRobotsRaw) === expectedRobots, 'dist/robots.txt must match expected crawl policy.');

  const distVersionManifest = JSON.parse(distVersionManifestRaw);
  assert(typeof distVersionManifest.version === 'string', 'dist/version.json must contain a string version.');
  assert(typeof distVersionManifest.commitSha === 'string', 'dist/version.json must contain a string commitSha.');
  assert(/^v/.test(distVersionManifest.version), 'dist/version.json version must be normalized with a leading v.');
  assert(
    distVersionManifest.commitSha === 'local' || /^[a-f0-9]{7,40}$/.test(distVersionManifest.commitSha),
    'dist/version.json commitSha must be normalized.'
  );
}

await main();
