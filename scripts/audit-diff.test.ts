import { describe, expect, it } from 'vitest';
import {
  addedBlockingAdvisories,
  comparePullRequestAudits,
  parseAuditReport,
  resolveBaseRef
} from './audit-diff.mjs';

function reportWith(packageName: string, id: string, severity = 'high', title = `${packageName} issue`) {
  return {
    vulnerabilities: {
      [packageName]: {
        name: packageName,
        severity,
        via: [{
          source: id,
          name: packageName,
          dependency: packageName,
          title,
          url: `https://github.com/advisories/${id}`,
          severity
        }]
      }
    }
  };
}

describe('pull request audit diff', () => {
  it('ignores a high advisory that already exists on the base branch', () => {
    const base = reportWith('brace-expansion', 'GHSA-base');
    const head = reportWith('brace-expansion', 'GHSA-base');

    expect(addedBlockingAdvisories(base, head)).toEqual([]);
  });

  it('reports a high advisory the pull request adds', () => {
    const base = reportWith('brace-expansion', 'GHSA-base');
    const head = {
      vulnerabilities: {
        ...base.vulnerabilities,
        undici: reportWith('undici', 'GHSA-new').vulnerabilities.undici
      }
    };

    expect(addedBlockingAdvisories(base, head)).toEqual([{
      packageName: 'undici',
      severity: 'high',
      title: 'undici issue',
      id: 'https://github.com/advisories/GHSA-new'
    }]);
  });

  it('treats critical advisories as blocking and ignores moderate ones', () => {
    const base = { vulnerabilities: {} };
    const head = {
      vulnerabilities: {
        ...reportWith('left-pad', 'GHSA-mod', 'moderate').vulnerabilities,
        ...reportWith('proto', 'GHSA-crit', 'critical').vulnerabilities
      }
    };

    expect(addedBlockingAdvisories(base, head).map((advisory) => advisory.id)).toEqual([
      'https://github.com/advisories/GHSA-crit'
    ]);
  });

  it('does not treat a removed advisory or a dependency-only via entry as a new finding', () => {
    const base = reportWith('brace-expansion', 'GHSA-base');
    const head = {
      vulnerabilities: {
        minimatch: {
          name: 'minimatch',
          severity: 'high',
          via: ['brace-expansion']
        }
      }
    };

    expect(addedBlockingAdvisories(base, head)).toEqual([]);
  });

  it('rejects audit output that is not a report', () => {
    expect(() => parseAuditReport('not-json')).toThrow(/JSON/);
    expect(() => parseAuditReport(JSON.stringify({ error: { summary: 'audit endpoint returned an error' } }))).toThrow(
      /audit endpoint returned an error/
    );
  });

  it('audits the head tree before checking out the base branch', () => {
    const calls: string[] = [];
    const result = comparePullRequestAudits({
      baseRef: 'main',
      readAudit: () => {
        calls.push('audit');
        return calls.filter((call) => call === 'audit').length === 1
          ? reportWith('undici', 'GHSA-new')
          : { vulnerabilities: {} };
      },
      run: (command: string, args: string[]) => {
        calls.push(`${command} ${args[0]}`);
        return { status: 0 };
      }
    });

    expect(result.exitCode).toBe(1);
    expect(result.messages.join('\n')).toContain('undici');
    expect(calls.slice(0, 2)).toEqual(['audit', 'git fetch']);
  });

  it('passes when the head tree adds no blocking advisory', () => {
    const calls: string[] = [];
    const result = comparePullRequestAudits({
      baseRef: 'main',
      readAudit: () => reportWith('brace-expansion', 'GHSA-base'),
      run: (command: string) => {
        calls.push(command);
        return { status: 0 };
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.messages[0]).toMatch(/No new high or critical advisories/);
    expect(calls).toEqual(['git', 'git', 'npm']);
  });

  it('compares against the fetched base commit instead of the live branch tip', () => {
    const baseSha = 'a'.repeat(40);
    const commands: string[][] = [];
    const result = comparePullRequestAudits({
      baseRef: baseSha,
      readAudit: () => reportWith('brace-expansion', 'GHSA-base'),
      run: (command: string, args: string[]) => {
        commands.push([command, ...args]);
        return { status: 0 };
      }
    });

    expect(result.exitCode).toBe(0);
    expect(commands[0]).toEqual(['git', 'fetch', '--depth=1', 'origin', baseSha]);
    expect(commands[1]).toEqual(['git', 'checkout', 'FETCH_HEAD', '--', 'package.json', 'package-lock.json']);
  });

  it('stops when the base ref is missing or the base branch cannot be fetched', () => {
    const missing = comparePullRequestAudits({
      baseRef: '',
      readAudit: () => {
        throw new Error('should not audit');
      },
      run: () => {
        throw new Error('should not run');
      }
    });
    const fetchFailed = comparePullRequestAudits({
      baseRef: 'main',
      readAudit: () => ({ vulnerabilities: {} }),
      run: () => ({ status: 128 })
    });

    expect(missing.exitCode).toBe(1);
    expect(missing.messages[0]).toMatch(/BASE_REF/);
    expect(fetchFailed.exitCode).toBe(128);
    expect(fetchFailed.messages[0]).toMatch(/fetch/);
  });

  it('reads the base commit from the pull request event when BASE_REF is unset', () => {
    const baseSha = 'b'.repeat(40);
    expect(resolveBaseRef({
      env: { GITHUB_EVENT_PATH: 'event.json' },
      readEvent: () => ({ pull_request: { base: { ref: 'main', sha: baseSha } } })
    })).toBe(baseSha);

    expect(resolveBaseRef({
      env: { GITHUB_EVENT_PATH: 'event.json' },
      readEvent: () => ({ pull_request: { base: { ref: 'main' } } })
    })).toBe('');

    expect(resolveBaseRef({
      env: { BASE_REF: 'release' },
      readEvent: () => {
        throw new Error('should prefer BASE_REF');
      }
    })).toBe('release');
  });
});
