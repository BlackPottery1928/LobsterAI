import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => path.join(os.tmpdir(), 'lobsterai-test-userdata'),
    getAppPath: () => process.cwd(),
  },
}));

const { readDepsManifestId, shouldResyncPythonRuntime } = await import('./pythonRuntime');

const tempDirs: string[] = [];

function makeRuntimeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-pyruntime-'));
  tempDirs.push(root);
  return root;
}

function writeManifest(root: string, payload: unknown): void {
  fs.writeFileSync(path.join(root, 'python-deps-manifest.json'), JSON.stringify(payload), 'utf8');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('readDepsManifestId', () => {
  test('reads the manifest id written by the packaging script', () => {
    const root = makeRuntimeRoot();
    writeManifest(root, {
      version: 1,
      manifestId: 'sha256:abc',
      pins: { lxml: '==6.1.3' },
      importAliases: { lxml: ['lxml.etree'] },
    });
    expect(readDepsManifestId(root)).toBe('sha256:abc');
  });

  test('returns null for a missing, malformed or empty manifest', () => {
    const root = makeRuntimeRoot();
    expect(readDepsManifestId(root)).toBeNull();

    fs.writeFileSync(path.join(root, 'python-deps-manifest.json'), '{not json', 'utf8');
    expect(readDepsManifestId(root)).toBeNull();

    writeManifest(root, { manifestId: '' });
    expect(readDepsManifestId(root)).toBeNull();

    writeManifest(root, { manifestId: 42 });
    expect(readDepsManifestId(root)).toBeNull();

    writeManifest(root, {});
    expect(readDepsManifestId(root)).toBeNull();
  });
});

describe('shouldResyncPythonRuntime', () => {
  test('a runtime built without a manifest never triggers a re-sync', () => {
    // Development trees and builds made before this feature (or with
    // LOBSTERAI_SKILL_PYTHON_DEPS_SKIP=1) stay on the old behavior.
    expect(shouldResyncPythonRuntime({ bundledManifestId: null, userManifestId: null })).toBe(false);
    expect(shouldResyncPythonRuntime({ bundledManifestId: null, userManifestId: 'sha256:a' })).toBe(false);
  });

  test('an existing install without a manifest is re-synced once', () => {
    // Every install predating this feature lands here, and gets the preinstalled
    // dependencies on the first launch after upgrading.
    expect(shouldResyncPythonRuntime({ bundledManifestId: 'sha256:a', userManifestId: null })).toBe(true);
  });

  test('a changed bundled dependency set is re-synced', () => {
    expect(shouldResyncPythonRuntime({ bundledManifestId: 'sha256:b', userManifestId: 'sha256:a' })).toBe(true);
  });

  test('an unchanged dependency set is left alone', () => {
    // The common case: re-copying tens of megabytes on every launch would be a
    // real startup regression.
    expect(shouldResyncPythonRuntime({ bundledManifestId: 'sha256:a', userManifestId: 'sha256:a' })).toBe(false);
  });

  test('a malformed bundled manifest is treated as no manifest', () => {
    // readDepsManifestId returns null for a corrupt file, so a damaged install
    // must not re-copy the runtime on every single launch.
    const root = makeRuntimeRoot();
    fs.writeFileSync(path.join(root, 'python-deps-manifest.json'), '{oops', 'utf8');
    const bundledManifestId = readDepsManifestId(root);
    expect(bundledManifestId).toBeNull();
    expect(shouldResyncPythonRuntime({ bundledManifestId, userManifestId: 'sha256:a' })).toBe(false);
  });
});
