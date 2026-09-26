import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const tar = require('tar');
const { FileMatcher } = require('app-builder-lib/out/fileMatcher.js');
const { packMultipleSources } = require('../scripts/pack-openclaw-tar.cjs');
const {
  applySkillExclusionsToExtraResources,
  createSkillExclusionFilter,
  loadSkillExclusions,
  resetSkillExclusionCacheForTests,
  skillExclusionFilterPatterns,
} = require('../scripts/skill-exclusions.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SKILLS_ROOT = path.join(REPO_ROOT, 'SKILLs');
const config = require('../scripts/electron-builder-config.cjs');
const packageJson = require('../package.json');

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-skill-exclusions-'));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relative: string, content = 'fixture'): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeSkillsConfig(root: string, defaultIds: string[]): void {
  write(
    root,
    'SKILLs/skills.config.json',
    JSON.stringify({ version: 1, defaults: Object.fromEntries(defaultIds.map(id => [id, { enabled: true }])) }),
  );
}

/** A valid fixture whose repo layout mirrors the real one for two skills. */
function fixture(): string {
  const root = tempDir();
  write(root, 'SKILLs/docx/SKILL.md');
  write(root, 'SKILLs/web-search/examples/basic.md');
  writeSkillsConfig(root, ['docx', 'web-search']);
  write(root, 'skill-exclusions.json', JSON.stringify({ version: 1, exclusions: ['web-search'] }));
  return root;
}

function writeExclusionsOver(root: string, config: unknown): void {
  resetSkillExclusionCacheForTests();
  write(root, 'skill-exclusions.json', typeof config === 'string' ? config : JSON.stringify(config));
}

function loadFixture(root: string): string[] {
  resetSkillExclusionCacheForTests();
  return loadSkillExclusions({ repoRoot: root }).ids;
}

