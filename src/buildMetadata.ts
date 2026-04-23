export interface BuildIdentity {
  version: string;
  commitSha: string;
}

export interface BuildMetadata extends BuildIdentity {
  shortCommitSha: string;
  footerLabel: string;
}

export interface BuildMetadataInput {
  version?: string;
  commitSha?: string;
}

interface BuildMetadataEnv {
  VITE_APP_VERSION?: string;
  VITE_APP_COMMIT_SHA?: string;
}

const DEFAULT_VERSION = 'v0.0.0-dev';
const DEFAULT_COMMIT_SHA = 'local';
const STABLE_RELEASE_VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;

function normalizeVersion(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) {
    return DEFAULT_VERSION;
  }

  if (/^v/i.test(raw)) {
    const withoutPrefix = raw.slice(1).trim();
    return withoutPrefix ? `v${withoutPrefix}` : DEFAULT_VERSION;
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

export function createBuildMetadata(input: BuildMetadataInput): BuildMetadata {
  const version = normalizeVersion(input.version);
  const commitSha = normalizeCommitSha(input.commitSha);
  const shortCommitSha =
    commitSha === DEFAULT_COMMIT_SHA ? DEFAULT_COMMIT_SHA : commitSha.slice(0, 7);

  return {
    version,
    commitSha,
    shortCommitSha,
    footerLabel: `${version} (${shortCommitSha})`
  };
}

export function readBuildMetadata(env: BuildMetadataEnv = import.meta.env): BuildMetadata {
  return createBuildMetadata({
    version: env.VITE_APP_VERSION,
    commitSha: env.VITE_APP_COMMIT_SHA
  });
}

export function isStableReleaseVersion(version: string): boolean {
  return STABLE_RELEASE_VERSION_PATTERN.test(version);
}

export function isStableReleaseBuild(build: Pick<BuildIdentity, 'version'>): boolean {
  return isStableReleaseVersion(build.version);
}
