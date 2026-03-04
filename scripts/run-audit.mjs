#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const args = ['audit', '--audit-level=high'];
const result = spawnSync('npm', args, {
  encoding: 'utf8',
  shell: false
});

if (typeof result.stdout === 'string' && result.stdout.length > 0) {
  process.stdout.write(result.stdout);
}

if (typeof result.stderr === 'string' && result.stderr.length > 0) {
  process.stderr.write(result.stderr);
}

if (result.status === 0) {
  process.exit(0);
}

const isCi = `${process.env.CI ?? ''}`.toLowerCase() === 'true';
const stderr = `${result.stderr ?? ''}`;
const stdout = `${result.stdout ?? ''}`;
const networkFailure = /ENOTFOUND|EAI_AGAIN|network|audit endpoint returned an error/i.test(`${stdout}\n${stderr}`);

if (!isCi && networkFailure) {
  console.warn('npm audit could not reach the registry in local mode; skipping failure outside CI.');
  process.exit(0);
}

process.exit(result.status ?? 1);
