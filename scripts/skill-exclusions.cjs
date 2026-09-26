'use strict';

/**
 * skill-exclusions.cjs
 *
 * Build-time skill exclusions. `skill-exclusions.json` (repo root) lists skill
 * directories that must not reach packaged builds. The directories stay in the
 * repo for development; the packaging entry points filter them out before
 * anything is copied:
 *
 *   - Windows: the SKILLs source of the resources tar packed by
 *     scripts/pack-openclaw-tar.cjs.
 *   - macOS/Linux: the SKILLs `extraResources` filter arrays, patched by
 *     scripts/electron-builder-config.cjs.
 *
 * A configuration mistake must never silently ship an excluded skill, so every
 * validation failure throws and aborts the build.
 */

const fs = require('fs');
const path = require('path');

const LOG_TAG = '[skill-exclusions]';
const CONFIG_FILE_NAME = 'skill-exclusions.json';
const SKILLS_DIR_NAME = 'SKILLs';
const SKILLS_CONFIG_FILE = 'skills.config.json';
const CONFIG_VERSION = 1;
/** Directory names only; no separators, no traversal, no leading dots. */
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9._+-]*$/i;

const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..');

/** Cache keyed by repo root, so one build reads and validates the config once. */
const cache = new Map();

function fail(message) {
  throw new Error(`${LOG_TAG} ${message}`);
}

