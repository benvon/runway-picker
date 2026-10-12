#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const blockingSeverities = new Set(['high', 'critical']);

function advisoryKey(advisory) {
  return `${advisory.packageName}\n${advisory.id}`;
}

function advisoryId(via, packageName) {
  if (typeof via.url === 'string' && via.url.length > 0) {
    return via.url;
  }

  if (via.source !== undefined && via.source !== null) {
    return String(via.source);
  }

  return `${packageName}:${typeof via.title === 'string' ? via.title : 'unknown'}`;
}

function toAdvisory(packageName, vulnerability, via) {
  const severity = typeof via.severity === 'string' ? via.severity : vulnerability.severity;
  if (!blockingSeverities.has(severity)) {
    return null;
  }

  return {
    packageName,
    severity,
    title: typeof via.title === 'string' ? via.title : packageName,
    id: advisoryId(via, packageName)
  };
}

function advisoriesFromVulnerability(vulnerability) {
  if (!vulnerability || typeof vulnerability !== 'object') {
    return [];
  }

  const packageName = typeof vulnerability.name === 'string' ? vulnerability.name : 'unknown';
  const vias = Array.isArray(vulnerability.via) ? vulnerability.via : [];

  return vias
    .filter((via) => via && typeof via === 'object')
    .map((via) => toAdvisory(packageName, vulnerability, via))
    .filter((advisory) => advisory !== null);
}

function dedupeAdvisories(advisories) {
  const seen = new Set();
  const unique = [];

  for (const advisory of advisories) {
    const key = advisoryKey(advisory);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(advisory);
  }

  unique.sort((left, right) => advisoryKey(left).localeCompare(advisoryKey(right)));
  return unique;
}

export function blockingAdvisories(report) {
  const vulnerabilities = report?.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== 'object') {
    return [];
  }

  const advisories = Object.values(vulnerabilities).flatMap((vulnerability) =>
    advisoriesFromVulnerability(vulnerability)
  );

  return dedupeAdvisories(advisories);
}

export function addedBlockingAdvisories(baseReport, headReport) {
  const baseKeys = new Set(blockingAdvisories(baseReport).map((advisory) => advisoryKey(advisory)));
  return blockingAdvisories(headReport).filter((advisory) => !baseKeys.has(advisoryKey(advisory)));
}

export function parseAuditReport(stdout) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error('npm audit did not return JSON');
  }

  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('npm audit did not return a report object');
  }

  if (report.error) {
    const summary = typeof report.error.summary === 'string' ? report.error.summary : 'npm audit failed';
    throw new Error(summary);
  }

  return report;
}

export function resolveBaseRef({ env = process.env, readEvent = (filePath) => JSON.parse(readFileSync(filePath, 'utf8')) } = {}) {
  if (typeof env.BASE_REF === 'string' && env.BASE_REF.length > 0) {
    return env.BASE_REF;
  }

  if (typeof env.GITHUB_EVENT_PATH !== 'string' || env.GITHUB_EVENT_PATH.length === 0) {
    return '';
  }

  try {
    const event = readEvent(env.GITHUB_EVENT_PATH);
    const ref = event?.pull_request?.base?.ref;
    return typeof ref === 'string' ? ref : '';
  } catch {
    return '';
  }
}

function isBranchName(baseRef) {
  return typeof baseRef === 'string'
    && baseRef.length > 0
    && !baseRef.includes('..')
    && /^[A-Za-z0-9._/-]+$/.test(baseRef);
}

function readReport(readAudit) {
  try {
    return { report: readAudit() };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'npm audit failed';
    return { failure: { exitCode: 1, messages: [message] } };
  }
}

function runStep(run, command, args, failureMessage) {
  const result = run(command, args);
  if (result?.status === 0) {
    return null;
  }

  return {
    exitCode: result?.status ?? 1,
    messages: [failureMessage]
  };
}

function formatAdvisory(advisory) {
  return `- ${advisory.packageName} (${advisory.severity}): ${advisory.title} [${advisory.id}]`;
}

function auditComparisonResult(baseReport, headReport) {
  const added = addedBlockingAdvisories(baseReport, headReport);
  if (added.length === 0) {
    return {
      exitCode: 0,
      messages: ['No new high or critical advisories compared with the base branch.']
    };
  }

  return {
    exitCode: 1,
    messages: [
      'This pull request adds high or critical advisories:',
      ...added.map((advisory) => formatAdvisory(advisory))
    ]
  };
}

export function comparePullRequestAudits({ baseRef, run, readAudit }) {
  if (!isBranchName(baseRef)) {
    return { exitCode: 1, messages: ['BASE_REF must be a branch name.'] };
  }

  const head = readReport(readAudit);
  if (head.failure) {
    return head.failure;
  }

  const fetchFailure = runStep(
    run,
    'git',
    ['fetch', '--depth=1', 'origin', baseRef],
    'Failed to fetch the base branch.'
  );
  if (fetchFailure) {
    return fetchFailure;
  }

  const checkoutFailure = runStep(
    run,
    'git',
    ['checkout', `origin/${baseRef}`, '--', 'package.json', 'package-lock.json'],
    'Failed to check out the base branch manifests.'
  );
  if (checkoutFailure) {
    return checkoutFailure;
  }

  const installFailure = runStep(run, 'npm', ['ci'], 'Failed to install base branch dependencies.');
  if (installFailure) {
    return installFailure;
  }

  const base = readReport(readAudit);
  if (base.failure) {
    return base.failure;
  }

  return auditComparisonResult(base.report, head.report);
}

function readInstalledAudit(spawn) {
  const result = spawn('npm', ['audit', '--json'], { encoding: 'utf8' });
  if (result.error) {
    throw new Error(result.error.message);
  }

  try {
    return parseAuditReport(result.stdout ?? '');
  } catch (error) {
    const detail = `${result.stderr ?? ''}`.trim();
    if (detail.length > 0) {
      console.error(detail);
    }
    throw error;
  }
}

function runAuditAgainstBase() {
  const result = comparePullRequestAudits({
    baseRef: resolveBaseRef(),
    run: (command, args) => spawnSync(command, args, { stdio: 'inherit', encoding: 'utf8' }),
    readAudit: () => readInstalledAudit(spawnSync)
  });

  for (const message of result.messages) {
    if (result.exitCode === 0) {
      console.log(message);
    } else {
      console.error(message);
    }
  }

  return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runAuditAgainstBase();
}
