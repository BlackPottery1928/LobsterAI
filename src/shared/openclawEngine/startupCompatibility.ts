export const OPENCLAW_STARTUP_COMPATIBILITY_ENTRY = 'openclaw-startup-compat.mjs';
export const OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX = 'LOBSTERAI_STARTUP_COMPATIBILITY_RESULT ';
export const OPENCLAW_STARTUP_COMPATIBILITY_VERSION = '2026.8.1';
export const OPENCLAW_LEGACY_DISCOVERY_KEY = 'bundledDiscovery';

export const OpenClawStartupCompatibilityMode = {
  MigrateConfig: 'migrate-config',
  RepairBindings: 'repair-bindings',
} as const;
export type OpenClawStartupCompatibilityMode =
  typeof OpenClawStartupCompatibilityMode[keyof typeof OpenClawStartupCompatibilityMode];

export const OpenClawBundledDiscoveryMode = {
  Compat: 'compat',
  Allowlist: 'allowlist',
} as const;
