#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const workflowsDir = '.github/workflows';
const files = readdirSync(workflowsDir)
  .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
  .sort();

const errors = [];

function findGitHubExpressionsInRunBlocks(content) {
  const errors = [];
  const lines = content.split(/\r?\n/g);
  let runBlockIndentation = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const runMatch = line.match(/^(\s*)run:\s*(.*)$/);

    if (runBlockIndentation !== null) {
      const indentation = line.match(/^\s*/)[0].length;
      if (line.trim() && indentation <= runBlockIndentation) {
        runBlockIndentation = null;
      }
    }

    if (runBlockIndentation !== null && line.includes('${{')) {
      errors.push(index + 1);
      continue;
    }

    if (!runMatch) {
      continue;
    }

    const [, indentation, value] = runMatch;
    if (value.includes('${{')) {
      errors.push(index + 1);
    }

    if (/^[>|]/.test(value.trim())) {
      runBlockIndentation = indentation.length;
    }
  }

  return errors;
}

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
    if (
      !usesValue.includes('@') &&
      !usesValue.startsWith('docker://') &&
      !usesValue.startsWith('./.github/workflows/')
    ) {
      errors.push(`${filePath}: invalid action reference '${usesValue}'`);
    }
  }

  for (const lineNumber of findGitHubExpressionsInRunBlocks(content)) {
    errors.push(
      `${filePath}:${lineNumber}: GitHub expressions must be passed through step env, not interpolated into run blocks`
    );
  }

  if (file === 'deploy-preview.yml') {
    if (!/\n\s*workflow_run:\s*$/m.test(content)) {
      errors.push(`${filePath}: preview deployment must run only after CI through workflow_run`);
    }

    if (!/\n\s*environment:\s*preview\s*$/m.test(content)) {
      errors.push(`${filePath}: preview deployment must require the preview environment`);
    }

    if (/npx wrangler deploy/.test(content) || /AIRPORT_IO_TOKEN/.test(content)) {
      errors.push(`${filePath}: preview deployment must not deploy Worker code or access AirportDB credentials`);
    }
  }

  if (file === 'deploy-production.yml' || file === 'deploy-worker-production.yml') {
    if (!/\n\s*workflow_call:\s*$/m.test(content)) {
      errors.push(`${filePath}: production deployment must be callable only from the release workflow`);
    }

    if (!/\n\s*environment:\s*production\s*$/m.test(content)) {
      errors.push(`${filePath}: production deployment must require the production environment`);
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
