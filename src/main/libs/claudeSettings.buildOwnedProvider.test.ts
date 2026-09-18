import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/lobsterai-test') },
  net: { fetch: vi.fn() },
}));

import { ProviderName } from '../../shared/providers';
import {
  resolveAllEnabledProviderConfigs,
  resolveAllProviderApiKeys,
  resolveRawApiConfig,
  setStoreGetter,
} from './claudeSettings';

// [INTRA-ONLY] This build owns DeepSeek's provider config — the stored
// `app_config` row must never win, or a stale row sends the conversation to a
// dead route.
const DEEPSEEK_INTRANET_BASE_URL = 'http://10.133.4.205:5050/desktop-agent-provider';
const DEEPSEEK_BUILD_API_KEY = 'sk-7s9KpR2GzN5dQv8Bc4jXtF6mYh3aLw1U-TEST';

const setStoredConfig = (
  providers: Record<string, unknown>,
  model?: { defaultModel?: string; defaultModelProvider?: string },
): void => {
  const appConfig = { providers, ...(model ? { model } : {}) };
  setStoreGetter(
    () => ({ get: (key: string) => (key === 'app_config' ? appConfig : null) }) as never,
  );
};

const staleDeepSeek = {
  enabled: true,
  apiKey: 'sk-stale',
  baseUrl: 'https://api.deepseek.com',
  apiFormat: 'anthropic',
  models: [{ id: 'deepseek-reasoner', name: 'Stale', supportsImage: false }],
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  setStoreGetter(() => null);
});

describe('build-owned DeepSeek provider config ([INTRA-ONLY])', () => {
  test('the gateway provider list carries the build route, key and model', () => {
    setStoredConfig({ [ProviderName.DeepSeek]: staleDeepSeek });

    const [deepseek] = resolveAllEnabledProviderConfigs();

    expect(deepseek.providerName).toBe(ProviderName.DeepSeek);
    expect(deepseek.baseURL).toBe(DEEPSEEK_INTRANET_BASE_URL);
    expect(deepseek.apiKey).toBe(DEEPSEEK_BUILD_API_KEY);
    expect(deepseek.apiType).toBe('openai');
    expect(deepseek.models.map(model => model.id)).toEqual(['DeepSeek-V4-Flash']);
  });

  test('a blanked stored key no longer drops the provider from the gateway config', () => {
    setStoredConfig({ [ProviderName.DeepSeek]: { ...staleDeepSeek, apiKey: '' } });

    expect(resolveAllEnabledProviderConfigs().map(entry => entry.providerName))
      .toEqual([ProviderName.DeepSeek]);
  });

  test('the gateway env key is the build key', () => {
    setStoredConfig({ [ProviderName.DeepSeek]: staleDeepSeek });

    expect(resolveAllProviderApiKeys().DEEPSEEK).toBe(DEEPSEEK_BUILD_API_KEY);
  });

  test('the resolved chat config points at the build route', () => {
    setStoredConfig(
      { [ProviderName.DeepSeek]: staleDeepSeek },
      { defaultModel: 'DeepSeek-V4-Flash', defaultModelProvider: ProviderName.DeepSeek },
    );

    const { config } = resolveRawApiConfig();

    expect(config).toMatchObject({
      baseURL: DEEPSEEK_INTRANET_BASE_URL,
      apiKey: DEEPSEEK_BUILD_API_KEY,
      model: 'DeepSeek-V4-Flash',
      apiType: 'openai',
    });
  });

  test('other providers keep their stored config', () => {
    setStoredConfig({
      [ProviderName.Moonshot]: {
        enabled: true,
        apiKey: 'sk-mine',
        baseUrl: 'https://api.moonshot.cn/v1',
        apiFormat: 'openai',
        models: [{ id: 'kimi-k2.5', name: 'Kimi K2.5' }],
      },
    });

    const [moonshot] = resolveAllEnabledProviderConfigs();

    expect(moonshot.baseURL).toBe('https://api.moonshot.cn/v1');
    expect(moonshot.apiKey).toBe('sk-mine');
  });
});
