import { describe, expect, it } from 'vitest';
import { bumpTag, bumpTypeFromBranch, nextTagForBranch, parseTagVersion } from './semver.js';

describe('semver release script', () => {
  it('detects bump type from branch name', () => {
    expect(bumpTypeFromBranch('release/replatform')).toBe('major');
    expect(bumpTypeFromBranch('feature/metar-parser')).toBe('minor');
    expect(bumpTypeFromBranch('fix/crosswind-direction')).toBe('patch');
  });

  it('parses tags correctly', () => {
    expect(parseTagVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it('bumps tags correctly by bump type', () => {
    expect(bumpTag('v1.2.3', 'major')).toBe('v2.0.0');
    expect(bumpTag('v1.2.3', 'minor')).toBe('v1.3.0');
    expect(bumpTag('v1.2.3', 'patch')).toBe('v1.2.4');
  });

  it('computes next tag directly from branch + current tag', () => {
    expect(nextTagForBranch('v0.1.0', 'feature/ui-refresh')).toBe('v0.2.0');
  });
});
