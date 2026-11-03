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
 * Read the exclusions from `<rootDir>/skill-exclusions.json`. A missing or
 * malformed file means no exclusions: the app must still start, and the
 * packaging build is where a bad config is rejected.
 */
export const readExcludedSkillIdsFromRoot = (rootDir: string): string[] => {
  const configPath = path.join(rootDir, CONFIG_FILE_NAME);
  if (!fs.existsSync(configPath)) return [];
  try {
    return parseExcludedSkillIds(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch (error) {
    console.warn(`[skills] Failed to parse ${configPath}:`, error);
    return [];
  }
};

/**
 * Directory holding the config for this run. A packaged app reads the copy
 * electron-builder places in Resources (see `extraResources` in
 * electron-builder.json), so an installed app can hide and clean up skills that
 * an earlier version synced into user data; development reads the repo copy.
 */
const resolveConfigRoot = (): string | null => {
  if (app.isPackaged) {
    return process.resourcesPath || null;
  }
  return app.getAppPath();
};

/** Excluded skill ids for this run; empty when no config is available. */
export const getExcludedSkillIds = (): ReadonlySet<string> => {
  if (cachedExcludedSkillIds) return cachedExcludedSkillIds;

  cachedExcludedSkillIds = new Set();
  try {
    const configRoot = resolveConfigRoot();
    const ids = configRoot ? readExcludedSkillIdsFromRoot(configRoot) : [];
    cachedExcludedSkillIds = new Set(ids);
    if (ids.length > 0) {
      console.log(`[skills] Excluded skills hidden: ${ids.join(', ')}`);
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

/**
 * Delete user-data copies of excluded skills.
 *
 * OpenClaw discovers skills by scanning `skills.load.extraDirs`, which is the
 * user-data skills directory, so a copy left there stays callable even when
 * LobsterAI hides the skill. Fresh installs never seed these copies, but
 * development profiles and upgraded installs can hold ones from an earlier sync.
 *
 * A directory that could not be removed is reported in `failed` instead of
 * throwing: a locked directory must not break startup.
 */
export const removeExcludedSkillCopies = (skillsRoot: string): { removed: string[]; failed: string[] } => {
  const removed: string[] = [];
  const failed: string[] = [];
  for (const id of getExcludedSkillIds()) {
    const target = path.join(skillsRoot, id);
    if (!fs.existsSync(target)) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true });
      console.log(`[skills] Removed user-data copy of excluded skill "${id}"`);
      removed.push(id);
    } catch (error) {
      console.warn(`[skills] Failed to remove user-data copy of excluded skill "${id}":`, error);
      failed.push(id);
    }
  }
  return { removed, failed };
};

/** Test-only: drop the memoized exclusions so a different app path can be read. */
export const resetSkillExclusionsCacheForTests = (): void => {
  cachedExcludedSkillIds = null;
};
