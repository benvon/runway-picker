import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const createdDirectories: string[] = [];

function writeConfig(transform: (config: Record<string, unknown>) => void): string {
  const directory = mkdtempSync(join(tmpdir(), 'runway-picker-worker-config-'));
  createdDirectories.push(directory);
  const configPath = join(directory, 'wrangler.jsonc');
  const config = JSON.parse(readFileSync('workers/metar-proxy/wrangler.jsonc', 'utf8')) as Record<string, unknown>;
  transform(config);
  writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

async function validateConfig(configPath: string): Promise<{ status: number; output: string }> {
  const process = await import('node:child_process');
  return new Promise((resolve, reject) => {
    process.execFile('node', ['scripts/validate-worker-config.mjs', configPath], (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(error);
        return;
      }
      resolve({ status: typeof error?.code === 'number' ? error.code : 0, output: `${stdout}${stderr}` });
    });
  });
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('worker configuration validation', () => {
  it('accepts the production rate limiter binding and migration', async () => {
    const result = await validateConfig('workers/metar-proxy/wrangler.jsonc');
    expect(result.status).toBe(0);
  });

  it('rejects a missing API_RATE_LIMITER binding', async () => {
    const result = await validateConfig(writeConfig((config) => {
      const durableObjects = config.durable_objects as { bindings: unknown[] };
      durableObjects.bindings = durableObjects.bindings.filter(
        (binding) => (binding as { name?: string }).name !== 'API_RATE_LIMITER'
      );
    }));
    expect(result.status).toBe(1);
    expect(result.output).toContain("missing Durable Object binding 'API_RATE_LIMITER'");
  });

  it('rejects a missing API rate limiter migration', async () => {
    const result = await validateConfig(writeConfig((config) => {
      const migrations = config.migrations as Array<{ new_sqlite_classes?: string[] }>;
      for (const migration of migrations) {
        migration.new_sqlite_classes = migration.new_sqlite_classes?.filter((className) => className !== 'ApiRateLimiter');
      }
    }));
    expect(result.status).toBe(1);
    expect(result.output).toContain("missing Durable Object migration for 'ApiRateLimiter'");
  });
});
