import { describe, expect, it } from 'vitest';
import {
  assertCurrentProtectedMainTarget,
  reconcileReleaseState,
  ReleaseAction,
  resolveTagCommitSha
} from './release-state.js';

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
        latestStableTag: null,
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
        latestStableTag: null,
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
        latestStableTag: nextTag,
        release: {
          tagName: nextTag,
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
        latestStableTag: null,
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
        latestStableTag: null,
        release: null
      })
    ).toThrow(`Release tag ${nextTag} resolves to ${otherSha}`);
  });

  it('fails closed when a release disagrees with the intended tag', () => {
    expect(() =>
      reconcileReleaseState({
        shouldRelease: true,
        nextTag,
        targetSha,
        tagSha: targetSha,
        latestStableTag: nextTag,
        release: {
          tagName: 'v1.2.5',
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
        latestStableTag: nextTag,
        release: {
          tagName: nextTag,
          draft: false,
          prerelease: false
        }
      })
    ).toThrow('has no corresponding Git tag');
  });

  it('fails closed when an old run is rerun after a newer stable release is published', () => {
    expect(() =>
      reconcileReleaseState({
        shouldRelease: true,
        nextTag,
        targetSha,
        tagSha: targetSha,
        latestStableTag: 'v1.2.5',
        release: {
          tagName: nextTag,
          draft: false,
          prerelease: false
        }
      })
    ).toThrow('is not the latest published stable release');
  });

  it('fails closed when a rerun follows a non-release commit to main', () => {
    expect(() =>
      assertCurrentProtectedMainTarget({
        targetSha,
        currentMainSha: otherSha,
        mainProtected: true
      })
    ).toThrow('is not the current protected main commit');
  });

  it('fails closed when main branch protection is unavailable', () => {
    expect(() =>
      assertCurrentProtectedMainTarget({
        targetSha,
        currentMainSha: targetSha,
        mainProtected: false
      })
    ).toThrow('main branch to be protected');
  });

  it('uses the immutable tag target when release target_commitish is a branch name', async () => {
    await expect(
      resolveTagCommitSha(
        { type: 'tag', sha: otherSha },
        async () => ({ object: { type: 'commit', sha: targetSha } })
      )
    ).resolves.toBe(targetSha);

    expect(
      reconcileReleaseState({
        shouldRelease: true,
        nextTag,
        targetSha,
        tagSha: targetSha,
        latestStableTag: nextTag,
        release: {
          tagName: nextTag,
          targetCommitish: 'main',
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

  it('peels nested annotated tags to their commit', async () => {
    const nestedTagSha = 'c'.repeat(40);
    const resolved = await resolveTagCommitSha(
      { type: 'tag', sha: otherSha },
      async (tagSha) => {
        if (tagSha === otherSha) {
          return { object: { type: 'tag', sha: nestedTagSha } };
        }
        return { object: { type: 'commit', sha: targetSha } };
      }
    );

    expect(resolved).toBe(targetSha);
  });

  it('fails closed for unresolvable and mismatched tag targets', async () => {
    await expect(
      resolveTagCommitSha({ type: 'blob', sha: targetSha }, async () => {
        throw new Error('not called');
      })
    ).rejects.toThrow('must resolve to a full lowercase Git commit SHA');

    await expect(
      resolveTagCommitSha({ type: 'tag', sha: 'not-a-sha' }, async () => {
        throw new Error('not called');
      })
    ).rejects.toThrow('Annotated tag object must contain a full lowercase Git SHA');

    await expect(
      resolveTagCommitSha({ type: 'tag', sha: otherSha }, async () => {
        throw new Error('not found');
      })
    ).rejects.toThrow('Unable to resolve annotated tag object');
  });
});
