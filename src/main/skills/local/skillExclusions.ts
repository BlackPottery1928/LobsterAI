/**
 * Development-only skill exclusions.
 *
 * Packaged builds do not contain the skills listed in the repo's
 * `skill-exclusions.json`: packaging drops their directories (see
 * `scripts/skill-exclusions.cjs`). The development app still runs against the
 * repository's `SKILLs/` tree, so it reads the same config and hides those
 * skills — what `electron:dev` shows then matches what a package ships.
 *
 * The config is a build input and is not bundled, so a packaged app has no
 * runtime exclusions here. Read failures are tolerated on purpose: a malformed
 * config aborts the packaging build loudly, and must never break app startup.
 */

import { app } from 'electron';
import fs from 'fs';
import path from 'path';

const CONFIG_FILE_NAME = 'skill-exclusions.json';

let cachedExcludedSkillIds: ReadonlySet<string> | null = null;

/** Skill ids declared by a parsed `skill-exclusions.json`; unknown shapes yield []. */
export const parseExcludedSkillIds = (parsed: unknown): string[] => {
  if (parsed === null || typeof parsed !== 'object') return [];
  const exclusions = (parsed as { exclusions?: unknown }).exclusions;
  if (!Array.isArray(exclusions)) return [];
  return exclusions
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map(id => id.trim());
};

/**
 * Read the exclusions from `<repoRoot>/skill-exclusions.json`. A missing or
 * malformed file means no exclusions: development must still start, and the
 * packaging build is where a bad config is rejected.
 */
export const readExcludedSkillIdsFromRepo = (repoRoot: string): string[] => {
  const configPath = path.join(repoRoot, CONFIG_FILE_NAME);
  if (!fs.existsSync(configPath)) return [];
  try {
    return parseExcludedSkillIds(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch (error) {
    console.warn(`[skills] Failed to parse ${configPath}:`, error);
    return [];
  }
};

/** Excluded skill ids for this run; always empty in a packaged app. */
export const getExcludedSkillIds = (): ReadonlySet<string> => {
  if (cachedExcludedSkillIds) return cachedExcludedSkillIds;

  cachedExcludedSkillIds = new Set();
  try {
    if (!app.isPackaged) {
      const ids = readExcludedSkillIdsFromRepo(app.getAppPath());
      cachedExcludedSkillIds = new Set(ids);
      if (ids.length > 0) {
        console.log(`[skills] Excluded skills hidden in development: ${ids.join(', ')}`);
      }
    }
  } catch (error) {
    console.warn('[skills] Failed to read skill exclusions:', error);
  }
  return cachedExcludedSkillIds;
};

/**
 * True when the skill id is excluded from packaged builds. The skill directory
 * stays on disk in development; callers skip it so the development app behaves
 * like a package.
 */
export const isSkillExcluded = (skillId: string): boolean => getExcludedSkillIds().has(skillId);

/** Test-only: drop the memoized exclusions so a different app path can be read. */
export const resetSkillExclusionsCacheForTests = (): void => {
  cachedExcludedSkillIds = null;
};
