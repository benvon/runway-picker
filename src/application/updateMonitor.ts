import { isStableReleaseBuild, type BuildIdentity } from '../buildMetadata';

export function shouldEnableUpdateChecks(currentBuild: BuildIdentity): boolean {
  return isStableReleaseBuild(currentBuild);
}

export function shouldPromptForAppUpdate(
  currentBuild: BuildIdentity,
  latestBuild: BuildIdentity | null
): boolean {
  if (!shouldEnableUpdateChecks(currentBuild) || !latestBuild || !isStableReleaseBuild(latestBuild)) {
    return false;
  }

  return currentBuild.version !== latestBuild.version || currentBuild.commitSha !== latestBuild.commitSha;
}
