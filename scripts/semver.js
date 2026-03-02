import { pathToFileURL } from 'node:url';

/**
 * Release bump policy:
 * release/* => major
 * feature/* => minor
 * everything else => patch
 */
export function bumpTypeFromBranch(branchName) {
  if (branchName.startsWith('release/')) {
    return 'major';
  }

  if (branchName.startsWith('feature/')) {
    return 'minor';
  }

  return 'patch';
}

export function parseTagVersion(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  if (!match) {
    throw new Error(`Invalid version tag: ${tag}`);
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10)
  };
}

export function bumpTag(tag, bumpType) {
  const { major, minor, patch } = parseTagVersion(tag);

  if (bumpType === 'major') {
    return `v${major + 1}.0.0`;
  }

  if (bumpType === 'minor') {
    return `v${major}.${minor + 1}.0`;
  }

  return `v${major}.${minor}.${patch + 1}`;
}

export function nextTagForBranch(currentTag, branchName) {
  const bumpType = bumpTypeFromBranch(branchName);
  return bumpTag(currentTag, bumpType);
}

function parseCliArgs(argv) {
  const result = {
    branch: '',
    currentTag: ''
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--branch') {
      result.branch = argv[index + 1] ?? '';
      index += 1;
    } else if (arg === '--current-tag') {
      result.currentTag = argv[index + 1] ?? '';
      index += 1;
    }
  }

  return result;
}

const isDirectExecution = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectExecution) {
  const { branch, currentTag } = parseCliArgs(process.argv.slice(2));

  if (!branch || !currentTag) {
    console.error('Usage: node scripts/semver.js --branch <branch> --current-tag <vX.Y.Z>');
    process.exit(1);
  }

  const nextTag = nextTagForBranch(currentTag, branch);
  process.stdout.write(nextTag);
}
