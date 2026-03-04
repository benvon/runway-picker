#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const configPath = 'secret-scan.config.json';
const config = JSON.parse(readFileSync(configPath, 'utf8'));

const ignoreMatchers = (config.ignorePathPatterns ?? []).map((pattern) => new RegExp(pattern));
const rules = (config.rules ?? []).map((rule) => ({
  name: rule.name,
  regex: new RegExp(rule.pattern, 'g')
}));

function shouldIgnore(path) {
  return ignoreMatchers.some((matcher) => matcher.test(path));
}

function getFiles() {
  const output = execSync('git ls-files', { encoding: 'utf8' }).trim();
  if (!output) {
    return [];
  }

  return output.split('\n');
}

const findings = [];

for (const filePath of getFiles()) {
  if (shouldIgnore(filePath)) {
    continue;
  }

  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    continue;
  }

  const lines = content.split(/\r?\n/g);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.includes('secret-scan:allow')) {
      continue;
    }

    for (const rule of rules) {
      rule.regex.lastIndex = 0;
      const match = rule.regex.exec(line);
      if (match) {
        findings.push({
          filePath,
          line: index + 1,
          rule: rule.name,
          snippet: line.trim().slice(0, 140)
        });
      }
    }
  }
}

if (findings.length > 0) {
  console.error(`Secret scan failed with ${findings.length} finding(s):`);
  for (const finding of findings) {
    console.error(`- ${finding.filePath}:${finding.line} [${finding.rule}] ${finding.snippet}`);
  }
  process.exit(1);
}

console.log('Secret scan passed with no findings.');
