#!/usr/bin/env node
/**
 * Prepare bundled skill Python dependencies inside resources/python-win.
 *
 * The Windows installer ships a portable CPython runtime (see
 * scripts/setup-python-runtime.js). By default that runtime carries only the
 * interpreter, so a freshly installed app has to `pip install` a skill's
 * dependencies on first use — which fails outright on an offline network. This
 * script preinstalls the pinned dependency set from SKILLs/python-deps.json into
 * the runtime, so packaged skills work out of the box.
 *
 * There is no lock file: the config's pins are the single source of truth and
 * pip resolves the transitive closure at build time. Downloads go into a local
 * wheel cache, which is then the only source the install step uses, so the
 * install itself never needs the network.
 *
 * Mirrors setup-python-runtime.js conventions:
 * - `--required` turns failures into a hard error, otherwise it warns and skips
 * - offline operation from a local wheel directory (`--offline`, --wheelhouse)
 * - env overrides via LOBSTERAI_SKILL_PYTHON_*
 * - `--resolve` refreshes the pins in the config from the package index
 *
 * The capability is optional: set LOBSTERAI_SKILL_PYTHON_DEPS_SKIP=1 to build a
 * smaller installer with the interpreter only, as before.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  checkRuntimeHealth,
  ensurePortablePythonRuntime,
  findPortablePythonExecutable,
} = require('./setup-python-runtime.js');
const {
  UNRESOLVED_PIN,
  computeDepsManifestId,
  loadSkillPythonDeps,
  normalizePackageName,
} = require('./skill-python-deps.cjs');

const LOG_TAG = '[skill-python-deps]';
const PROJECT_ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(PROJECT_ROOT, 'resources', 'python-win');
/**
 * Wheel cache. Deliberately NOT under `resources/` or `SKILLs/`: both feed the
 * installer (`extraResources` and the Windows resource tar), so a cache inside
 * them is one broad `resources/**` glob away from shipping ~18 MB of wheels that
 * are already installed into the runtime. Not under `build-tar/` either — that
 * directory means the Windows resource tar specifically, and stretching its
 * meaning for an unrelated cache is how a directory name stops being a
 * guarantee. `.cache/` is gitignored and is only ever a build cache.
 * See the guard in tests/skillPythonDeps.test.ts.
 */
const DEFAULT_WHEELHOUSE = path.join(PROJECT_ROOT, '.cache', 'pip-wheelhouse');
const MANIFEST_FILE_NAME = 'python-deps-manifest.json';
const STATE_FILE_NAME = 'python-deps-state.json';
const MANIFEST_VERSION = 1;

// Bumped when this script's install semantics change in a way that should force
// already-installed apps to re-sync. Feeds computeDepsManifestId().
const SCRIPT_VERSION = 1;

const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
const RESOLVE_TIMEOUT_MS = 15 * 60 * 1000;

// LobsterAI owns these files inside the bundled runtime; a pip install must
// never replace them. Keep in sync with src/main/libs/pythonPipShim.ts.
const PIP_OWNED_SCRIPTS = ['pip', 'pip3', 'pip.cmd', 'pip3.cmd'];
const PIP_OWNED_MODULE_FILES = [
  path.join('Lib', 'site-packages', 'pip', '__main__.py'),
  path.join('Lib', 'site-packages', 'pip', '__init__.py'),
];
/** Stable ABI shim some native wheels (pydantic-core, jiter) link against. */
const STABLE_ABI_DLL = 'python3.dll';

/**
 * Distribution name -> top-level import module, for the import smoke test. A
 * distribution's name often differs from the module it provides, and native
 * wheels can fail to import even when metadata looks correct, so the declared
 * set is exercised by importing rather than only comparing versions.
 */
const IMPORT_ALIASES = {
  pillow: ['PIL'],
  pyyaml: ['yaml'],
  'python-pptx': ['pptx'],
  'python-docx': ['docx'],
  'pdf2image': ['pdf2image'],
  defusedxml: ['defusedxml'],
  lxml: ['lxml.etree'],
  openpyxl: ['openpyxl'],
  pypdf: ['pypdf'],
  requests: ['requests'],
  six: ['six'],
  anthropic: ['anthropic'],
};

/**
 * Version check + import smoke test, run inside the prepared runtime.
 * Reads the manifest path from argv[1] and prints a JSON verdict on stdout.
 *
 * Uses importlib.metadata.distributions() rather than version(name) because
 * distribution names must be compared PEP 503-normalized: `PyYAML`,
 * `python-pptx` and `typing_extensions` otherwise report false mismatches.
 */
