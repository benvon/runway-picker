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
 * Resolve a lightweight or annotated Git tag object to its immutable commit
 * target. Release target_commitish is deliberately not considered here: it is
 * creation metadata and may be a branch name.
 *
 * @param {{type: string, sha: string}} object
 * @param {(tagSha: string) => Promise<{object: {type: string, sha: string}}> } getAnnotatedTag
 */
export async function resolveTagCommitSha(object, getAnnotatedTag) {
  const visitedTagObjects = new Set();
  let currentObject = object;

  while (currentObject.type === 'tag') {
    if (!SHA_PATTERN.test(currentObject.sha)) {
      throw new Error('Annotated tag object must contain a full lowercase Git SHA.');
    }

    if (visitedTagObjects.has(currentObject.sha)) {
      throw new Error('Annotated tag object graph contains a cycle.');
    }
    visitedTagObjects.add(currentObject.sha);

    let annotatedTag;
    try {
      annotatedTag = await getAnnotatedTag(currentObject.sha);
    } catch (error) {
      throw new Error(`Unable to resolve annotated tag object ${currentObject.sha}.`, { cause: error });
    }

    if (!annotatedTag?.object) {
      throw new Error(`Annotated tag object ${currentObject.sha} has no target object.`);
    }
    currentObject = annotatedTag.object;
  }

  if (currentObject.type !== 'commit' || !SHA_PATTERN.test(currentObject.sha)) {
    throw new Error('Release tag must resolve to a full lowercase Git commit SHA.');
  }

  return currentObject.sha;
}

/**
 * @typedef {{tagName: string, draft: boolean, prerelease: boolean, targetCommitish?: string}} ExistingRelease
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
