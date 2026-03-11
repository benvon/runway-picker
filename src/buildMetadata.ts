export interface BuildMetadata {
  version: string;
  commitSha: string;
  shortCommitSha: string;
  footerLabel: string;
}

interface BuildMetadataEnv {
  VITE_APP_VERSION?: string;
  VITE_APP_COMMIT_SHA?: string;
}

const DEFAULT_VERSION = 'v0.0.0-dev';
const DEFAULT_COMMIT_SHA = 'local';

function normalizeVersion(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) {
    return DEFAULT_VERSION;
  }

  if (raw.startsWith('v')) {
    return raw;
  }

  return `v${raw}`;
}

function normalizeCommitSha(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) {
    return DEFAULT_COMMIT_SHA;
  }

  const candidate = raw.toLowerCase();
  if (/^[a-f0-9]{7,40}$/.test(candidate)) {
    return candidate;
  }

  return DEFAULT_COMMIT_SHA;
}

export function readBuildMetadata(env: BuildMetadataEnv = import.meta.env): BuildMetadata {
  const version = normalizeVersion(env.VITE_APP_VERSION);
  const commitSha = normalizeCommitSha(env.VITE_APP_COMMIT_SHA);
  const shortCommitSha =
    commitSha === DEFAULT_COMMIT_SHA ? DEFAULT_COMMIT_SHA : commitSha.slice(0, 7);

  return {
    version,
    commitSha,
    shortCommitSha,
    footerLabel: `${version} (${shortCommitSha})`
  };
}
