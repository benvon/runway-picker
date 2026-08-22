import { describe, expect, it } from 'vitest';
import { reconcileReleaseState, ReleaseAction } from './release-state.js';

const targetSha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const nextTag = 'v1.2.4';

describe('release state reconciliation', () => {
  it('creates a tag and release for a fresh releasable commit', () => {
    expect(
      reconcileReleaseState({
        shouldRelease: true,
        nextTag,
        targetSha,
        tagSha: null,
        release: null
      })
    ).toEqual({
      action: ReleaseAction.CREATE_TAG_AND_RELEASE,
      shouldRelease: true,
      releaseTag: nextTag
    });
  });

  it('resumes an orphan tag at the CI-gated commit without creating another tag', () => {
    expect(
      reconcileReleaseState({
        shouldRelease: true,
        nextTag,
        targetSha,
        tagSha: targetSha,
        release: null
      })
    ).toEqual({
      action: ReleaseAction.CREATE_RELEASE,
      shouldRelease: true,
      releaseTag: nextTag
    });
  });

  it('treats an existing matching published release as complete so deploy reruns remain enabled', () => {
    expect(
      reconcileReleaseState({
        shouldRelease: true,
        nextTag,
        targetSha,
        tagSha: targetSha,
        release: {
          tagName: nextTag,
          targetCommitish: targetSha,
          draft: false,
          prerelease: false
        }
      })
    ).toEqual({
      action: ReleaseAction.COMPLETE,
      shouldRelease: true,
      releaseTag: nextTag
    });
  });

  it('skips release mutation when the commit range has no releasable changes', () => {
    expect(
      reconcileReleaseState({
        shouldRelease: false,
        nextTag: null,
        targetSha,
        tagSha: null,
        release: null
      })
    ).toEqual({
      action: ReleaseAction.SKIP,
      shouldRelease: false,
      releaseTag: null
    });
  });

  it('fails closed when an intended tag resolves to a different commit', () => {
    expect(() =>
      reconcileReleaseState({
        shouldRelease: true,
        nextTag,
        targetSha,
        tagSha: otherSha,
        release: null
      })
    ).toThrow(`Release tag ${nextTag} resolves to ${otherSha}`);
  });

  it('fails closed when a release disagrees with the intended tag or target', () => {
    expect(() =>
      reconcileReleaseState({
        shouldRelease: true,
        nextTag,
        targetSha,
        tagSha: targetSha,
        release: {
          tagName: nextTag,
          targetCommitish: otherSha,
          draft: false,
          prerelease: false
        }
      })
    ).toThrow('does not match the required published release');
  });

  it('fails closed when a release exists without its tag', () => {
    expect(() =>
      reconcileReleaseState({
        shouldRelease: true,
        nextTag,
        targetSha,
        tagSha: null,
        release: {
          tagName: nextTag,
          targetCommitish: targetSha,
          draft: false,
          prerelease: false
        }
      })
    ).toThrow('has no corresponding Git tag');
  });
});