afterEach(() => {
  resetSkillExclusionCacheForTests();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('skill-exclusions.json', () => {
  test('every excluded id is a bundled skill that stays listed in skills.config.json', () => {
    const { ids, bundledCount } = loadSkillExclusions({ repoRoot: REPO_ROOT });
    const defaults = JSON.parse(fs.readFileSync(path.join(SKILLS_ROOT, 'skills.config.json'), 'utf8')).defaults;
    const skillDirs = fs.readdirSync(SKILLS_ROOT, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name);

    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    // Kept sorted by skill directory name so the config stays easy to scan.
    expect(ids).toEqual([...ids].sort());
    expect(bundledCount).toBe(skillDirs.length);
    // The installer and the skill sync allowlist both require a non-empty SKILLs resource.
    expect(ids.length).toBeLessThan(skillDirs.length);
    for (const id of ids) {
      expect(skillDirs).toContain(id);
      expect(Object.keys(defaults)).toContain(id);
    }
  });

  test('accepts a config that excludes nothing', () => {
    const root = fixture();
    writeExclusionsOver(root, { version: 1, exclusions: [] });
    expect(loadFixture(root)).toEqual([]);
  });

  test.each([
    ['a missing config', (root: string) => fs.rmSync(path.join(root, 'skill-exclusions.json'))],
    ['unparseable JSON', (root: string) => writeExclusionsOver(root, '{ not json')],
    ['an empty file', (root: string) => writeExclusionsOver(root, '')],
    ['a missing version', (root: string) => writeExclusionsOver(root, { exclusions: [] })],
    ['an unsupported version', (root: string) => writeExclusionsOver(root, { version: 2, exclusions: [] })],
    ['a missing exclusions array', (root: string) => writeExclusionsOver(root, { version: 1 })],
    ['a non-array exclusions value', (root: string) => writeExclusionsOver(root, { version: 1, exclusions: {} })],
    ['a non-string entry', (root: string) => writeExclusionsOver(root, { version: 1, exclusions: [{ id: 'web-search' }] })],
    ['a blank id', (root: string) => writeExclusionsOver(root, { version: 1, exclusions: ['  '] })],
    ['a path-traversing id', (root: string) => writeExclusionsOver(root, { version: 1, exclusions: ['../docx'] })],
    ['a duplicate id', (root: string) => writeExclusionsOver(root, { version: 1, exclusions: ['web-search', 'web-search'] })],
    ['an id with no skill directory', (root: string) => writeExclusionsOver(root, { version: 1, exclusions: ['ghost-skill'] })],
    [
      'an id missing from skills.config.json defaults',
      (root: string) => {
        write(root, 'SKILLs/legacy-tool/SKILL.md');
        writeExclusionsOver(root, { version: 1, exclusions: ['legacy-tool'] });
      },
    ],
    [
      'an exclusion set covering every bundled skill',
      (root: string) => {
        write(root, 'SKILLs/other/SKILL.md');
        writeSkillsConfig(root, ['docx', 'web-search', 'other']);
        writeExclusionsOver(root, { version: 1, exclusions: ['docx', 'web-search', 'other'] });
      },
    ],
    ['a missing skills.config.json', (root: string) => fs.rmSync(path.join(root, 'SKILLs', 'skills.config.json'))],
  ])('rejects %s', (_label, mutate) => {
    const root = fixture();
    mutate(root);
    expect(() => loadFixture(root)).toThrow(/\[skill-exclusions\]/);
  });
});

describe('packaging filters', () => {
  test('keeps non-excluded entries and drops every excluded path', () => {
    const keep = createSkillExclusionFilter({ repoRoot: REPO_ROOT });
    for (const keepPath of ['docx', 'docx/SKILL.md', 'docx-web-search/SKILL.md', 'skills.config.json', '', '.']) {
      expect(keep(keepPath)).toBe(true);
    }
    for (const dropPath of ['web-search', 'web-search/SKILL.md', 'web-search\\SKILL.md', './web-search', 'skin-creator/icon.png']) {
      expect(keep(dropPath)).toBe(false);
    }
  });

  test('skips excluded skills when packing the Windows resources tar', () => {
    const root = fixture();
    write(root, 'SKILLs/docx/scripts/run.js');
    const other = tempDir();
    write(other, 'python.exe');

    const archive = path.join(tempDir(), 'resources.tar');
    const counts = packMultipleSources([
      { dir: path.join(root, 'SKILLs'), prefix: 'SKILLs', filter: createSkillExclusionFilter({ repoRoot: root }) },
      { dir: other, prefix: 'python-win' },
    ], archive);

    const entries: string[] = [];
    tar.list({ file: archive, sync: true, onentry: (entry: { path: string }) => entries.push(entry.path) });

    expect(entries).toContain('SKILLs/docx/SKILL.md');
    expect(entries).toContain('SKILLs/docx/scripts/run.js');
    expect(entries).toContain('SKILLs/skills.config.json');
    expect(entries).toContain('python-win/python.exe');
    // The excluded directory entry itself is gone, not just its contents.
    expect(entries.filter(entry => entry.startsWith('SKILLs/web-search'))).toEqual([]);
    expect(counts.skipped).toBeGreaterThan(0);
  });

  test('appends the exclusion globs to the SKILLs extraResources filters', () => {
    const patterns = skillExclusionFilterPatterns({ repoRoot: REPO_ROOT });
    expect(patterns.length).toBe(loadSkillExclusions({ repoRoot: REPO_ROOT }).ids.length);

    for (const platform of ['mac', 'linux']) {
      const entries = config[platform].extraResources.filter(
        (resource: { from: string; to: string }) => resource.from === 'SKILLs' && resource.to === 'SKILLs',
      );
      expect(entries).toHaveLength(1);
      const filter: string[] = entries[0].filter;
      const firstNegation = filter.findIndex(pattern => pattern.startsWith('!'));
      const lastPositive = filter.map(pattern => !pattern.startsWith('!')).lastIndexOf(true);
      // electron-builder only re-tests a pattern while match === pattern.negate, so
      // a negation placed before the positive `**/*` pattern is never evaluated.
      expect(firstNegation).toBeGreaterThan(lastPositive);
      expect(filter).toContain('**/*');
      for (const pattern of patterns) expect(filter).toContain(pattern);
      // Excluding a skill must never drop the skills config itself.
      expect(filter.some(pattern => pattern.startsWith('!') && pattern.includes('skills.config.json'))).toBe(false);
    }

    const before = config.mac.extraResources
      .find((resource: { to: string }) => resource.to === 'SKILLs').filter.length;
    applySkillExclusionsToExtraResources(config, ['mac', 'linux'], { repoRoot: REPO_ROOT });
    expect(config.mac.extraResources.find((resource: { to: string }) => resource.to === 'SKILLs').filter)
      .toHaveLength(before);

    const matcher = new FileMatcher(
      SKILLS_ROOT,
      path.join(REPO_ROOT, 'release'),
      (value: string) => value,
      config.mac.extraResources.find((resource: { to: string }) => resource.to === 'SKILLs').filter,
    );
    const isKept = matcher.createFilter();
    const dirStat = { isDirectory: () => true };
    const fileStat = { isDirectory: () => false };
    for (const excluded of ['web-search', 'technology-news-search', 'skin-creator']) {
      expect(isKept(path.join(SKILLS_ROOT, excluded), dirStat)).toBe(false);
      expect(isKept(path.join(SKILLS_ROOT, excluded, 'SKILL.md'), fileStat)).toBe(false);
    }
    expect(isKept(path.join(SKILLS_ROOT, 'docx'), dirStat)).toBe(true);
    expect(isKept(path.join(SKILLS_ROOT, 'docx', 'SKILL.md'), fileStat)).toBe(true);
    expect(isKept(path.join(SKILLS_ROOT, 'skills.config.json'), fileStat)).toBe(true);
  });

  test('every electron-builder entry point loads the config that applies exclusions', () => {
    const scripts: Record<string, string> = packageJson.scripts;
    const buildScripts = Object.entries(scripts).filter(([name, command]) => (
      (name === 'pack' || name === 'dist' || name.startsWith('dist:')) && command.includes('electron-builder')
    ));
    expect(buildScripts.length).toBeGreaterThan(0);
    for (const [name, command] of buildScripts) {
      expect(command, `${name} must load scripts/electron-builder-config.cjs`).toContain('scripts/electron-builder-config.cjs');
    }
  });
});
