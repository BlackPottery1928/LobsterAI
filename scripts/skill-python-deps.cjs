'use strict';

/**
 * skill-python-deps.cjs
 *
 * Build-time skill Python dependencies. `SKILLs/python-deps.json` is a flat map
 * of package -> exact version pin: the set of packages preinstalled into the
 * bundled Windows Python runtime.
 *
 * Deliberately small. There is no lock file: the config is the single source of
 * truth and pip resolves the transitive closure at build time. The trade-off is
 * that installs are not hash-verified, so offline builds rely on a wheel cache
 * that is checked by wheel file name rather than sha256. See
 * docs/skill-python-deps.md.
 *
 * Similarly, documenting *why* each package is here and what cannot be bundled
 * lives in docs/skill-python-deps.md. Machine-checkable guarantees are kept
 * here instead:
 *
 *   - every pin is an exact `==` version (reproducible packaged builds);
 *   - no package that would overwrite LobsterAI's own files in the runtime.
 *
 * tests/skillPythonDepsCoverage.test.ts closes the loop from the other side: it
 * walks the shipped skills' Python sources and fails when a shipped skill
 * imports something this flat list does not provide.
 *
 * Mirrors scripts/skill-exclusions.cjs: fail-loud (every validation failure
 * throws and aborts the build), memoized per repo root, test reset hook.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LOG_TAG = '[skill-python-deps]';
const SKILLS_DIR_NAME = 'SKILLs';
const CONFIG_FILE_NAME = 'python-deps.json';
const CONFIG_VERSION = 1;

/**
 * Version pin that means "not resolved yet". Committed configs carry these
 * placeholders so a build can never silently ship unresolved versions; run
 * `node scripts/setup-skill-python-deps.js --resolve --write` to fill them in
 * from the package index.
 */
const UNRESOLVED_PIN = '==0.0.0';

/** Exact `==` pin, e.g. `==1.2.3`, `==2.0.0rc1`, `==1!2.0`. No ranges, no `*`. */
const PIN_PATTERN = /^==\d+(\.\d+)*([A-Za-z0-9.+-]*)?$/;
/** Distribution names only; no extras, markers, urls or separators. */
const PACKAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Packages that must never be installed into the runtime: LobsterAI owns the pip
 * shim at Lib/site-packages/pip (see src/main/libs/pythonPipShim.ts, which is
 * byte-identity-checked against scripts/setup-python-runtime.js). Installing any
 * of these would replace it. Not configurable on purpose — a build that needs to
 * change this list needs a code review, not an env var.
 */
const DENIED_PACKAGES = ['pip', 'setuptools', 'wheel'];

const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..');

/** Cache keyed by repo root + strictness, so one build reads the config once. */
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

/**
 * PEP 503 name normalization: lowercase and collapse runs of `-_.` to `-`.
 * `PyYAML` and `pyyaml` are the same distribution; comparing raw names would
 * report false mismatches against the runtime's installed set.
 */
