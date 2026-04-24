import { describe, expect, it } from 'vitest';
import { createBuildMetadata } from '../buildMetadata';
import { shouldEnableUpdateChecks, shouldPromptForAppUpdate } from './updateMonitor';

describe('update monitor', () => {
  it('enables update checks only for stable release builds', () => {
    expect(
      shouldEnableUpdateChecks(createBuildMetadata({ version: 'v1.2.3', commitSha: 'abcdef1234567890' }))
    ).toBe(true);
    expect(
      shouldEnableUpdateChecks(createBuildMetadata({ version: 'pr-42', commitSha: 'abcdef1234567890' }))
    ).toBe(false);
    expect(
      shouldEnableUpdateChecks(createBuildMetadata({ version: 'v0.0.0-dev', commitSha: 'abcdef1234567890' }))
    ).toBe(false);
  });

  it('does not prompt when the fetched build matches the current release', () => {
    const currentBuild = createBuildMetadata({
      version: 'v1.2.3',
      commitSha: 'abcdef1234567890'
    });

    expect(shouldPromptForAppUpdate(currentBuild, currentBuild)).toBe(false);
  });

  it('treats a version mismatch as an available update', () => {
    const currentBuild = createBuildMetadata({
      version: 'v1.2.3',
      commitSha: 'abcdef1234567890'
    });
    const latestBuild = createBuildMetadata({
      version: 'v1.2.4',
      commitSha: 'abcdef1234567890'
    });

    expect(shouldPromptForAppUpdate(currentBuild, latestBuild)).toBe(true);
  });

  it('treats a commit mismatch as an available update', () => {
    const currentBuild = createBuildMetadata({
      version: 'v1.2.3',
      commitSha: 'abcdef1234567890'
    });
    const latestBuild = createBuildMetadata({
      version: 'v1.2.3',
      commitSha: '0123456789abcdef'
    });

    expect(shouldPromptForAppUpdate(currentBuild, latestBuild)).toBe(true);
  });
});
