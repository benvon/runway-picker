import { describe, expect, it } from 'vitest';
import { findSecretFindings, formatSecretFinding, runSecretScan } from './scan-secrets.mjs';

const fakeGitHubToken = `ghp_${'a'.repeat(36)}`;
const config = {
  ignorePathPatterns: ['^ignored/'],
  rules: [{ name: 'GitHub personal access token', pattern: 'ghp_[0-9A-Za-z]{36}' }]
};

describe('secret scanner reporting', () => {
  it('detects a secret without retaining or reporting the matched source content', () => {
    const findings = findSecretFindings({
      files: ['config/example.env'],
      readFile: () => `TOKEN=${fakeGitHubToken}`,
      config
    });

    expect(findings).toEqual([{
      filePath: 'config/example.env',
      line: 1,
      rule: 'GitHub personal access token'
    }]);
    expect(formatSecretFinding(findings[0])).toBe('- config/example.env:1 [GitHub personal access token]');
    expect(JSON.stringify(findings)).not.toContain(fakeGitHubToken);
  });

  it('prints only location and rule when the command fails', () => {
    const output: string[] = [];
    const exitCode = runSecretScan({
      files: ['config/example.env'],
      readFile: () => `TOKEN=${fakeGitHubToken}`,
      config,
      writeError: (line: string) => output.push(line),
      writeInfo: (line: string) => output.push(line)
    });

    expect(exitCode).toBe(1);
    expect(output.join('\n')).toContain('config/example.env:1 [GitHub personal access token]');
    expect(output.join('\n')).not.toContain(fakeGitHubToken);
  });

  it('keeps ignored files and explicitly allowed lines out of findings', () => {
    const findings = findSecretFindings({
      files: ['ignored/example.env', 'config/allowed.env'],
      readFile: (filePath: string) => filePath.startsWith('ignored')
        ? `TOKEN=${fakeGitHubToken}`
        : `TOKEN=${fakeGitHubToken} # secret-scan:allow`,
      config
    });

    expect(findings).toEqual([]);
  });
});