const VERIFY_SNIPPET = [
  'import importlib.metadata as md',
  'import json',
  'import sys',
  '',
  'manifest_path = sys.argv[1]',
  "with open(manifest_path, 'r', encoding='utf-8') as handle:",
  '    manifest = json.load(handle)',
  '',
  'def normalize(name):',
  "    return '-'.join(part for part in name.lower().replace('_', '-').replace('.', '-').split('-') if part)",
  '',
  'installed = {}',
  'for dist in md.distributions():',
  '    try:',
  '        installed[normalize(dist.metadata["Name"])] = dist.version',
  '    except Exception:',
  '        continue',
  '',
  'aliases = manifest.get("importAliases", {})',
  'mismatches = []',
  'import_errors = []',
  'missing = []',
  'for name, pin in manifest.get("pins", {}).items():',
  '    expected = pin[2:] if pin.startswith("==") else pin',
  '    actual = installed.get(normalize(name))',
  '    if actual is None:',
  '        missing.append(name)',
  '        continue',
  '    if actual != expected:',
  '        mismatches.append({"name": name, "expected": expected, "actual": actual})',
  '    for module in aliases.get(normalize(name), []):',
  '        try:',
  '            __import__(module)',
  '        except Exception as error:',
  '            import_errors.append({"name": name, "module": module, "error": repr(error)})',
  '',
  'print(json.dumps({',
  '    "ok": not (missing or mismatches or import_errors),',
  '    "missing": missing,',
  '    "mismatches": mismatches,',
  '    "importErrors": import_errors,',
  '}))',
  '',
].join('\n');

function parseArgs(argv) {
  const args = {
    required: argv.includes('--required'),
    resolve: argv.includes('--resolve'),
    write: argv.includes('--write'),
    offline: argv.includes('--offline'),
    verifyOnly: argv.includes('--verify-only'),
    force: argv.includes('--force'),
    runtime: undefined,
    wheelhouse: undefined,
    indexUrl: undefined,
    findLinks: undefined,
  };

  const readValue = (flag) => {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  args.runtime = readValue('--runtime');
  args.wheelhouse = readValue('--wheelhouse');
  args.indexUrl = readValue('--index-url');
  args.findLinks = readValue('--find-links');
  return args;
}

function dirSizeBytes(rootDir) {
  let total = 0;
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        total += fs.statSync(fullPath).size;
      } catch {
        // Size accounting is informational; unreadable files are not fatal.
      }
    }
  }
  return total;
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Run the bundled interpreter. Always shell:false — the arguments include
 * Windows paths with spaces and a multi-line `-c` snippet.
 */
