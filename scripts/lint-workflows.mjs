#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const workflowsDir = '.github/workflows';
const files = readdirSync(workflowsDir)
  .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
  .sort();

const errors = [];

for (const file of files) {
  const filePath = join(workflowsDir, file);
  const content = readFileSync(filePath, 'utf8');

  if (!/^name:\s+/m.test(content)) {
    errors.push(`${filePath}: missing top-level 'name'`);
  }

  if (!/^on:\s*/m.test(content)) {
    errors.push(`${filePath}: missing top-level 'on'`);
  }

  if (!/^jobs:\s*/m.test(content)) {
    errors.push(`${filePath}: missing top-level 'jobs'`);
  }

  if (/\t/.test(content)) {
    errors.push(`${filePath}: contains tab characters`);
  }

  const usesLines = content
    .split(/\r?\n/g)
    .filter((line) => line.trimStart().startsWith('uses: '));

  for (const line of usesLines) {
    const usesValue = line.trimStart().slice('uses: '.length).trim();
    if (!usesValue.includes('@') && !usesValue.startsWith('docker://')) {
      errors.push(`${filePath}: invalid action reference '${usesValue}'`);
    }
  }
}

if (errors.length > 0) {
  console.error('Workflow lint failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Workflow lint passed for ${files.length} file(s).`);