function readJsonFile(filePath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    fail(`cannot read ${label} at ${filePath}: ${error.message}`);
  }
  if (!raw.trim()) {
    fail(`${label} at ${filePath} is empty`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${label} at ${filePath} is not valid JSON: ${error.message}`);
  }
}

function parseExclusionIds(config, configPath) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    fail(`${CONFIG_FILE_NAME} at ${configPath} must be a JSON object`);
  }
  if (config.version !== CONFIG_VERSION) {
    fail(
      `${CONFIG_FILE_NAME} at ${configPath} must declare "version": ${CONFIG_VERSION}, `
      + `found ${JSON.stringify(config.version)}`,
    );
  }
  if (!Array.isArray(config.exclusions)) {
    fail(`${CONFIG_FILE_NAME} at ${configPath} must declare an "exclusions" array`);
  }

  const ids = [];
  const seen = new Set();
  config.exclusions.forEach((entry, index) => {
    const where = `exclusions[${index}]`;
    if (typeof entry !== 'string' || !entry.trim()) {
      fail(`${where} in ${configPath} must be a non-empty skill id`);
    }
    const id = entry.trim();
    if (!SKILL_ID_PATTERN.test(id) || id.includes('..')) {
      fail(`${where} in ${configPath} has an invalid skill id ${JSON.stringify(entry)}`);
    }
    if (seen.has(id)) {
      fail(`${configPath} lists skill id ${JSON.stringify(id)} more than once`);
    }
    seen.add(id);
    ids.push(id);
  });
  return ids;
}

function validateAgainstRepo(ids, repoRoot, configPath) {
  const skillsDir = path.join(repoRoot, SKILLS_DIR_NAME);
  let bundledIds;
  try {
    bundledIds = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name);
  } catch (error) {
    fail(`cannot list ${skillsDir}: ${error.message}`);
  }
  if (!bundledIds.length) {
    fail(`no bundled skills found under ${skillsDir}; refusing to compute exclusions`);
  }

  const skillsConfigPath = path.join(skillsDir, SKILLS_CONFIG_FILE);
  const defaults = readJsonFile(skillsConfigPath, SKILLS_CONFIG_FILE)?.defaults;
  if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults)) {
    fail(`${SKILLS_CONFIG_FILE} at ${skillsConfigPath} must declare a "defaults" object`);
  }
  const bundledSet = new Set(bundledIds);
  const defaultedIds = new Set(Object.keys(defaults));

  for (const id of ids) {
    if (!bundledSet.has(id)) {
      fail(
        `skill id ${JSON.stringify(id)} from ${configPath} is not a directory under ${skillsDir}. `
        + 'Remove it from the config or restore the directory.',
      );
    }
    if (!defaultedIds.has(id)) {
      fail(
        `skill id ${JSON.stringify(id)} from ${configPath} is not listed in ${SKILLS_CONFIG_FILE} "defaults". `
        + 'Excluded skills must stay listed there: the installer, the skill sync allowlist and the built-in '
        + 'skill list all classify skills through that config.',
      );
    }
  }

  const remaining = bundledIds.filter(id => !ids.includes(id));
  if (!remaining.length) {
    fail(`${configPath} excludes every bundled skill; the installer requires a non-empty SKILLs resource`);
  }

  return { bundledCount: bundledIds.length };
}

/**
 * Read, validate and cache `skill-exclusions.json`.
 *
 * @param {{ repoRoot?: string }} [options]
 * @returns {{ ids: ReadonlyArray<string>, idSet: ReadonlySet<string>,
 *   bundledCount: number, configPath: string }}
 */
function loadSkillExclusions(options = {}) {
  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : DEFAULT_REPO_ROOT;
  const cached = cache.get(repoRoot);
  if (cached) return cached;

  const configPath = path.join(repoRoot, CONFIG_FILE_NAME);
  if (!fs.existsSync(configPath)) {
    fail(`missing ${configPath}; every packaged build requires a skill exclusion config`);
  }
  const ids = parseExclusionIds(readJsonFile(configPath, CONFIG_FILE_NAME), configPath);
  const { bundledCount } = validateAgainstRepo(ids, repoRoot, configPath);

  const result = Object.freeze({
    ids: Object.freeze(ids),
    idSet: new Set(ids),
    bundledCount,
    configPath,
  });
  cache.set(repoRoot, result);
  return result;
}

/**
 * Predicate for the per-source `filter` of `packMultipleSources` /
 * `packSingleSource` in scripts/pack-openclaw-tar.cjs. Paths are relative to the
 * SKILLs source directory and carry no prefix, so the first path segment is the
 * skill id; returning false skips the whole subtree.
 *
 * @param {{ repoRoot?: string }} [options]
 * @returns {(filePath: string, stat?: unknown) => boolean} true keeps the entry
 */
function createSkillExclusionFilter(options) {
  const { idSet } = loadSkillExclusions(options);
  return (filePath) => {
    const normalized = String(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
    const first = normalized.split('/')[0];
    if (!first || first === '.') return true;
    return !idSet.has(first);
  };
}

/**
 * electron-builder filter globs, one per excluded skill. The brace form drops
 * the directory entry itself and everything below it, which plain `!id/**`
 * globbing does not do: it would leave an empty directory behind.
 *
 * @param {{ repoRoot?: string }} [options]
 */
function skillExclusionFilterPatterns(options) {
  return loadSkillExclusions(options).ids.map(id => `!${id}{,/**/*}`);
}

/**
 * Append the exclusion globs to every SKILLs `extraResources` entry of the given
 * platforms, in place.
 *
 * electron-builder's `minimatchAll` only re-tests a pattern while
 * `match === pattern.negate`, so a negation placed before the positive `**\/*`
 * pattern is skipped and nothing would be excluded. The globs are therefore
 * appended at the end of the array, never prepended.
 *
 * @param {object} config electron-builder configuration object
 * @param {string[]} platformNames platform keys to patch
 * @param {{ repoRoot?: string }} [options]
 * @returns {number} number of extraResources entries patched
 */
function applySkillExclusionsToExtraResources(config, platformNames = ['mac', 'linux'], options) {
  const patterns = skillExclusionFilterPatterns(options);
  let patched = 0;

  for (const platformName of platformNames) {
    const resources = config?.[platformName]?.extraResources;
    if (!Array.isArray(resources)) continue;
    const skillEntries = resources.filter(
      resource => resource?.from === SKILLS_DIR_NAME && resource?.to === SKILLS_DIR_NAME,
    );
    if (!skillEntries.length) {
      console.warn(`${LOG_TAG} ${platformName} has no ${SKILLS_DIR_NAME} extraResources entry; exclusions not applied`);
      continue;
    }
    for (const resource of skillEntries) {
      if (!Array.isArray(resource.filter)) {
        fail(`${platformName}: the ${SKILLS_DIR_NAME} extraResources entry has no filter array`);
      }
      if (!resource.filter.some(pattern => typeof pattern === 'string' && !pattern.startsWith('!'))) {
        fail(
          `${platformName}: the ${SKILLS_DIR_NAME} extraResources filter has no positive pattern, `
          + 'so appended exclusions would never be evaluated',
        );
      }
      for (const pattern of patterns) {
        if (!resource.filter.includes(pattern)) resource.filter.push(pattern);
      }
      patched += 1;
    }
  }

  return patched;
}

/** Test-only: drop the memoized config so fixtures can be re-read. */
function resetSkillExclusionCacheForTests() {
  cache.clear();
}

module.exports = {
  LOG_TAG,
  applySkillExclusionsToExtraResources,
  createSkillExclusionFilter,
  loadSkillExclusions,
  resetSkillExclusionCacheForTests,
  skillExclusionFilterPatterns,
};
