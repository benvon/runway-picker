import { describe, expect, it, vi } from 'vitest';
import { fetchLatestBuildMetadata } from './versionManifest';

describe('version manifest service', () => {
  it('fetches version metadata without caching and normalizes the response', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        version: '1.2.3',
        commitSha: 'ABCDEF1234567890'
      })
    );

    const buildMetadata = await fetchLatestBuildMetadata(fetchMock);

    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^\/version\.json\?ts=\d+$/), {
      method: 'GET',
      cache: 'no-store',
      headers: {
        Accept: 'application/json'
      }
    });
    expect(buildMetadata).toMatchObject({
      version: 'v1.2.3',
      commitSha: 'abcdef1234567890',
      shortCommitSha: 'abcdef1',
      footerLabel: 'v1.2.3 (abcdef1)'
    });
  });

  it('returns null when the manifest payload is malformed', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        version: '1.2.3'
      })
    );

    await expect(fetchLatestBuildMetadata(fetchMock)).resolves.toBeNull();
  });

  it('returns null when the fetch fails or the response is not ok', async () => {
    const failedFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('network down'));
    const errorResponseFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 503, statusText: 'Service Unavailable' }));

    await expect(fetchLatestBuildMetadata(failedFetch)).resolves.toBeNull();
    await expect(fetchLatestBuildMetadata(errorResponseFetch)).resolves.toBeNull();
  });
});
