import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const appState = vi.hoisted(() => ({ isPackaged: false, appPath: '' }));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return appState.isPackaged;
    },
    getAppPath: () => appState.appPath,
  },
}));

import {
  getExcludedSkillIds,
  isSkillExcluded,
  parseExcludedSkillIds,
  readExcludedSkillIdsFromRoot,
  removeExcludedSkillCopies,
  resetSkillExclusionsCacheForTests,
} from './skillExclusions';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-skill-exclusions-dev-'));
  tempDirs.push(dir);
  return dir;
}

function writeConfig(root: string, content: string): string {
  fs.writeFileSync(path.join(root, 'skill-exclusions.json'), content);
  return root;
}

function setResourcesPath(value: string | undefined): void {
  (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = value;
}

afterEach(() => {
  resetSkillExclusionsCacheForTests();
  appState.isPackaged = false;
  appState.appPath = '';
  setResourcesPath(undefined);
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('parseExcludedSkillIds keeps trimmed string ids and ignores anything else', () => {
  expect(parseExcludedSkillIds({ version: 1, exclusions: [' web-search ', 'weather'] })).toEqual([
    'web-search',
    'weather',
  ]);
  expect(parseExcludedSkillIds({ version: 1, exclusions: ['web-search', 42, '', null, {}] })).toEqual(['web-search']);
  expect(parseExcludedSkillIds({ version: 1, exclusions: {} })).toEqual([]);
  expect(parseExcludedSkillIds({ version: 1 })).toEqual([]);
  expect(parseExcludedSkillIds(null)).toEqual([]);
  expect(parseExcludedSkillIds('web-search')).toEqual([]);
});

test('readExcludedSkillIdsFromRoot tolerates a missing or malformed config', () => {
  expect(readExcludedSkillIdsFromRoot(tempDir())).toEqual([]);
  const malformed = writeConfig(tempDir(), '{ not json');
  expect(readExcludedSkillIdsFromRoot(malformed)).toEqual([]);
  const valid = writeConfig(tempDir(), JSON.stringify({ version: 1, exclusions: ['web-search'] }));
  expect(readExcludedSkillIdsFromRoot(valid)).toEqual(['web-search']);
});

test('reads the repo config in development and the Resources copy when packaged', () => {
  appState.appPath = writeConfig(tempDir(), JSON.stringify({ version: 1, exclusions: ['web-search', 'weather'] }));
  expect([...getExcludedSkillIds()].sort()).toEqual(['weather', 'web-search']);
  expect(isSkillExcluded('docx')).toBe(false);

  appState.isPackaged = true;
  setResourcesPath(writeConfig(tempDir(), JSON.stringify({ version: 1, exclusions: ['seedance'] })));
  resetSkillExclusionsCacheForTests();
  expect([...getExcludedSkillIds()]).toEqual(['seedance']);
  expect(isSkillExcluded('web-search')).toBe(false);

  // A package built before the config was shipped has no exclusions to apply.
  setResourcesPath(tempDir());
  resetSkillExclusionsCacheForTests();
  expect(getExcludedSkillIds().size).toBe(0);
});

test('removeExcludedSkillCopies deletes only the excluded user-data copies', () => {
  appState.appPath = writeConfig(tempDir(), JSON.stringify({ version: 1, exclusions: ['web-search', 'weather'] }));
  const skillsRoot = tempDir();
  for (const id of ['web-search', 'weather', 'docx']) {
    fs.mkdirSync(path.join(skillsRoot, id), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, id, 'SKILL.md'), 'fixture');
  }
  fs.writeFileSync(path.join(skillsRoot, 'skills.config.json'), '{}');

  expect(removeExcludedSkillCopies(skillsRoot)).toEqual({ removed: ['web-search', 'weather'], failed: [] });
  expect(fs.existsSync(path.join(skillsRoot, 'web-search'))).toBe(false);
  expect(fs.existsSync(path.join(skillsRoot, 'weather'))).toBe(false);
  expect(fs.existsSync(path.join(skillsRoot, 'docx', 'SKILL.md'))).toBe(true);
  expect(fs.existsSync(path.join(skillsRoot, 'skills.config.json'))).toBe(true);
  // Idempotent: nothing left to remove.
  expect(removeExcludedSkillCopies(skillsRoot)).toEqual({ removed: [], failed: [] });
});

test('removeExcludedSkillCopies has nothing to do without exclusions', () => {
  appState.isPackaged = true;
  setResourcesPath(tempDir());
  const skillsRoot = tempDir();
  fs.mkdirSync(path.join(skillsRoot, 'web-search'), { recursive: true });

  expect(removeExcludedSkillCopies(skillsRoot)).toEqual({ removed: [], failed: [] });
  expect(fs.existsSync(path.join(skillsRoot, 'web-search'))).toBe(true);
});

test('agrees with the repo config that packaged builds exclude', () => {
  appState.appPath = REPO_ROOT;
  const ids = [...getExcludedSkillIds()];
  expect(ids.length).toBeGreaterThan(0);
  expect(ids).toContain('web-search');
  expect(ids).not.toContain('docx');
  for (const id of ids) {
    expect(fs.existsSync(path.join(REPO_ROOT, 'SKILLs', id))).toBe(true);
  }
});
