import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const {
  loadSkillPythonDeps,
  normalizePackageName,
  resetSkillPythonDepsCacheForTests,
} = require('../scripts/skill-python-deps.cjs');
const { loadSkillExclusions } = require('../scripts/skill-exclusions.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Content audit for requirement 2: a shipped skill must not import a Python
 * package that the installer does not preinstall.
 *
 * The bundled runtime only carries what `SKILLs/python-deps.json` pins, so a new
 * `import foo` in a shipped skill silently breaks once the app is offline. This
 * test walks the real skill sources and fails on any import that is not
 * accounted for, forcing whoever adds it to decide:
 *   - pin it in a group (the normal answer), or
 *   - pin it in the `packages` table of SKILLs/python-deps.json, or
 *   - add it to INTENTIONALLY_NOT_BUNDLED below and document why in
 *     docs/skill-python-deps.md.
 */

/** Python standard library modules used by the bundled skills. */
const STDLIB = new Set([
  '__future__', 'argparse', 'base64', 'codecs', 'concurrent', 'copy', 'dataclasses', 'datetime',
  'fnmatch', 'functools', 'html', 'http', 'io', 'json', 'math', 'mimetypes', 'os', 'pathlib',
  'platform', 'random', 're', 'select', 'shutil', 'signal', 'subprocess', 'sys', 'tempfile',
  'time', 'traceback', 'typing', 'unittest', 'uuid', 'webbrowser', 'xml', 'zipfile',
]);

/** Import names that resolve to a skill's own files rather than a distribution. */
const LOCAL_MODULES = new Set([
  'check_bounding_boxes', 'extract_form_field_info', 'inventory', 'ooxml', 'scripts', 'skills',
  'validation',
]);

/** Top-level import name -> PyPI distribution name. */
const MODULE_TO_DISTRIBUTION: Record<string, string> = {
  anthropic: 'anthropic',
  defusedxml: 'defusedxml',
  docx: 'python-docx',
  lxml: 'lxml',
  openpyxl: 'openpyxl',
  pdf2image: 'pdf2image',
  PIL: 'Pillow',
  pptx: 'python-pptx',
  pypdf: 'pypdf',
  requests: 'requests',
  six: 'six',
  yaml: 'PyYAML',
};

/**
 * Imports a shipped skill makes that the installer deliberately does NOT
 * provide. Each entry needs a reason and must be documented in
 * docs/skill-python-deps.md. Keeping the list explicit means the gap is a
 * recorded decision rather than an oversight.
 */
const INTENTIONALLY_NOT_BUNDLED: Record<string, string> = {
  anthropic:
    'only skill-creator evaluation scripts need it, and it pulls native pydantic-core + jiter '
    + '(~22 MB unpacked). Those scripts require network access to install it. See docs/skill-python-deps.md.',
};

const IMPORT_PATTERN = /^\s*(?:import|from)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;

function collectPythonFiles(dir: string, found: string[] = []): string[] {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectPythonFiles(full, found);
    } else if (entry.isFile() && entry.name.endsWith('.py')) {
      found.push(full);
    }
  }
  return found;
}

function importedModules(filePath: string): string[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const modules = new Set<string>();
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    modules.add(match[1]);
  }
  return [...modules];
}

function shippedSkillIds(): string[] {
  const excluded = loadSkillExclusions({ repoRoot: REPO_ROOT }).idSet;
  const skillsDir = path.join(REPO_ROOT, 'SKILLs');
  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .filter(id => !excluded.has(id));
}

afterEach(() => {
  resetSkillPythonDepsCacheForTests();
});

describe('shipped skill Python dependency coverage', () => {
  test('every third-party import in a shipped skill is preinstalled or recorded as a gap', () => {
    const deps = loadSkillPythonDeps({ repoRoot: REPO_ROOT });
    // There is no lock, so the declared pins are the known set. A shipped skill
    // that imports a transitive-only dependency is flagged too, which is the
    // right answer: a skill that imports it directly should declare it.
    const bundled = new Set(deps.declaredPackages.map((entry: any) => entry.key));

    const violations: string[] = [];
    for (const skillId of shippedSkillIds()) {
      const skillDir = path.join(REPO_ROOT, 'SKILLs', skillId);
      for (const filePath of collectPythonFiles(skillDir)) {
        for (const module of importedModules(filePath)) {
          if (STDLIB.has(module) || LOCAL_MODULES.has(module)) continue;
          if (Object.prototype.hasOwnProperty.call(INTENTIONALLY_NOT_BUNDLED, module)) continue;

          const distribution = MODULE_TO_DISTRIBUTION[module];
          if (!distribution) {
            violations.push(
              `${path.relative(REPO_ROOT, filePath)} imports "${module}", which is neither stdlib nor `
              + 'mapped to a distribution. Add it to MODULE_TO_DISTRIBUTION and pin it in the '
              + '"packages" table of SKILLs/python-deps.json, or record it in '
              + 'INTENTIONALLY_NOT_BUNDLED with a reason.',
            );
            continue;
          }
          if (bundled.has(normalizePackageName(distribution))) continue;
          violations.push(
            `${path.relative(REPO_ROOT, filePath)} imports "${module}" (${distribution}), which the `
            + `installer does not include. Preinstalled: ${[...bundled].sort().join(', ')}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test('a recorded gap is not shadowed by a package that is bundled after all', () => {
    const deps = loadSkillPythonDeps({ repoRoot: REPO_ROOT });
    const bundled = new Set(deps.declaredPackages.map((entry: any) => entry.key));
    for (const [module, reason] of Object.entries(INTENTIONALLY_NOT_BUNDLED)) {
      const distribution = MODULE_TO_DISTRIBUTION[module];
      if (distribution) {
        expect(
          bundled.has(normalizePackageName(distribution)),
          `${module} is bundled now; drop it from INTENTIONALLY_NOT_BUNDLED`,
        ).toBe(false);
      }
      expect(reason.length, `${module} needs a reason`).toBeGreaterThan(0);
    }
  });
});
