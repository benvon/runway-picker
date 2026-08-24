#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function shouldIgnore(path, ignoreMatchers) {
  return ignoreMatchers.some((matcher) => matcher.test(path));
}

function getFiles() {
  const output = execSync('git ls-files', { encoding: 'utf8' }).trim();
  if (!output) {
    return [];
  }

  return output.split('\n');
}

export function findSecretFindings({ files, readFile, config }) {
  const ignoreMatchers = (config.ignorePathPatterns ?? []).map((pattern) => new RegExp(pattern));
  const rules = (config.rules ?? []).map((rule) => ({
    name: rule.name,
    regex: new RegExp(rule.pattern, 'g')
  }));
  const findings = [];

  for (const filePath of files) {
    if (shouldIgnore(filePath, ignoreMatchers)) {
      continue;
    }

    let content;
    try {
      content = readFile(filePath);
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
        if (rule.regex.exec(line)) {
          findings.push({
            filePath,
            line: index + 1,
            rule: rule.name
          });
        }
      }
    }
  }

  return findings;
}

export function formatSecretFinding(finding) {
  return `- ${finding.filePath}:${finding.line} [${finding.rule}]`;
}

export function runSecretScan({
  config = JSON.parse(readFileSync('secret-scan.config.json', 'utf8')),
  files = getFiles(),
  readFile = (filePath) => readFileSync(filePath, 'utf8'),
  writeError = console.error,
  writeInfo = console.log
} = {}) {
  const findings = findSecretFindings({ files, readFile, config });
  if (findings.length === 0) {
    writeInfo('Secret scan passed with no findings.');
    return 0;
  }

  writeError(`Secret scan failed with ${findings.length} finding(s):`);
  for (const finding of findings) {
    writeError(formatSecretFinding(finding));
  }

  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runSecretScan();
}
