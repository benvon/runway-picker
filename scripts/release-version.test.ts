import { describe, expect, it } from 'vitest';
import {
  bumpTag,
  classifyCommitMessage,
  computeReleasePlan,
  parseTagVersion,
  selectReleaseBump
} from './release-version.js';

describe('release-version script', () => {
  it('parses semver tags', () => {
    expect(parseTagVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it('throws for invalid semver tags', () => {
    expect(() => parseTagVersion('1.2.3')).toThrow('Invalid version tag');
  });

  it('bumps tags based on bump type', () => {
    expect(bumpTag('v1.2.3', 'major')).toBe('v2.0.0');
    expect(bumpTag('v1.2.3', 'minor')).toBe('v1.3.0');
    expect(bumpTag('v1.2.3', 'patch')).toBe('v1.2.4');
  });

  it('classifies conventional commit signals', () => {
    expect(classifyCommitMessage('fix(api): retry failed fetches')).toBe('patch');
    expect(classifyCommitMessage('perf(worker): reduce KV writes')).toBe('patch');
    expect(classifyCommitMessage('feat(ui): add release footer')).toBe('minor');
    expect(classifyCommitMessage('feat(ui)!: remove legacy panel')).toBe('major');
    expect(classifyCommitMessage('docs: update readme')).toBeNull();
  });

  it('detects BREAKING CHANGE footers', () => {
    expect(
      classifyCommitMessage(
        `chore: update contract\n\nBREAKING CHANGE: remove v1 response field`
      )
    ).toBe('major');
  });

  it('chooses highest release bump across commit set', () => {
    expect(
      selectReleaseBump([
        'docs: update cache runbook',
        'fix(ui): align footer text',
        'feat(api): include cache metadata'
      ])
    ).toBe('minor');

    expect(
      selectReleaseBump([
        'fix(ui): align footer text',
        'feat(api)!: remove legacy endpoint'
      ])
    ).toBe('major');

    expect(selectReleaseBump(['docs: update readme', 'chore(ci): bump action pin'])).toBeNull();
  });

  it('returns no-release plan when commits are not releasable', () => {
    expect(
      computeReleasePlan('v1.2.3', ['docs: refresh examples', 'chore: tidy configs'])
    ).toEqual({
      shouldRelease: false,
      bumpType: null,
      currentTag: 'v1.2.3',
      nextTag: null
    });
  });

  it('returns release plan for releasable commits', () => {
    expect(computeReleasePlan('v1.2.3', ['fix(ui): align footer text'])).toEqual({
      shouldRelease: true,
      bumpType: 'patch',
      currentTag: 'v1.2.3',
      nextTag: 'v1.2.4'
    });
  });
});
