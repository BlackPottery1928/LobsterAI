import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const {
  DENIED_PACKAGES,
  UNRESOLVED_PIN,
  collectDeclaredPackages,
  computeDepsManifestId,
  loadSkillPythonDeps,
  normalizePackageName,
  parseSkillPythonDepsConfig,
  resetSkillPythonDepsCacheForTests,
} = require('../scripts/skill-python-deps.cjs');
const { DEFAULT_WHEELHOUSE } = require('../scripts/setup-skill-python-deps.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'SKILLs', 'python-deps.json');

afterEach(() => {
  resetSkillPythonDepsCacheForTests();
});

/** Minimal valid config; individual tests override one thing at a time. */
function validConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    target: { platform: 'win_amd64', implementation: 'cp', pythonVersion: '311' },
    packages: { lxml: '==1.0.0' },
    ...overrides,
  };
}

describe('skill python dependency config', () => {
  test('the committed config is valid', () => {
    const deps = loadSkillPythonDeps({ repoRoot: REPO_ROOT });
    expect(deps.config.version).toBe(1);
    expect(deps.declaredPackages.length).toBeGreaterThan(0);
  });

  test('the config is a flat package table with no extra structure', () => {
    // The whole point of the shape: adding a package is editing one line, and
    // there is no group / skill mapping / lock to keep in sync.
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    expect(Object.keys(raw).sort()).toEqual(['description', 'packages', 'target', 'version']);
    for (const removed of ['groups', 'defaultGroups', 'skills', 'deniedPackages', 'excludedPackages', 'nonPipRequirements']) {
      expect(raw, `${removed} should not be back in the config`).not.toHaveProperty(removed);
    }
  });

  test('there is no lock file to keep in sync', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'SKILLs', 'python-deps.lock.json'))).toBe(false);
    const scripts = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts', 'setup-skill-python-deps.js'),
      'utf8',
    );
    expect(scripts).not.toContain('require-hashes');
    expect(scripts).not.toContain('LOCK_FILE_NAME');
  });

  test('every declared dependency is pinned to an exact version', () => {
    const deps = loadSkillPythonDeps({ repoRoot: REPO_ROOT });
    for (const [key, entry] of Object.entries(deps.config.packages) as Array<[string, any]>) {
      expect(entry.pin, key).toMatch(/^==\d/);
      expect(entry.pin, key).not.toBe(UNRESOLVED_PIN);
    }
  });

  test('non-exact pins are rejected', () => {
    for (const pin of ['>=1.0.0', '~=1.0', '*', '1.0.0', '!=1.0.0', '==1.*', '==1.0.0; python_version>"3"']) {
      expect(
        () => parseSkillPythonDepsConfig(validConfig({ packages: { lxml: pin } }), CONFIG_PATH),
        `pin ${pin}`,
      ).toThrow(/exact "==<version>" pin/);
    }
  });

  test('the unresolved placeholder is rejected unless resolving', () => {
    const config = validConfig({ packages: { lxml: UNRESOLVED_PIN } });
    expect(() => parseSkillPythonDepsConfig(config, CONFIG_PATH)).toThrow(/unresolved placeholder/);
    expect(() => parseSkillPythonDepsConfig(config, CONFIG_PATH, { allowUnresolvedPins: true })).not.toThrow();
  });

  test('packages LobsterAI owns inside the runtime are rejected', () => {
    for (const denied of DENIED_PACKAGES) {
      expect(
        () => parseSkillPythonDepsConfig(validConfig({ packages: { [denied]: '==24.0' } }), CONFIG_PATH),
        denied,
      ).toThrow(/which LobsterAI owns inside the runtime/);
    }
  });

  test('invalid package names are rejected', () => {
    for (const name of ['my package', 'lxml[html]', 'lxml @ https://x/y.whl']) {
      expect(
        () => parseSkillPythonDepsConfig(validConfig({ packages: { [name]: '==1.0.0' } }), CONFIG_PATH),
        name,
      ).toThrow(/invalid package name/);
    }
  });

  test('a case-insensitive duplicate is rejected', () => {
    expect(() => parseSkillPythonDepsConfig(
      validConfig({ packages: { PyYAML: '==1.0.0', pyyaml: '==1.0.0' } }),
      CONFIG_PATH,
    )).toThrow(/more than once/);
  });

  test('a wrong config version aborts', () => {
    expect(() => parseSkillPythonDepsConfig(validConfig({ version: 2 }), CONFIG_PATH))
      .toThrow(/must declare "version": 1/);
  });

  test('a non-string pin aborts', () => {
    expect(() => parseSkillPythonDepsConfig(validConfig({ packages: { lxml: 1 } }), CONFIG_PATH))
      .toThrow(/non-empty version pin/);
  });

  test('an incomplete target aborts', () => {
    expect(() => parseSkillPythonDepsConfig(
      validConfig({ target: { platform: 'win_amd64' } }),
      CONFIG_PATH,
    )).toThrow(/must declare target.implementation/);
  });

  test('a config with no packages aborts', () => {
    expect(() => parseSkillPythonDepsConfig(validConfig({ packages: {} }), CONFIG_PATH))
      .toThrow(/pins no packages/);
  });

  test('a missing config is reported', () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-deps-'));
    try {
      expect(() => loadSkillPythonDeps({ repoRoot: emptyRoot })).toThrow(/missing/);
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe('declared packages', () => {
  test('are returned sorted and complete', () => {
    const deps = loadSkillPythonDeps({ repoRoot: REPO_ROOT });
    const declared = collectDeclaredPackages(deps.config);
    expect(declared.length).toBe(Object.keys(deps.config.packages).length);
    const keys = declared.map((entry: any) => entry.key);
    expect(keys).toEqual([...keys].sort());
  });

  test('carry the version both as a pin and separately', () => {
    const deps = loadSkillPythonDeps({ repoRoot: REPO_ROOT });
    for (const entry of deps.declaredPackages as any[]) {
      expect(entry.pin).toBe(`==${entry.version}`);
      expect(entry.version).not.toMatch(/^=/);
    }
  });
});

describe('dependency manifest id', () => {
  const base = { pins: { lxml: '==1.0.0', requests: '==2.0.0' }, scriptVersion: 1 };

  test('is stable for the same dependency set', () => {
    expect(computeDepsManifestId(base)).toBe(computeDepsManifestId({ ...base }));
  });

  test('changes when a pin changes', () => {
    expect(computeDepsManifestId(base)).not.toBe(
      computeDepsManifestId({ ...base, pins: { ...base.pins, lxml: '==1.0.1' } }),
    );
  });

  test('changes when a package is added', () => {
    expect(computeDepsManifestId(base)).not.toBe(
      computeDepsManifestId({ ...base, pins: { ...base.pins, six: '==1.0.0' } }),
    );
  });

  test('changes when the install semantics change', () => {
    expect(computeDepsManifestId(base)).not.toBe(computeDepsManifestId({ ...base, scriptVersion: 2 }));
  });

  test('is insensitive to key insertion order and name spelling', () => {
    expect(computeDepsManifestId({ ...base, pins: { requests: '==2.0.0', lxml: '==1.0.0' } }))
      .toBe(computeDepsManifestId(base));
    expect(computeDepsManifestId({ ...base, pins: { PyYAML: '==1.0.0' } }))
      .toBe(computeDepsManifestId({ ...base, pins: { pyyaml: '==1.0.0' } }));
  });
});

describe('the wheel cache never reaches a package', () => {
  test('the default wheel cache lives outside every packaged directory', () => {
    // resources/ and SKILLs/ both feed the installer (extraResources on
    // mac/linux, the resource tar on Windows). A cache inside either is one
    // broad glob away from shipping ~18 MB of wheels that are already
    // installed into the runtime.
    const relative = path.relative(REPO_ROOT, DEFAULT_WHEELHOUSE).replace(/\\/g, '/');
    expect(relative.startsWith('resources/'), `wheelhouse is at ${relative}`).toBe(false);
    expect(relative.startsWith('SKILLs/'), `wheelhouse is at ${relative}`).toBe(false);
    // build-tar/ means the Windows resource tar specifically; an unrelated cache
    // there would stretch the meaning of a directory name that other steps rely
    // on. .cache/ is only ever a build cache.
    expect(relative.startsWith('build-tar/'), `wheelhouse is at ${relative}`).toBe(false);
    expect(relative.startsWith('.cache/'), `wheelhouse is at ${relative}`).toBe(true);
  });

  test('no packaging config or hook references the wheel cache', () => {
    const sources = [
      'electron-builder.json',
      path.join('scripts', 'electron-builder-config.cjs'),
      path.join('scripts', 'electron-builder-hooks.cjs'),
      path.join('scripts', 'pack-openclaw-tar.cjs'),
    ];
    for (const relative of sources) {
      const text = fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
      expect(text, `${relative} must not package the wheel cache`).not.toContain('pip-wheelhouse');
    }
  });

  test('the wheel cache is gitignored', () => {
    const relative = path.relative(REPO_ROOT, DEFAULT_WHEELHOUSE).replace(/\\/g, '/');
    const ignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    const covered = ignore
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#') && !line.startsWith('!'))
      .some(pattern => relative.startsWith(pattern.replace(/^\//, '').replace(/\*+$/, '')));
    expect(covered, `${relative} is not matched by .gitignore`).toBe(true);
  });
});

describe('normalizePackageName', () => {
  test('applies PEP 503 normalization', () => {
    expect(normalizePackageName('PyYAML')).toBe('pyyaml');
    expect(normalizePackageName('python_pptx')).toBe('python-pptx');
    expect(normalizePackageName('typing...extensions')).toBe('typing-extensions');
  });
});
