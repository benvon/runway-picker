const TAG_PATTERN = /^v\d+\.\d+\.\d+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

export const ReleaseAction = Object.freeze({
  SKIP: 'skip',
  CREATE_TAG_AND_RELEASE: 'create-tag-and-release',
  CREATE_RELEASE: 'create-release',
  COMPLETE: 'complete'
});

/**
 * Reject an event that is no longer the current protected main commit. Release
 * creation and automatic deployment are only safe for the current main tip;
 * deploying an older release is an explicit rollback operation.
 *
 * @param {{targetSha: string, currentMainSha: string, mainProtected: boolean}} state
 */
export function assertCurrentProtectedMainTarget(state) {
  if (!SHA_PATTERN.test(state.targetSha) || !SHA_PATTERN.test(state.currentMainSha)) {
    throw new Error('Release target and current main must be full lowercase Git commit SHAs.');
  }

  if (!state.mainProtected) {
    throw new Error('Automatic release requires the main branch to be protected.');
  }

  if (state.targetSha !== state.currentMainSha) {
    throw new Error(
      `Release target ${state.targetSha} is not the current protected main commit ${state.currentMainSha}.`
    );
  }
}

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
 *   latestStableTag: string | null,
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
    if (state.latestStableTag !== state.nextTag) {
      throw new Error(
        `Existing release ${state.nextTag} is not the latest published stable release ${state.latestStableTag ?? '(none)'}.`
      );
    }

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