function normalizePackageName(name) {
  return String(name).trim().toLowerCase().replace(/[-_.]+/g, '-');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseTarget(config, configPath) {
  const target = config.target;
  if (!isPlainObject(target)) {
    fail(`${CONFIG_FILE_NAME} at ${configPath} must declare a "target" object`);
  }
  const normalized = {};
  for (const key of ['platform', 'implementation', 'pythonVersion']) {
    const value = target[key];
    if (typeof value !== 'string' || !value.trim()) {
      fail(`${CONFIG_FILE_NAME} at ${configPath} must declare target.${key} as a non-empty string`);
    }
    if (!/^[A-Za-z0-9._-]+$/.test(value.trim())) {
      fail(`${CONFIG_FILE_NAME} at ${configPath} has an invalid target.${key} ${JSON.stringify(value)}`);
    }
    normalized[key] = value.trim();
  }
  return normalized;
}

/**
 * Validate the parsed `SKILLs/python-deps.json`.
 *
 * @param {unknown} config parsed JSON
 * @param {string} configPath path used in error messages
 * @param {{ allowUnresolvedPins?: boolean }} [options] `--resolve` must be able
 *   to read a config full of placeholders in order to fill them in, so that one
 *   caller opts out of the placeholder check.
 * @returns {{ version: number, target: object,
 *   packages: Record<string, { name: string, pin: string, version: string }> }}
 */
function parseSkillPythonDepsConfig(config, configPath, options = {}) {
  if (!isPlainObject(config)) {
    fail(`${CONFIG_FILE_NAME} at ${configPath} must be a JSON object`);
  }
  if (config.version !== CONFIG_VERSION) {
    fail(
      `${CONFIG_FILE_NAME} at ${configPath} must declare "version": ${CONFIG_VERSION}, `
      + `found ${JSON.stringify(config.version)}`,
    );
  }
  const target = parseTarget(config, configPath);

  if (!isPlainObject(config.packages)) {
    fail(`${CONFIG_FILE_NAME} at ${configPath} must declare a "packages" object`);
  }
  const deniedSet = new Set(DENIED_PACKAGES);
  const packages = {};
  for (const [rawName, rawPin] of Object.entries(config.packages)) {
    const where = 'packages';
    if (typeof rawName !== 'string' || !PACKAGE_NAME_PATTERN.test(rawName)) {
      fail(
        `${where} in ${configPath} has an invalid package name ${JSON.stringify(rawName)}. `
        + 'Use a bare distribution name; extras and markers are not supported here.',
      );
    }
    const key = normalizePackageName(rawName);
    if (deniedSet.has(key)) {
      fail(
        `${where} in ${configPath} lists ${JSON.stringify(rawName)}, which LobsterAI owns inside the `
        + 'runtime. Installing it would overwrite the bundled pip shim.',
      );
    }
    if (Object.prototype.hasOwnProperty.call(packages, key)) {
      fail(`${where} in ${configPath} lists ${JSON.stringify(rawName)} more than once (names are case-insensitive)`);
    }
    if (typeof rawPin !== 'string' || !rawPin.trim()) {
      fail(`${where} in ${configPath} must give a non-empty version pin for ${JSON.stringify(rawName)}`);
    }
    const pin = rawPin.trim();
    if (!PIN_PATTERN.test(pin)) {
      fail(
        `${where} in ${configPath} pins ${JSON.stringify(rawName)} to ${JSON.stringify(rawPin)}. `
        + 'Every Python dependency must use an exact "==<version>" pin (no >=, ~=, *, !=, '
        + 'environment markers or "name @ url" forms) so packaged builds are reproducible.',
      );
    }
    if (pin === UNRESOLVED_PIN && !options.allowUnresolvedPins) {
      fail(
        `${where} in ${configPath} still has the unresolved placeholder for ${JSON.stringify(rawName)}. `
        + 'Run "node scripts/setup-skill-python-deps.js --resolve --write" to fill in the versions '
        + 'resolved from the package index for the configured target.',
      );
    }
    packages[key] = { name: rawName, pin, version: pin.slice(2) };
  }
  if (Object.keys(packages).length === 0) {
    fail(`${CONFIG_FILE_NAME} at ${configPath} pins no packages`);
  }

  return { version: CONFIG_VERSION, target, packages };
}

/**
 * The declared packages as a deterministic, sorted list.
 *
 * @returns {Array<{ key: string, name: string, pin: string, version: string }>}
 */
function collectDeclaredPackages(config) {
  return Object.entries(config.packages)
    .map(([key, entry]) => ({ key, name: entry.name, pin: entry.pin, version: entry.version }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Stable identity of the declared dependency set. Deliberately excludes
 * timestamps and anything the resolver decides on its own: the runtime compares
 * this id against the one recorded in userData to decide whether the bundled
 * runtime must be re-synced, and a per-build-changing value would force every
 * installed app to re-copy tens of megabytes on every release.
 */
function computeDepsManifestId({ pins, scriptVersion }) {
  const canonical = {
    scriptVersion: scriptVersion || 1,
    pins: Object.fromEntries(
      Object.entries(pins || {})
        .map(([name, pin]) => [normalizePackageName(name), String(pin)])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    ),
  };
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

/**
 * Read, validate and cache `SKILLs/python-deps.json`.
 *
 * @param {{ repoRoot?: string, allowUnresolvedPins?: boolean }} [options]
 *   `allowUnresolvedPins` is for the `--resolve` pass, which by definition runs
 *   before the pins are filled in.
 */
function loadSkillPythonDeps(options = {}) {
  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : DEFAULT_REPO_ROOT;
  const cacheKey = `${repoRoot} ${options.allowUnresolvedPins ? 'loose' : 'strict'}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const skillsDir = path.join(repoRoot, SKILLS_DIR_NAME);
  const configPath = path.join(skillsDir, CONFIG_FILE_NAME);

  if (!fs.existsSync(configPath)) {
    fail(`missing ${configPath}; every packaged build requires a skill Python dependency config`);
  }
  const config = parseSkillPythonDepsConfig(readJsonFile(configPath, CONFIG_FILE_NAME), configPath, {
    allowUnresolvedPins: options.allowUnresolvedPins === true,
  });

  const result = Object.freeze({
    repoRoot,
    config,
    configPath,
    skillsDir,
    declaredPackages: collectDeclaredPackages(config),
  });
  cache.set(cacheKey, result);
  return result;
}

/** Test-only: drop the memoized config so fixtures can be re-read. */
function resetSkillPythonDepsCacheForTests() {
  cache.clear();
}

module.exports = {
  CONFIG_FILE_NAME,
  DENIED_PACKAGES,
  LOG_TAG,
  PIN_PATTERN,
  UNRESOLVED_PIN,
  collectDeclaredPackages,
  computeDepsManifestId,
  loadSkillPythonDeps,
  normalizePackageName,
  parseSkillPythonDepsConfig,
  resetSkillPythonDepsCacheForTests,
};
