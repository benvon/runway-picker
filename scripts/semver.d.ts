export function bumpTypeFromBranch(branchName: string): 'major' | 'minor' | 'patch';
export function parseTagVersion(tag: string): { major: number; minor: number; patch: number };
export function bumpTag(tag: string, bumpType: 'major' | 'minor' | 'patch'): string;
export function nextTagForBranch(currentTag: string, branchName: string): string;
