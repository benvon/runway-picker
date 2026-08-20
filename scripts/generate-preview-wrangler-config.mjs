#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const MAX_WORKER_NAME_LENGTH = 63;
const PREVIEW_ENVIRONMENT_SUFFIX = '-preview';

function requirePositivePullRequestNumber(value) {
  if (!/^\d+$/.test(value ?? '') || Number(value) < 1) {
    throw new Error('PULL_REQUEST_NUMBER must be a positive integer.');
  }

  return Number(value);
}

export function previewWorkerBaseName(workerName, pullRequestNumber) {
  const normalizedWorkerName = workerName?.trim();
  const prNumber = requirePositivePullRequestNumber(pullRequestNumber);
  if (!normalizedWorkerName) {
    throw new Error('METAR_WORKER_NAME is required.');
  }

  const previewWorkerName = `${normalizedWorkerName}-pr-${prNumber}`;
  if (previewWorkerName.length + PREVIEW_ENVIRONMENT_SUFFIX.length > MAX_WORKER_NAME_LENGTH) {
    throw new Error('Preview Worker name would exceed Cloudflare\'s 63-character limit.');
  }

  return previewWorkerName;
}

export function buildPreviewWranglerConfigs({ workerConfig, pagesConfig, workerName, pullRequestNumber, cacheNamespaceId }) {
  if (!cacheNamespaceId?.trim()) {
    throw new Error('METAR_CACHE_PREVIEW_NAMESPACE_ID is required.');
  }

  const previewWorkerName = previewWorkerBaseName(workerName, pullRequestNumber);
  const generatedWorkerConfig = JSON.parse(JSON.stringify(workerConfig));
  generatedWorkerConfig.name = previewWorkerName;
  generatedWorkerConfig.env = generatedWorkerConfig.env ?? {};
  generatedWorkerConfig.env.preview = generatedWorkerConfig.env.preview ?? {};
  generatedWorkerConfig.env.preview.kv_namespaces = [
    {
      binding: 'METAR_CACHE',
      id: cacheNamespaceId
    }
  ];

  const generatedPagesConfig = JSON.parse(JSON.stringify(pagesConfig));
  generatedPagesConfig.env = generatedPagesConfig.env ?? {};
  generatedPagesConfig.env.preview = generatedPagesConfig.env.preview ?? {};
  generatedPagesConfig.env.preview.services = [
    {
      binding: 'METAR_API',
      service: `${previewWorkerName}${PREVIEW_ENVIRONMENT_SUFFIX}`
    }
  ];

  return { workerConfig: generatedWorkerConfig, pagesConfig: generatedPagesConfig };
}

export function generatePreviewWranglerConfigFiles(environment = process.env) {
  const {
    PREVIEW_WORKER_CONFIG: workerConfigPath,
    PREVIEW_PAGES_CONFIG: pagesConfigPath,
    METAR_WORKER_NAME: workerName,
    PULL_REQUEST_NUMBER: pullRequestNumber,
    METAR_CACHE_PREVIEW_NAMESPACE_ID: cacheNamespaceId
  } = environment;
  if (!workerConfigPath || !pagesConfigPath) {
    throw new Error('PREVIEW_WORKER_CONFIG and PREVIEW_PAGES_CONFIG are required.');
  }

  const workerConfig = JSON.parse(readFileSync('workers/metar-proxy/wrangler.jsonc', 'utf8'));
  const pagesConfig = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  const generated = buildPreviewWranglerConfigs({
    workerConfig,
    pagesConfig,
    workerName,
    pullRequestNumber,
    cacheNamespaceId
  });

  writeFileSync(workerConfigPath, `${JSON.stringify(generated.workerConfig, null, 2)}\n`);
  writeFileSync(pagesConfigPath, `${JSON.stringify(generated.pagesConfig, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generatePreviewWranglerConfigFiles();
}
