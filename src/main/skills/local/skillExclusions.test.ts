import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  EXCLUDED_SKILL_ENTRY_OVERRIDES,
  EXCLUDED_SKILL_IDS,
  EXCLUDED_SKILLS,
} from './skillExclusions';

const BUNDLED_SKILLS_ROOT = path.resolve(__dirname, '../../../../SKILLs');

const readBundledSkillMd = (id: string): string | null => {
  const skillMdPath = path.join(BUNDLED_SKILLS_ROOT, id, 'SKILL.md');
  return fs.existsSync(skillMdPath) ? fs.readFileSync(skillMdPath, 'utf8') : null;
};

/** Read the frontmatter `name`; undefined when the file has no frontmatter name. */
const readFrontmatterName = (skillMd: string): string | undefined => {
  const frontmatter = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return undefined;
  const name = frontmatter[1].match(/^name:[ \t]*(.+)$/m);
  return name ? name[1].trim().replace(/^["']|["']$/g, '') : undefined;
};

describe('EXCLUDED_SKILLS', () => {
  test('has no duplicate ids', () => {
    const ids = EXCLUDED_SKILLS.map(skill => skill.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('only lists skills that are still bundled', () => {
    const missing = EXCLUDED_SKILLS.filter(skill => readBundledSkillMd(skill.id) === null).map(
      skill => skill.id,
    );
    expect(missing).toEqual([]);
  });

  test('records the frontmatter name OpenClaw keys its entries by', () => {
    const mismatched = EXCLUDED_SKILLS.flatMap(skill => {
      const skillMd = readBundledSkillMd(skill.id);
      if (skillMd === null) return [];
      const frontmatterName = readFrontmatterName(skillMd);
      return frontmatterName === skill.name
        ? []
        : [`${skill.id}: expected "${skill.name}", SKILL.md has "${frontmatterName}"`];
    });
    expect(mismatched).toEqual([]);
  });
});

describe('derived exports', () => {
  test('EXCLUDED_SKILL_IDS covers every listed id', () => {
    expect([...EXCLUDED_SKILL_IDS].sort()).toEqual(EXCLUDED_SKILLS.map(skill => skill.id).sort());
  });

  test('EXCLUDED_SKILL_ENTRY_OVERRIDES disables every listed frontmatter name', () => {
    expect(EXCLUDED_SKILL_ENTRY_OVERRIDES).toEqual(
      Object.fromEntries(EXCLUDED_SKILLS.map(skill => [skill.name, { enabled: false }])),
    );
  });
});
