import { describe, expect, it } from 'vitest';
import { readBuildMetadata } from './buildMetadata';

describe('buildMetadata', () => {
  it('normalizes version and short commit SHA for footer label', () => {
    expect(
      readBuildMetadata({
        VITE_APP_VERSION: '1.2.3',
        VITE_APP_COMMIT_SHA: 'ABCDEF1234567890'
      })
    ).toEqual({
      version: 'v1.2.3',
      commitSha: 'abcdef1234567890',
      shortCommitSha: 'abcdef1',
      footerLabel: 'v1.2.3 (abcdef1)'
    });
  });

  it('normalizes uppercase V prefixes to canonical lowercase v', () => {
    expect(
      readBuildMetadata({
        VITE_APP_VERSION: 'V2.3.4',
        VITE_APP_COMMIT_SHA: '0123456789abcdef'
      }).version
    ).toBe('v2.3.4');
  });

  it('falls back when metadata is missing or invalid', () => {
    expect(
      readBuildMetadata({
        VITE_APP_VERSION: '',
        VITE_APP_COMMIT_SHA: 'not-a-sha'
      })
    ).toEqual({
      version: 'v0.0.0-dev',
      commitSha: 'local',
      shortCommitSha: 'local',
      footerLabel: 'v0.0.0-dev (local)'
    });
  });
});
