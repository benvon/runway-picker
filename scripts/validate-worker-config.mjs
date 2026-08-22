#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parse, printParseErrorCode } from 'jsonc-parser';

const REQUIRED_BINDING = 'API_RATE_LIMITER';
const REQUIRED_CLASS = 'ApiRateLimiter';

function parseJsonc(content) {
  const errors = [];
  const config = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false
  });
  if (errors.length > 0) {
    throw new Error(errors.map(({ error, offset }) => `${printParseErrorCode(error)} at offset ${offset}`).join(', '));
  }

  return config;
}

export function validateWorkerConfig(config) {
  const bindings = config?.durable_objects?.bindings;
  const hasRateLimiterBinding = Array.isArray(bindings) && bindings.some(
    (binding) => binding?.name === REQUIRED_BINDING && binding?.class_name === REQUIRED_CLASS
  );
  if (!hasRateLimiterBinding) {
    return `missing Durable Object binding '${REQUIRED_BINDING}' for '${REQUIRED_CLASS}'`;
  }

  const migrations = config?.migrations;
  const hasRateLimiterMigration = Array.isArray(migrations) && migrations.some(
    (migration) => Array.isArray(migration?.new_sqlite_classes) && migration.new_sqlite_classes.includes(REQUIRED_CLASS)
  );
  if (!hasRateLimiterMigration) {
    return `missing Durable Object migration for '${REQUIRED_CLASS}'`;
  }

  return null;
}

export function validateWorkerConfigFile(configPath) {
  let config;
  try {
    config = parseJsonc(readFileSync(configPath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    return `unable to parse ${configPath}: ${reason}`;
  }

  return validateWorkerConfig(config);
}

if (process.argv[1]?.endsWith('validate-worker-config.mjs')) {
  const configPath = process.argv[2] ?? 'workers/metar-proxy/wrangler.jsonc';
  const error = validateWorkerConfigFile(configPath);
  if (error) {
    console.error(`Worker configuration validation failed: ${error}`);
    process.exit(1);
  }

  console.log(`Worker configuration validation passed for ${configPath}.`);
}
