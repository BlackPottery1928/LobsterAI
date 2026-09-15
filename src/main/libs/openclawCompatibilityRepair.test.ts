import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { OPENCLAW_REPAIR_ENTRY, OPENCLAW_REPAIR_RESULT_PREFIX, OpenClawRepairPhase } from '../../shared/openclawEngine/repair';
import { createOpenClawRepairBackupDirectory, OPENCLAW_DOCTOR_REPAIR_ARGS, runOpenClawCompatibilityRepair, runOpenClawDoctorRepair } from './openclawCompatibilityRepair';
import type { StartupMigrationRunner } from './openclawStartupStateMigration';

const directories: string[] = [];
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-repair-process-'));
  directories.push(base);
  const runtimeRoot = path.join(base, 'runtime');
  fs.mkdirSync(runtimeRoot);
  fs.writeFileSync(path.join(runtimeRoot, OPENCLAW_REPAIR_ENTRY), '');
  return {
    runtimeRoot, stateDir: path.join(base, 'state'), configPath: path.join(base, 'state', 'openclaw.json'),
    electronNodeRuntimePath: '/bundled/electron', backupDir: createOpenClawRepairBackupDirectory(base),
    env: { NODE_OPTIONS: '--require untrusted', NODE_PATH: '/external', OPENCLAW_STATE_DIR: '/other-profile', PATH: '/bundled/shims' },
  };
}
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test('Doctor uses the controlled runtime, safe flags and externally managed service policy', async () => {
  const params = fixture();
  const runner = vi.fn<StartupMigrationRunner>(async () => ({ code: 1, stdout: 'partial repair', stderr: 'remaining orphan vectors' }));
  expect(await runOpenClawDoctorRepair({ ...params, runner })).toEqual({ code: 1 });
  expect(runner).toHaveBeenCalledWith('/bundled/electron', [path.join(params.runtimeRoot, 'openclaw.mjs'), ...OPENCLAW_DOCTOR_REPAIR_ARGS], expect.objectContaining({
    env: {
      PATH: '/bundled/shims', OPENCLAW_HOME: path.dirname(params.stateDir), OPENCLAW_STATE_DIR: params.stateDir,
      OPENCLAW_CONFIG_PATH: params.configPath, ELECTRON_RUN_AS_NODE: '1', OPENCLAW_SERVICE_REPAIR_POLICY: 'external',
    },
  }));
  expect(fs.readFileSync(path.join(params.backupDir, 'doctor.log'), 'utf8')).toContain('remaining orphan vectors');
});

test('exit zero alone or an invalid phase cannot certify repair completion', async () => {
  const params = fixture();
  const runner: StartupMigrationRunner = async () => ({ code: 0, stdout: 'done', stderr: '' });
  await expect(runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Recovery, runner })).rejects.toThrow('verified completion');
  const wrongPhase: StartupMigrationRunner = async () => ({ code: 0, stdout: OPENCLAW_REPAIR_RESULT_PREFIX + JSON.stringify({
    success: true, phase: OpenClawRepairPhase.Snapshot, changes: [], backups: [],
  }), stderr: '' });
  await expect(runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Recovery, runner: wrongPhase })).rejects.toThrow('verified completion');
});

test('structured failure takes precedence over unrelated plugin warnings', async () => {
  const params = fixture();
  const runner: StartupMigrationRunner = async () => ({ code: 1, stdout: OPENCLAW_REPAIR_RESULT_PREFIX + JSON.stringify({
    success: false, phase: OpenClawRepairPhase.Recovery, changes: [], backups: [], error: 'Unsupported database schema',
  }), stderr: 'Config warnings: duplicate plugin ID' });
  await expect(runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Recovery, runner })).rejects.toThrow('Unsupported database schema');
});

test('backup directories do not collide on repeated repair requests', () => {
  const params = fixture();
  expect(createOpenClawRepairBackupDirectory(path.dirname(params.stateDir))).not.toBe(params.backupDir);
});