function runPython(pythonExe, args, options = {}) {
  const result = spawnSync(pythonExe, args, {
    cwd: options.cwd || PROJECT_ROOT,
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: options.timeout || INSTALL_TIMEOUT_MS,
    shell: false,
    env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' },
  });
  if (result.error) {
    throw new Error(`failed to run ${pythonExe}: ${result.error.message}`);
  }
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function tail(text, lines = 40) {
  const parts = String(text).trim().split(/\r?\n/);
  return parts.slice(-lines).join('\n');
}

function targetArgs(target) {
  return [
    '--only-binary=:all:',
    `--platform=${target.platform}`,
    `--python-version=${target.pythonVersion}`,
    `--implementation=${target.implementation}`,
  ];
}

function resolveRuntimeDir(options) {
  const runtimeDir = options.runtime
    ? path.resolve(options.runtime)
    : path.resolve(process.env.LOBSTERAI_SKILL_PYTHON_RUNTIME_DIR || RUNTIME_DIR);
  const pythonExe = findPortablePythonExecutable(runtimeDir);
  if (!pythonExe) {
    throw new Error(
      `bundled Python runtime not found at ${runtimeDir}. Run "npm run setup:python-runtime" first.`,
    );
  }
  const health = checkRuntimeHealth(runtimeDir, { requirePip: true });
  if (!health.ok) {
    throw new Error(
      `bundled Python runtime at ${runtimeDir} is not ready; missing: ${health.missing.join(', ')}. `
      + 'Run "npm run setup:python-runtime" first.',
    );
  }
  return { runtimeDir, pythonExe };
}

function resolveWheelhouse(options) {
  if (options.wheelhouse) return path.resolve(options.wheelhouse);
  const fromEnv = process.env.LOBSTERAI_SKILL_PYTHON_WHEELHOUSE;
  return path.resolve(fromEnv || DEFAULT_WHEELHOUSE);
}

/** `name==version` for every declared package, in a stable order. */
function pinnedSpecs(deps) {
  return deps.declaredPackages.map(entry => `${entry.name}${entry.pin}`);
}

function indexArgs(options) {
  return [
    ...(options.indexUrl ? [`--index-url=${options.indexUrl}`] : []),
    ...(options.findLinks ? [`--find-links=${options.findLinks}`] : []),
  ];
}

/**
 * Refresh unresolved pins in the config from the package index.
 *
 * One resolution pass over the whole set, so two declared packages that share a
 * dependency cannot end up disagreeing about its version. A bare name resolves
 * to the newest version the index offers for the target; an existing pin is
 * re-verified rather than replaced.
 */
function resolvePinsFromIndex(runtime, deps, options) {
  const requested = deps.declaredPackages.map(
    entry => (entry.pin === UNRESOLVED_PIN ? entry.name : `${entry.name}${entry.pin}`),
  );

  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-pydeps-'));
  const reportPath = path.join(reportDir, 'report.json');
  try {
    console.log(`${LOG_TAG} Resolving ${requested.length} package(s) for `
      + `${deps.config.target.platform}/${deps.config.target.implementation}${deps.config.target.pythonVersion}...`);
    const result = runPython(runtime.pythonExe, [
      '-m', 'pip', 'install',
      '--dry-run',
      '--ignore-installed',
      '--quiet',
      `--report=${reportPath}`,
      ...targetArgs(deps.config.target),
      ...indexArgs(options),
      ...requested,
    ], { timeout: RESOLVE_TIMEOUT_MS });
    if (result.status !== 0) {
      throw new Error(`pip could not resolve the declared packages:\n${tail(result.stderr || result.stdout)}`);
    }

    const report = readJsonIfExists(reportPath);
    if (!report || !Array.isArray(report.install)) {
      throw new Error(
        `pip produced no resolvable report at ${reportPath}. `
        + 'Pip 22.2+ is required for `--report`; the bundled runtime ships a newer pip.',
      );
    }

    const byName = new Map();
    for (const item of report.install) {
      const name = item.metadata?.name;
      const version = item.metadata?.version;
      if (!name || !version) {
        throw new Error(`pip report entry is missing metadata: ${JSON.stringify(item).slice(0, 200)}`);
      }
      byName.set(normalizePackageName(name), { name, version });
    }
    return byName;
  } finally {
    try {
      fs.rmSync(reportDir, { recursive: true, force: true });
    } catch {
      // Temp cleanup is best effort.
    }
  }
}

/**
 * Write resolved versions back into the config. Without --write this only
 * reports what would change.
 */
function applyResolution(deps, resolvedByName, options) {
  const config = JSON.parse(fs.readFileSync(deps.configPath, 'utf8'));
  const changes = [];
  for (const [name, pin] of Object.entries(config.packages || {})) {
    const resolved = resolvedByName.get(normalizePackageName(name));
    if (!resolved) {
      throw new Error(`the index resolved no version for ${name}; check the package name and the index`);
    }
    const nextPin = `==${resolved.version}`;
    if (pin !== nextPin) {
      changes.push({ name, from: pin, to: nextPin });
      config.packages[name] = nextPin;
    }
  }

  if (changes.length > 0) {
    console.log(`${LOG_TAG} Pin changes:`);
    for (const change of changes) {
      console.log(`${LOG_TAG}   ${change.name}: ${change.from} -> ${change.to}`);
    }
  } else {
    console.log(`${LOG_TAG} All declared pins already match the index.`);
  }

  if (!options.write) {
    console.log(`${LOG_TAG} Dry run. Re-run with --write to update the config.`);
    return { changes };
  }

  fs.writeFileSync(deps.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  console.log(`${LOG_TAG} Updated ${deps.configPath}`);
  return { changes };
}

/**
 * Whether the wheel cache can already satisfy the declared set, resolved
 * locally with no network. `--dry-run` resolves the full transitive closure
 * against the directory, so this verifies availability rather than just
 * checking that some wheel files happen to exist.
 *
 * `--ignore-installed` is essential: without it pip reports "requirement already
 * satisfied" against whatever the target runtime happens to have installed and
 * exits 0, so a warm runtime would make an empty cache look complete and the
 * wheels would never be cached.
 */
function wheelhouseSatisfies(runtime, options, specs) {
  if (specs.length === 0) return true;
  const result = runPython(runtime.pythonExe, [
    '-m', 'pip', 'install',
    '--dry-run',
    '--ignore-installed',
    '--quiet',
    '--no-index',
    `--find-links=${options.wheelhouse}`,
    ...specs,
  ], { timeout: RESOLVE_TIMEOUT_MS });
  return result.status === 0;
}

function downloadWheels(runtime, deps, options, specs) {
  fs.mkdirSync(options.wheelhouse, { recursive: true });

  if (wheelhouseSatisfies(runtime, options, specs)) {
    console.log(`${LOG_TAG} Wheel cache already satisfies the declared set: ${options.wheelhouse}`);
    return;
  }
  if (options.offline) {
    throw new Error(
      `offline mode requested but ${options.wheelhouse} cannot satisfy the declared set. `
      + 'Populate it from a connected machine, or point --wheelhouse / '
      + 'LOBSTERAI_SKILL_PYTHON_WHEELHOUSE at a directory that already has the wheels.',
    );
  }

  console.log(`${LOG_TAG} Downloading wheels into ${options.wheelhouse}...`);
  const result = runPython(runtime.pythonExe, [
    '-m', 'pip', 'download',
    ...targetArgs(deps.config.target),
    ...indexArgs(options),
    '--dest', options.wheelhouse,
    '--no-input',
    ...specs,
  ], { timeout: INSTALL_TIMEOUT_MS });
  if (result.status !== 0) {
    throw new Error(
      `pip download failed:\n${tail(result.stderr || result.stdout)}\n`
      + 'For a network-isolated build, seed the wheel cache from a connected machine '
      + 'or set LOBSTERAI_SKILL_PYTHON_INDEX_URL to an internal mirror.',
    );
  }

  if (!wheelhouseSatisfies(runtime, options, specs)) {
    throw new Error(`wheel cache is still incomplete after download: ${options.wheelhouse}`);
  }
}

/**
 * Snapshot the pip-owned files so a pip install can be cleaned up afterwards
 * without ever touching LobsterAI's shim.
 */
function snapshotScriptsDir(runtimeDir) {
  const scriptsDir = path.join(runtimeDir, 'Scripts');
  const before = new Set();
  try {
    for (const entry of fs.readdirSync(scriptsDir, { withFileTypes: true })) {
      before.add(entry.name);
    }
  } catch {
    // A missing Scripts dir is reported by checkRuntimeHealth.
  }
  return { scriptsDir, before };
}

function cleanupAfterInstall(runtimeDir, snapshot) {
  const { scriptsDir, before } = snapshot;
  const removed = [];
  let entries = [];
  try {
    entries = fs.readdirSync(scriptsDir, { withFileTypes: true });
  } catch {
    return removed;
  }

  for (const entry of entries) {
    const fullPath = path.join(scriptsDir, entry.name);
    if (entry.isDirectory() && entry.name === '__pycache__') {
      fs.rmSync(fullPath, { recursive: true, force: true });
      removed.push(entry.name);
      continue;
    }
    // Only console-script .exe shims pip generated during this run. The
    // LobsterAI pip wrappers are not .exe files and must survive.
    if (!before.has(entry.name) && entry.name.toLowerCase().endsWith('.exe')) {
      fs.rmSync(fullPath, { force: true });
      removed.push(entry.name);
    }
  }

  const lost = [];
  for (const name of PIP_OWNED_SCRIPTS) {
    if (!fs.existsSync(path.join(scriptsDir, name))) lost.push(path.posix.join('Scripts', name));
  }
  for (const relPath of PIP_OWNED_MODULE_FILES) {
    if (!fs.existsSync(path.join(runtimeDir, relPath))) lost.push(relPath.replace(/\\/g, '/'));
  }
  if (lost.length > 0) {
    throw new Error(
      `installing dependencies replaced LobsterAI-owned pip files: ${lost.join(', ')}. `
      + 'Check that no declared package depends on pip/setuptools/wheel (see DENIED_PACKAGES).',
    );
  }

  return removed;
}

function installIntoRuntime(runtime, options, specs) {
  // The wheel cache is complete by now, so the install itself never needs the
  // network.
  const result = runPython(runtime.pythonExe, [
    '-m', 'pip', 'install',
    '--no-index',
    `--find-links=${options.wheelhouse}`,
    '--no-warn-script-location',
    '--no-input',
    ...specs,
  ], { timeout: INSTALL_TIMEOUT_MS });
  if (result.status !== 0) {
    throw new Error(`pip install into the bundled runtime failed:\n${tail(result.stderr || result.stdout)}`);
  }
  return result.stdout;
}

/** How many distributions pip reported installing, for the log line. */
function countInstalled(stdout) {
  const match = /Successfully installed ([^\n]+)/.exec(stdout);
  if (!match) return null;
  return match[1].trim().split(/\s+/).filter(Boolean).length;
}

function writeManifest(runtimeDir, deps, pins, manifestId) {
  const manifest = {
    version: MANIFEST_VERSION,
    manifestId,
    generatedAt: new Date().toISOString(),
    target: deps.config.target,
    pins: Object.fromEntries(Object.entries(pins).sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    importAliases: IMPORT_ALIASES,
  };
  const manifestPath = path.join(runtimeDir, MANIFEST_FILE_NAME);
  writeJson(manifestPath, manifest);
  return manifestPath;
}

function verifyInstalled(runtime, manifestPath, runtimeDir) {
  const result = runPython(runtime.pythonExe, ['-c', VERIFY_SNIPPET, manifestPath], { timeout: 5 * 60 * 1000 });
  if (result.status !== 0) {
    throw new Error(`dependency verification failed to run:\n${tail(result.stderr || result.stdout)}`);
  }
  let verdict;
  try {
    verdict = JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
  } catch {
    throw new Error(`dependency verification produced unreadable output:\n${tail(result.stdout)}`);
  }

  const problems = [];
  if (verdict.missing?.length) problems.push(`not importable as distributions: ${verdict.missing.join(', ')}`);
  if (verdict.mismatches?.length) {
    problems.push(`version mismatches: ${verdict.mismatches
      .map(item => `${item.name} expected ${item.expected} got ${item.actual}`)
      .join('; ')}`);
  }
  if (verdict.importErrors?.length) {
    problems.push(`import failures: ${verdict.importErrors
      .map(item => `${item.module} (${item.name}): ${item.error}`)
      .join('; ')}`);
  }

  // Native wheels link against the stable ABI DLL; a missing one shows up as a
  // DLL load failure at first import, far from the packaging step.
  if (!fs.existsSync(path.join(runtimeDir, STABLE_ABI_DLL))) {
    problems.push(`missing ${STABLE_ABI_DLL}, required by native wheels (e.g. pydantic-core)`);
  }

  return { ok: problems.length === 0, problems };
}

function readState(runtimeDir) {
  return readJsonIfExists(path.join(runtimeDir, STATE_FILE_NAME));
}

function writeState(runtimeDir, payload) {
  writeJson(path.join(runtimeDir, STATE_FILE_NAME), payload);
}

/**
 * Install the pinned skill Python dependencies into the bundled runtime.
 *
 * @param {{ required?: boolean, runtime?: string, wheelhouse?: string,
 *   offline?: boolean, verifyOnly?: boolean, force?: boolean, resolve?: boolean,
 *   write?: boolean, indexUrl?: string, findLinks?: string, repoRoot?: string }} [options]
 * @returns {{ ok: boolean, skipped: boolean, manifestId?: string, error?: string }}
 */
async function ensureSkillPythonDeps(options = {}) {
  if (process.env.LOBSTERAI_SKILL_PYTHON_DEPS_SKIP === '1') {
    console.log(
      `${LOG_TAG} LOBSTERAI_SKILL_PYTHON_DEPS_SKIP=1; building an interpreter-only runtime `
      + 'without preinstalled skill dependencies.',
    );
    return { ok: true, skipped: true };
  }

  if (process.platform !== 'win32' && !options.runtime && !options.force) {
    console.log(`${LOG_TAG} Windows-only capability; skipping on ${process.platform}.`);
    return { ok: true, skipped: true };
  }

  try {
    // The target runtime must be prepared before its dependencies can be
    // resolved or installed. --required so a cross-platform build fails loudly
    // instead of silently shipping an empty runtime.
    await ensurePortablePythonRuntime({ required: true });
    const runtime = resolveRuntimeDir(options);

    // The resolution pass runs before the pins are filled in, so it reads a
    // deliberately looser view of the same config.
    const deps = loadSkillPythonDeps({
      repoRoot: options.repoRoot,
      allowUnresolvedPins: options.resolve === true,
    });
    options.wheelhouse = resolveWheelhouse(options);

    console.log(`${LOG_TAG} ${deps.declaredPackages.length} declared package(s) for `
      + `${deps.config.target.platform}/${deps.config.target.implementation}${deps.config.target.pythonVersion}`);

    if (options.resolve) {
      const resolved = resolvePinsFromIndex(runtime, deps, options);
      applyResolution(deps, resolved, options);
      return { ok: true, skipped: false, manifestId: undefined };
    }

    const specs = pinnedSpecs(deps);
    const pins = Object.fromEntries(deps.declaredPackages.map(entry => [entry.key, entry.pin]));
    const manifestId = computeDepsManifestId({ pins, scriptVersion: SCRIPT_VERSION });

    const manifestPath = path.join(runtime.runtimeDir, MANIFEST_FILE_NAME);
    const existing = readJsonIfExists(manifestPath);

    if (options.verifyOnly) {
      const verify = verifyInstalled(runtime, manifestPath, runtime.runtimeDir);
      if (!verify.ok) {
        throw new Error(`runtime dependency verification failed: ${verify.problems.join('; ')}`);
      }
      console.log(`${LOG_TAG} Verification passed for ${specs.length} declared package(s).`);
      return { ok: true, skipped: true, manifestId: existing?.manifestId };
    }

    if (!options.force && existing?.manifestId === manifestId) {
      console.log(`${LOG_TAG} Runtime already has this dependency set (${manifestId}); verifying...`);
      const verify = verifyInstalled(runtime, manifestPath, runtime.runtimeDir);
      if (verify.ok) {
        console.log(`${LOG_TAG} Up to date.`);
        return { ok: true, skipped: true, manifestId };
      }
      console.warn(`${LOG_TAG} Cached install is incomplete (${verify.problems.join('; ')}); reinstalling.`);
    }

    downloadWheels(runtime, deps, options, specs);

    const scriptsSnapshot = snapshotScriptsDir(runtime.runtimeDir);
    const beforeBytes = dirSizeBytes(runtime.runtimeDir);
    const stdout = installIntoRuntime(runtime, options, specs);
    const removed = cleanupAfterInstall(runtime.runtimeDir, scriptsSnapshot);
    if (removed.length > 0) {
      console.log(`${LOG_TAG} Cleaned up generated launch shims: ${removed.join(', ')}`);
    }

    const writtenManifestPath = writeManifest(runtime.runtimeDir, deps, pins, manifestId);

    const verify = verifyInstalled(runtime, writtenManifestPath, runtime.runtimeDir);
    if (!verify.ok) {
      throw new Error(`installed dependency set failed verification: ${verify.problems.join('; ')}`);
    }

    const afterBytes = dirSizeBytes(runtime.runtimeDir);
    writeState(runtime.runtimeDir, {
      manifestId,
      installedAt: new Date().toISOString(),
      packages: specs.length,
      runtimeBytes: afterBytes,
    });

    const installed = countInstalled(stdout);
    const delta = (afterBytes - beforeBytes) / 1024 / 1024;
    console.log(
      `${LOG_TAG} Installed ${specs.length} declared package(s)`
      + `${installed === null ? '' : ` (${installed} total including dependencies)`} into `
      + `${runtime.runtimeDir}; runtime +${delta.toFixed(1)} MB.`,
    );
    console.log(`${LOG_TAG} Manifest: ${writtenManifestPath}`);
    return { ok: true, skipped: false, manifestId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.required) {
      throw error;
    }
    console.warn(`${LOG_TAG} Skipping bundled skill Python dependencies: ${message}`);
    console.warn(`${LOG_TAG}   (This is only a warning - skills will install their dependencies at runtime if needed.)`);
    return { ok: false, skipped: true, error: message };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await ensureSkillPythonDeps({
    required: args.required,
    resolve: args.resolve,
    write: args.write,
    offline: args.offline,
    verifyOnly: args.verifyOnly,
    force: args.force,
    runtime: args.runtime,
    wheelhouse: args.wheelhouse,
    indexUrl: args.indexUrl || process.env.LOBSTERAI_SKILL_PYTHON_INDEX_URL,
    findLinks: args.findLinks || process.env.LOBSTERAI_SKILL_PYTHON_FIND_LINKS,
  });
  if (args.required && !result.ok) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`${LOG_TAG} ERROR:`, error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_WHEELHOUSE,
  MANIFEST_FILE_NAME,
  RUNTIME_DIR,
  SCRIPT_VERSION,
  ensureSkillPythonDeps,
  parseArgs,
};
