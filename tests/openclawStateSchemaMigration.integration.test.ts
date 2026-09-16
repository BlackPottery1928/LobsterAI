import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runOpenClawCompatibilityRepair, runOpenClawDoctorRepair } from '../src/main/libs/openclawCompatibilityRepair';
import { OpenClawRepairPhase } from '../src/shared/openclawEngine/repair';
import {
  OPENCLAW_STARTUP_COMPATIBILITY_ENTRY,
  OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX,
  OpenClawBundledDiscoveryMode,
  OpenClawStartupCompatibilityMode,
} from '../src/shared/openclawEngine/startupCompatibility';
import { OpenClawStartupMigrationStatus } from '../src/shared/openclawEngine/startupMigration';

const runtimeRoot = process.env.OPENCLAW_STARTUP_COMPAT_RUNTIME;
const execFileAsync = promisify(execFile);
let directory: string;
let stateDir: string;
let configPath: string;
let databasePath: string;
const handles: DatabaseSync[] = [];

describe.skipIf(!runtimeRoot)('packaged shared-state preparation', () => {
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-state-upgrade-'));
    stateDir = path.join(directory, '旧版本 state');
    configPath = path.join(stateDir, 'openclaw.json');
    databasePath = path.join(stateDir, 'state', 'openclaw.sqlite');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { mode: 'local' },
      agents: { ownership: 'explicit', entries: { main: {} }, defaults: {
        workspace: path.join(stateDir, 'workspace-main'), systemAgent: { agentId: 'main' }, authInheritance: { agentId: 'main' },
      } },
      plugins: { enabled: false, bundledDiscovery: OpenClawBundledDiscoveryMode.Compat },
      logging: { file: path.join(directory, 'openclaw.log') },
    }));
  });

  afterEach(() => {
    for (const db of handles.splice(0)) if (db.isOpen) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function connect(file = databasePath) {
    const db = new DatabaseSync(file);
    handles.push(db);
    return db;
  }

  function seedLegacyState(wal = false) {
    const db = connect();
    if (wal) db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
    db.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE schema_meta (
        meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL, schema_version INTEGER NOT NULL,
        agent_id TEXT, app_version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO schema_meta VALUES ('primary', 'global', 1, NULL, NULL, 10, 10);
      CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL UNIQUE, source_sequence INTEGER NOT NULL, occurred_at INTEGER NOT NULL,
        kind TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, error_code TEXT,
        actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        session_key TEXT, session_id TEXT, run_id TEXT NOT NULL, tool_call_id TEXT, tool_name TEXT
      );
      INSERT INTO audit_events VALUES (42, 'retained-event', 'source:42', 42, 100,
        'agent_run', 'agent.run.started', 'started', NULL, 'agent', 'main', 'main',
        NULL, NULL, 'retained-run', NULL, NULL);
    `);
    return db;
  }

  function environment(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      OPENCLAW_HOME: directory, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_SERVICE_REPAIR_POLICY: 'external', ELECTRON_RUN_AS_NODE: '1',
      XDG_CACHE_HOME: path.join(directory, 'cache'), TMPDIR: directory, TEMP: directory, TMP: directory,
    };
  }

  async function prepare() {
    let output: { stdout: string; stderr: string };
    try {
      output = await execFileAsync(process.execPath, [path.join(runtimeRoot!, OPENCLAW_STARTUP_COMPATIBILITY_ENTRY),
        OpenClawStartupCompatibilityMode.PrepareStartup], { env: environment(), cwd: runtimeRoot, timeout: 30_000 });
    } catch (error) {
      const failure = error as Error & { code: number; stdout: string; stderr: string };
      if (failure.code !== 1) throw error;
      output = failure;
    }
    const line = output.stdout.split(/\r?\n/).findLast(value => value.startsWith(OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX));
    expect(line, output.stderr).toBeDefined();
    return JSON.parse(line!.slice(OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX.length)) as {
      status: OpenClawStartupMigrationStatus; backups: string[]; changes: string[]; error?: string;
    };
  }

  function events(db: DatabaseSync) {
    return db.prepare('SELECT sequence,event_id,run_id FROM audit_events').all();
  }

  test.each(Object.values(OpenClawBundledDiscoveryMode))('migrates v1 plus %s discovery with a WAL-complete backup', async mode => {
    const originalConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    originalConfig.plugins.bundledDiscovery = mode;
    fs.writeFileSync(configPath, JSON.stringify(originalConfig));
    const before = fs.readFileSync(configPath, 'utf8');
    const db = seedLegacyState(true);
    const records = events(db);
    expect(fs.statSync(databasePath + '-wal').size).toBeGreaterThan(0);
    const result = await prepare();
    expect(result, result.error).toMatchObject({ status: OpenClawStartupMigrationStatus.Migrated });
    const saved = connect(result.backups.find(file => file.endsWith('.sqlite'))!);
    expect(saved.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
    expect(events(saved)).toEqual(records);
    expect(fs.readFileSync(result.backups.find(file => file.endsWith('openclaw.json'))!, 'utf8')).toBe(before);
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(15);
    expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    expect(events(db)).toEqual(records);
    expect(db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'plugins.bundledDiscovery'").get()?.value_json)
      .toBe(JSON.stringify(mode));
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).plugins.bundledDiscovery).toBeUndefined();
    expect(await prepare()).toMatchObject({ status: OpenClawStartupMigrationStatus.Skipped, backups: [], changes: [] });
  });

  test('migrates old SQLite even when no legacy config field remains', async () => {
    seedLegacyState().close();
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    delete config.plugins.bundledDiscovery;
    const before = JSON.stringify(config);
    fs.writeFileSync(configPath, before);
    expect(await prepare()).toMatchObject({ status: OpenClawStartupMigrationStatus.Migrated });
    expect(connect().prepare('PRAGMA user_version').get()?.user_version).toBe(15);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });

  test.each(['missing', 'malformed'])('preserves %s config for Doctor after database migration', async kind => {
    seedLegacyState().close();
    if (kind === 'missing') fs.unlinkSync(configPath);
    else fs.writeFileSync(configPath, '{invalid');
    expect(await prepare()).toMatchObject({ status: OpenClawStartupMigrationStatus.Migrated });
    if (kind === 'missing') expect(fs.existsSync(configPath)).toBe(false);
    else expect(fs.readFileSync(configPath, 'utf8')).toBe('{invalid');
  });

  test('does not change the database or config when backup creation fails', async () => {
    seedLegacyState().close();
    const before = fs.readFileSync(databasePath);
    const configBefore = fs.readFileSync(configPath);
    fs.writeFileSync(path.join(stateDir, 'startup-recovery-backups'), 'blocked');
    expect(await prepare()).toMatchObject({ status: OpenClawStartupMigrationStatus.Failed, backups: [] });
    expect(fs.readFileSync(databasePath)).toEqual(before);
    expect(fs.readFileSync(configPath)).toEqual(configBefore);
  });

  test.each(['newer', 'metadata', 'corrupt'])('refuses %s SQLite without modifying the source', async kind => {
    const db = seedLegacyState();
    if (kind === 'newer') db.exec('PRAGMA user_version = 16');
    if (kind === 'metadata') db.exec('UPDATE schema_meta SET schema_version = 2');
    db.close();
    if (kind === 'corrupt') fs.writeFileSync(databasePath, 'invalid database fixture');
    const before = fs.readFileSync(databasePath);
    const configBefore = fs.readFileSync(configPath);
    expect(await prepare()).toMatchObject({ status: OpenClawStartupMigrationStatus.Failed, backups: [] });
    expect(fs.readFileSync(databasePath)).toEqual(before);
    expect(fs.readFileSync(configPath)).toEqual(configBefore);
  });

  test('refuses an unknown audit layout and retains its records and config', async () => {
    const db = seedLegacyState();
    db.exec('ALTER TABLE audit_events ADD COLUMN unexpected TEXT');
    const before = events(db);
    db.close();
    const configBefore = fs.readFileSync(configPath);
    const result = await prepare();
    expect(result.status).toBe(OpenClawStartupMigrationStatus.Failed);
    expect(result.backups.some(file => file.endsWith('.sqlite'))).toBe(true);
    const unchanged = connect();
    expect(unchanged.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
    expect(events(unchanged)).toEqual(before);
    expect(fs.readFileSync(configPath)).toEqual(configBefore);
  });

  test('one-click repair reaches Doctor with v1 and legacy discovery together', async () => {
    seedLegacyState().close();
    const backupDir = path.join(directory, 'manual-backup');
    fs.mkdirSync(backupDir);
    const params = { runtimeRoot: runtimeRoot!, stateDir, configPath, backupDir,
      electronNodeRuntimePath: process.execPath, env: environment() };
    await runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Snapshot });
    await runOpenClawDoctorRepair(params);
    expect(fs.existsSync(path.join(backupDir, 'doctor-result.json'))).toBe(true);
    expect(connect().prepare('PRAGMA user_version').get()?.user_version).toBe(15);
    expect(events(connect())).toEqual([{ sequence: 42, event_id: 'retained-event', run_id: 'retained-run' }]);
    expect(connect(path.join(backupDir, 'original', 'state', 'openclaw.sqlite'))
      .prepare('PRAGMA user_version').get()?.user_version).toBe(1);
  }, 180_000);
});
