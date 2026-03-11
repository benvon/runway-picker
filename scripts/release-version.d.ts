export type ReleaseBumpType = 'major' | 'minor' | 'patch';

export function parseTagVersion(tag: string): {
  major: number;
  minor: number;
  patch: number;
};

export function bumpTag(tag: string, bumpType: ReleaseBumpType): string;
export function classifyCommitMessage(commitMessage: string): ReleaseBumpType | null;
export function selectReleaseBump(commitMessages: string[]): ReleaseBumpType | null;
export function computeReleasePlan(
  currentTag: string,
  commitMessages: string[]
): {
  shouldRelease: boolean;
  bumpType: ReleaseBumpType | null;
  currentTag: string;
  nextTag: string | null;
};
export function buildCommitRange(fromTag: string | null, toRef: string): string;
export function getCommitMessages(range: string): string[];
