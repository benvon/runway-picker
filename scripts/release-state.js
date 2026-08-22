const TAG_PATTERN = /^v\d+\.\d+\.\d+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

export const ReleaseAction = Object.freeze({
  SKIP: 'skip',
  CREATE_TAG_AND_RELEASE: 'create-tag-and-release',
  CREATE_RELEASE: 'create-release',
  COMPLETE: 'complete'
});

/**
 * @typedef {{tagName: string, targetCommitish: string, draft: boolean, prerelease: boolean}} ExistingRelease
 */

/**
 * Decide whether a release can be safely created or resumed without mutating
 * an existing tag. A tag and release are only interchangeable when both point
 * to the exact CI-gated commit.
 *
 * @param {{
 *   shouldRelease: boolean,
 *   nextTag: string | null,
 *   targetSha: string,
 *   tagSha: string | null,
 *   release: ExistingRelease | null
 * }} state
 */
export function reconcileReleaseState(state) {
  if (!SHA_PATTERN.test(state.targetSha)) {
    throw new Error('Release target must be a full lowercase Git commit SHA.');
  }

  if (!state.shouldRelease) {
    return {
      action: ReleaseAction.SKIP,
      shouldRelease: false,
      releaseTag: null
    };
  }

  if (!state.nextTag || !TAG_PATTERN.test(state.nextTag)) {
    throw new Error('Releasable changes require a valid vX.Y.Z target tag.');
  }

  if (state.tagSha !== null && state.tagSha !== state.targetSha) {
    throw new Error(
      `Release tag ${state.nextTag} resolves to ${state.tagSha}, not CI-gated target ${state.targetSha}.`
    );
  }

  if (state.release !== null) {
    if (
      state.release.tagName !== state.nextTag ||
      state.release.targetCommitish !== state.targetSha ||
      state.release.draft ||
      state.release.prerelease
    ) {
      throw new Error(
        `Existing release for ${state.nextTag} does not match the required published release at ${state.targetSha}.`
      );
    }

    if (state.tagSha === null) {
      throw new Error(
        `Published release ${state.nextTag} has no corresponding Git tag; manual investigation is required.`
      );
    }

    return {
      action: ReleaseAction.COMPLETE,
      shouldRelease: true,
      releaseTag: state.nextTag
    };
  }

  if (state.tagSha === state.targetSha) {
    return {
      action: ReleaseAction.CREATE_RELEASE,
      shouldRelease: true,
      releaseTag: state.nextTag
    };
  }

  return {
    action: ReleaseAction.CREATE_TAG_AND_RELEASE,
    shouldRelease: true,
    releaseTag: state.nextTag
  };
}
