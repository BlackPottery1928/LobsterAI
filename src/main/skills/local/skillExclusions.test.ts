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
  readExcludedSkillIdsFromRepo,
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

afterEach(() => {
  resetSkillExclusionsCacheForTests();
  appState.isPackaged = false;
  appState.appPath = '';
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

test('readExcludedSkillIdsFromRepo tolerates a missing or malformed config', () => {
  expect(readExcludedSkillIdsFromRepo(tempDir())).toEqual([]);
  const malformed = writeConfig(tempDir(), '{ not json');
  expect(readExcludedSkillIdsFromRepo(malformed)).toEqual([]);
  const valid = writeConfig(tempDir(), JSON.stringify({ version: 1, exclusions: ['web-search'] }));
  expect(readExcludedSkillIdsFromRepo(valid)).toEqual(['web-search']);
});

test('hides excluded skills in development and reads nothing once packaged', () => {
  appState.appPath = writeConfig(tempDir(), JSON.stringify({ version: 1, exclusions: ['web-search', 'weather'] }));

  expect(isSkillExcluded('web-search')).toBe(true);
  expect(isSkillExcluded('docx')).toBe(false);
  expect([...getExcludedSkillIds()].sort()).toEqual(['weather', 'web-search']);

  appState.isPackaged = true;
  appState.appPath = tempDir();
  resetSkillExclusionsCacheForTests();
  expect(getExcludedSkillIds().size).toBe(0);
  expect(isSkillExcluded('web-search')).toBe(false);
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
