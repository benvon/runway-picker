#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DIST_DIR = path.resolve(process.cwd(), 'dist');
const VERSION_MANIFEST_PATH = path.join(DIST_DIR, 'version.json');
const DEFAULT_VERSION = 'v0.0.0-dev';
const DEFAULT_COMMIT_SHA = 'local';

function normalizeVersion(value) {
  const raw = value?.trim();
  if (!raw) {
    return DEFAULT_VERSION;
  }

  if (/^v/i.test(raw)) {
    const withoutPrefix = raw.slice(1).trim();
    return withoutPrefix ? `v${withoutPrefix}` : DEFAULT_VERSION;
  }

  return `v${raw}`;
}

function normalizeCommitSha(value) {
  const raw = value?.trim();
  if (!raw) {
    return DEFAULT_COMMIT_SHA;
  }

  const candidate = raw.toLowerCase();
  if (/^[a-f0-9]{7,40}$/.test(candidate)) {
    return candidate;
  }

  return DEFAULT_COMMIT_SHA;
}

async function main() {
  const versionManifest = {
    version: normalizeVersion(process.env.VITE_APP_VERSION),
    commitSha: normalizeCommitSha(process.env.VITE_APP_COMMIT_SHA)
  };

  await mkdir(DIST_DIR, { recursive: true });
  await writeFile(VERSION_MANIFEST_PATH, `${JSON.stringify(versionManifest, null, 2)}\n`, 'utf8');
}

await main();
