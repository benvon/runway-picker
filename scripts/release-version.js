import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MAJOR = 'major';
const MINOR = 'minor';
const PATCH = 'patch';
const BUMP_ORDER = [PATCH, MINOR, MAJOR];
const CONVENTIONAL_HEADER = /^(?<type>[a-z]+)(\([^)]+\))?(?<breaking>!)?:\s.+$/i;
const BREAKING_CHANGE_FOOTER = /^BREAKING[ -]CHANGE:\s.+/im;

/**
 * @typedef {'major' | 'minor' | 'patch'} ReleaseBumpType
 */

/**
 * @param {string} tag
 */
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

/**
 * @param {string} tag
 * @param {ReleaseBumpType} bumpType
 */
export function bumpTag(tag, bumpType) {
  const { major, minor, patch } = parseTagVersion(tag);

  if (bumpType === MAJOR) {
    return `v${major + 1}.0.0`;
  }

  if (bumpType === MINOR) {
    return `v${major}.${minor + 1}.0`;
  }

  return `v${major}.${minor}.${patch + 1}`;
}

/**
 * @param {string} commitMessage
 * @returns {ReleaseBumpType | null}
 */
export function classifyCommitMessage(commitMessage) {
  const normalized = commitMessage.trim();
  if (!normalized) {
    return null;
  }

  if (BREAKING_CHANGE_FOOTER.test(normalized)) {
    return MAJOR;
  }

  const [headerLine] = normalized.split(/\r?\n/, 1);
  const match = CONVENTIONAL_HEADER.exec(headerLine);
  if (!match?.groups) {
    return null;
  }

  if (match.groups.breaking === '!') {
    return MAJOR;
  }

  const type = match.groups.type.toLowerCase();
  if (type === 'feat') {
    return MINOR;
  }

  if (type === 'fix' || type === 'perf') {
    return PATCH;
  }

  return null;
}

/**
 * @param {string[]} commitMessages
 * @returns {ReleaseBumpType | null}
 */
export function selectReleaseBump(commitMessages) {
  let highest = -1;

  for (const message of commitMessages) {
    const bump = classifyCommitMessage(message);
    if (!bump) {
      continue;
    }

    const bumpIndex = BUMP_ORDER.indexOf(bump);
    if (bumpIndex > highest) {
      highest = bumpIndex;
    }

    if (bump === MAJOR) {
      break;
    }
  }

  if (highest < 0) {
    return null;
  }

  return BUMP_ORDER[highest];
}

/**
 * @param {string} currentTag
 * @param {string[]} commitMessages
 */
export function computeReleasePlan(currentTag, commitMessages) {
  const bump = selectReleaseBump(commitMessages);
  if (!bump) {
    return {
      shouldRelease: false,
      bumpType: null,
      currentTag,
      nextTag: null
    };
  }

  return {
    shouldRelease: true,
    bumpType: bump,
    currentTag,
    nextTag: bumpTag(currentTag, bump)
  };
}

/**
 * @param {string | null} fromTag
 * @param {string} toRef
 */
export function buildCommitRange(fromTag, toRef) {
  if (fromTag && fromTag.trim()) {
    return `${fromTag.trim()}..${toRef}`;
  }

  return toRef;
}

/**
 * @param {string} range
 */
export function getCommitMessages(range) {
  const output = execSync(`git log --format=%B%x1e ${range}`, {
    encoding: 'utf8'
  });

  return output
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * @param {string[]} argv
 */
function parseCliArgs(argv) {
  const result = {
    currentTag: '',
    toRef: 'HEAD'
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--current-tag') {
      result.currentTag = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (arg === '--to-ref') {
      result.toRef = argv[index + 1] ?? 'HEAD';
      index += 1;
    }
  }

  return result;
}

const isDirectExecution = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectExecution) {
  const { currentTag, toRef } = parseCliArgs(process.argv.slice(2));
  const baselineTag = currentTag && currentTag.trim() ? currentTag.trim() : 'v0.0.0';
  parseTagVersion(baselineTag);

  const range = buildCommitRange(currentTag || null, toRef);
  const commitMessages = getCommitMessages(range);
  const plan = computeReleasePlan(baselineTag, commitMessages);

  process.stdout.write(
    JSON.stringify(
      {
        ...plan,
        analyzedCommitCount: commitMessages.length,
        range
      },
      null,
      2
    )
  );
}
