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
  const [distIndexHtml, distHeadersRaw, publicRobotsRaw, distRobotsRaw] = await Promise.all([
    readFile(path.join(DIST_DIR, 'index.html'), 'utf8'),
    readFile(path.join(DIST_DIR, '_headers'), 'utf8'),
    readFile(path.join(ROOT_DIR, 'public', 'robots.txt'), 'utf8'),
    readFile(path.join(DIST_DIR, 'robots.txt'), 'utf8')
  ]);

  assert(/<style>[\s\S]+<\/style>/i.test(distIndexHtml), 'dist/index.html must contain an inline <style> block.');
  assert(
    !/<link\b[^>]*\brel=(["'])stylesheet\1[^>]*\bhref=(["'])\/?assets\/[^"']+\.css\2[^>]*>/i.test(distIndexHtml),
    'dist/index.html must not contain an external app stylesheet link after postbuild.'
  );

  assert(
    distHeadersRaw.includes('https://static.cloudflareinsights.com'),
    'dist/_headers CSP must allow Cloudflare Insights script origin.'
  );
  assert(
    /style-src[^;]*'sha256-[^']+'/i.test(distHeadersRaw),
    "dist/_headers CSP style-src must include a sha256 hash token for inline styles."
  );

  const expectedRobots = 'User-agent: *\nAllow: /\n';
  assert(normalizeEol(publicRobotsRaw) === expectedRobots, 'public/robots.txt must match expected crawl policy.');
  assert(normalizeEol(distRobotsRaw) === expectedRobots, 'dist/robots.txt must match expected crawl policy.');
}

await main();
