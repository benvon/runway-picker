import { createBuildMetadata, type BuildMetadata } from '../buildMetadata';

interface VersionManifestPayload {
  version: string;
  commitSha: string;
}

function isVersionManifestPayload(payload: unknown): payload is VersionManifestPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const candidate = payload as Record<string, unknown>;
  return typeof candidate.version === 'string' && typeof candidate.commitSha === 'string';
}

function buildVersionManifestUrl(cacheBust: number = Date.now()): string {
  return `/version.json?ts=${encodeURIComponent(String(cacheBust))}`;
}

export async function fetchLatestBuildMetadata(fetchFn: typeof fetch = fetch): Promise<BuildMetadata | null> {
  try {
    const response = await fetchFn(buildVersionManifestUrl(), {
      method: 'GET',
      cache: 'no-store',
      headers: {
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json().catch(() => null);
    if (!isVersionManifestPayload(payload)) {
      return null;
    }

    return createBuildMetadata({
      version: payload.version,
      commitSha: payload.commitSha
    });
  } catch {
    return null;
  }
}
