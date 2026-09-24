import { describe,expect, test } from 'vitest';

import {
  ApiFormat,
  applyDefinitionOwnedProviderConfig,
  applyDefinitionOwnedProviders,
  isDefinitionOwnedProvider,
  OpenClawProviderId,
  ProviderName,
  ProviderRegistry,
} from './constants';

// [INTRA-ONLY] This build points DeepSeek at a fixed intranet proxy serving a
// fixed catalogue. Single literal home for the assertions below.
const DEEPSEEK_INTRANET_BASE_URL = 'http://higressai.app.cz:5555/desktop-agent-provider/v1';

describe('ProviderName constants', () => {
  test('contains expected provider keys', () => {
    expect(ProviderName.OpenAI).toBe('openai');
    expect(ProviderName.DeepSeek).toBe('deepseek');
    expect(ProviderName.Custom).toBe('custom');
    expect(ProviderName.LobsteraiServer).toBe('lobsterai-server');
  });
});

describe('ProviderRegistry', () => {
  test('providerIds returns 18 providers (no custom)', () => {
    const ids = ProviderRegistry.providerIds;
    expect(ids.length).toBe(18);
    expect(ids).not.toContain(ProviderName.Custom);
    expect(ids).not.toContain(ProviderName.LobsteraiServer);
  });

  test('get returns definition for known provider', () => {
    const def = ProviderRegistry.get(ProviderName.OpenAI);
    expect(def).toBeDefined();
    expect(def!.id).toBe(ProviderName.OpenAI);
    expect(def!.defaultApiFormat).toBe(ApiFormat.OpenAI);
    expect(def!.region).toBe('global');
  });

  test('deepseek and xiaomi default to OpenAI-compatible endpoints', () => {
    const deepseek = ProviderRegistry.get(ProviderName.DeepSeek);
    expect(deepseek?.defaultApiFormat).toBe(ApiFormat.OpenAI);
    expect(deepseek?.defaultBaseUrl).toBe(DEEPSEEK_INTRANET_BASE_URL);

    const xiaomi = ProviderRegistry.get(ProviderName.Xiaomi);
    expect(xiaomi?.defaultApiFormat).toBe(ApiFormat.OpenAI);
    expect(xiaomi?.defaultBaseUrl).toBe('https://api.xiaomimimo.com/v1/chat/completions');
  });

  test('moonshot defaults to Kimi K3 with the controlled model capabilities', () => {
    expect(ProviderRegistry.get(ProviderName.Moonshot)?.defaultModels[0]).toEqual({
      id: 'kimi-k3',
      name: 'Kimi K3',
      supportsImage: true,
      supportsVideo: true,
      supportsThinking: true,
      contextWindow: 1_048_576,
      maxTokens: 1_048_576,
    });
  });

  test('xiaomi default models are limited to MiMo V2.5 models with 1M context', () => {
    const xiaomi = ProviderRegistry.get(ProviderName.Xiaomi);
    expect(xiaomi?.defaultModels).toEqual([
      { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', supportsImage: false, supportsThinking: true, contextWindow: 1_000_000 },
      { id: 'mimo-v2.5', name: 'MiMo V2.5', supportsImage: true, supportsThinking: true, contextWindow: 1_000_000 },
    ]);
  });

  test('minimax defaults to MiniMax M3 with 1M context first', () => {
    const minimax = ProviderRegistry.get(ProviderName.Minimax);
    expect(minimax?.defaultModels[0]).toMatchObject({
      id: 'MiniMax-M3',
      name: 'MiniMax M3',
      contextWindow: 1_000_000,
    });
  });

  test('deepseek exposes the single proxy-served model with 1M context', () => {
    const deepseek = ProviderRegistry.get(ProviderName.DeepSeek);
    expect(deepseek?.defaultModels).toEqual([
      { id: 'DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash', supportsImage: false, supportsThinking: true, contextWindow: 1_000_000 },
    ]);
  });

  test('OpenAI defaults include the GPT-5.6 family with official context windows', () => {
    const openai = ProviderRegistry.get(ProviderName.OpenAI);
    expect(openai?.defaultModels.slice(0, 3)).toEqual([
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', supportsImage: true, supportsThinking: true, contextWindow: 1_050_000 },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', supportsImage: true, supportsThinking: true, contextWindow: 1_050_000 },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', supportsImage: true, supportsThinking: true, contextWindow: 1_050_000 },
    ]);
  });

  test('xAI defaults include Grok 4.5 with its official context window', () => {
    expect(ProviderRegistry.get(ProviderName.Xai)?.defaultModels[0]).toEqual({
      id: 'grok-4.5',
      name: 'Grok 4.5',
      supportsImage: true,
      supportsThinking: true,
      contextWindow: 500_000,
    });
  });

  test('get returns undefined for unknown provider', () => {
    expect(ProviderRegistry.get('nonexistent')).toBeUndefined();
    expect(ProviderRegistry.get(ProviderName.Custom)).toBeUndefined();
  });

  test('resolveModelSupportsImage repairs known provider model metadata', () => {
    expect(ProviderRegistry.resolveModelSupportsImage(ProviderName.Qwen, 'qwen3.6-plus', false)).toBe(true);
    expect(ProviderRegistry.resolveModelSupportsImage(ProviderName.Zhipu, 'glm-5.1', true)).toBe(false);
  });

  test('resolveModelSupportsImage upgrades custom providers for globally known vision models', () => {
    expect(ProviderRegistry.resolveModelSupportsImage('custom_0', 'qwen3.6-plus', false)).toBe(true);
    expect(ProviderRegistry.resolveModelSupportsImage('custom_0', 'unknown-model', false)).toBe(false);
    expect(ProviderRegistry.resolveModelSupportsImage('custom_0', 'unknown-model', true)).toBe(true);
  });

  test('qwen maps to the API-key provider instead of the OAuth alias', () => {
    expect(ProviderRegistry.getOpenClawProviderId(ProviderName.Qwen)).toBe(OpenClawProviderId.Qwen);
    expect(OpenClawProviderId.Qwen).toBe('qwen');
  });

  test('minimax exposes a distinct OpenClaw portal provider id for OAuth mode', () => {
    expect(ProviderRegistry.getOpenClawProviderId(ProviderName.Minimax)).toBe(OpenClawProviderId.Minimax);
    expect(OpenClawProviderId.Minimax).toBe('minimax');
    expect(OpenClawProviderId.MinimaxPortal).toBe('minimax-portal');
  });

  test('resolveModelSupportsThinking preserves known reasoning model metadata', () => {
    const knownReasoningModels: Array<[string, string]> = [
      [ProviderName.DeepSeek, 'DeepSeek-V4-Flash'],
      [ProviderName.Moonshot, 'kimi-k2.6'],
      [ProviderName.Moonshot, 'kimi-k2.5'],
      [ProviderName.Moonshot, 'kimi-k3'],
      [ProviderName.Moonshot, 'kimi-for-coding'],
      [ProviderName.Zhipu, 'glm-5.1'],
      [ProviderName.Zhipu, 'glm-5'],
      [ProviderName.Zhipu, 'glm-4.7'],
      [ProviderName.Minimax, 'MiniMax-M3'],
      [ProviderName.Volcengine, 'doubao-seed-2-0-pro-260215'],
      [ProviderName.Volcengine, 'ark-code-latest'],
      [ProviderName.Volcengine, 'doubao-seed-2-0-lite-260215'],
      [ProviderName.Volcengine, 'doubao-seed-2-0-mini-260215'],
      [ProviderName.Youdaozhiyun, 'deepseek-reasoner'],
      [ProviderName.Qianfan, 'glm-5.1'],
      [ProviderName.Qianfan, 'deepseek-v4-flash'],
      [ProviderName.Xiaomi, 'mimo-v2.5-pro'],
      [ProviderName.Xiaomi, 'mimo-v2.5'],
      [ProviderName.OpenAI, 'gpt-5.4'],
      [ProviderName.OpenAI, 'gpt-5.5'],
      [ProviderName.OpenAI, 'gpt-5.6-sol'],
      [ProviderName.OpenAI, 'gpt-5.6-terra'],
      [ProviderName.OpenAI, 'gpt-5.6-luna'],
      [ProviderName.Xai, 'grok-4.5'],
      [ProviderName.Gemini, 'gemini-3.1-pro-preview'],
      [ProviderName.Anthropic, 'claude-opus-4-7'],
      [ProviderName.OpenRouter, 'openai/gpt-5.5'],
    ];
    for (const [providerName, modelId] of knownReasoningModels) {
      expect(ProviderRegistry.resolveModelSupportsThinking(providerName, modelId, false)).toBe(true);
    }

    expect(ProviderRegistry.resolveModelSupportsThinking(ProviderName.Qwen, 'qwen3.6-plus', false)).toBe(false);
    expect(ProviderRegistry.resolveModelSupportsThinking(ProviderName.Qwen, 'qwen3.5-plus', false)).toBe(false);
    expect(ProviderRegistry.resolveModelSupportsThinking(ProviderName.Minimax, 'MiniMax-M2.7', false)).toBe(false);
    expect(ProviderRegistry.resolveModelSupportsThinking(ProviderName.Minimax, 'MiniMax-M2.5', false)).toBe(false);
    expect(ProviderRegistry.resolveModelSupportsThinking('custom_0', 'glm-5.1', false)).toBe(false);
    expect(ProviderRegistry.resolveModelSupportsThinking('lobsterai-server', 'glm-5.1-YoudaoInner', false)).toBe(false);
    expect(ProviderRegistry.resolveModelSupportsThinking('lobsterai-server', 'glm-5.1-YoudaoInner', true)).toBe(true);
    expect(ProviderRegistry.resolveModelSupportsThinking('custom_0', 'unknown-model', true)).toBe(true);
    expect(ProviderRegistry.resolveModelSupportsThinking('custom_0', 'unknown-model', false)).toBe(false);
  });

  test('resolveModelContextWindow fills known defaults without overriding user values', () => {
    expect(ProviderRegistry.resolveModelContextWindow(ProviderName.DeepSeek, 'DeepSeek-V4-Flash')).toBe(1_000_000);
    expect(ProviderRegistry.resolveModelContextWindow('custom_0', 'deepseek-v4-flash')).toBe(1_000_000);
    expect(ProviderRegistry.resolveModelContextWindow(ProviderName.DeepSeek, 'DeepSeek-V4-Flash', 200_000)).toBe(200_000);
    expect(ProviderRegistry.resolveModelContextWindow(ProviderName.OpenAI, 'gpt-5.6-sol')).toBe(1_050_000);
    expect(ProviderRegistry.resolveModelContextWindow(ProviderName.Xai, 'grok-4.5')).toBe(500_000);
  });

  test('resolves Kimi K3 video and output token metadata', () => {
    expect(ProviderRegistry.resolveModelSupportsVideo(ProviderName.Moonshot, 'kimi-k3')).toBe(true);
    expect(ProviderRegistry.resolveModelSupportsVideo('custom_0', 'kimi-k3')).toBe(true);
    expect(ProviderRegistry.resolveModelSupportsVideo('custom_0', 'unknown-model')).toBe(false);
    expect(ProviderRegistry.resolveModelMaxTokens(ProviderName.Moonshot, 'kimi-k3')).toBe(1_048_576);
    expect(ProviderRegistry.resolveModelMaxTokens(ProviderName.Moonshot, 'kimi-k3', 4_096)).toBe(4_096);
  });

  test('supportsCodingPlan is true for moonshot, qwen, zhipu, volcengine, qianfan, xiaomi', () => {
    expect(ProviderRegistry.supportsCodingPlan(ProviderName.Moonshot)).toBe(true);
    expect(ProviderRegistry.supportsCodingPlan(ProviderName.Qwen)).toBe(true);
    expect(ProviderRegistry.supportsCodingPlan(ProviderName.Zhipu)).toBe(true);
    expect(ProviderRegistry.supportsCodingPlan(ProviderName.Volcengine)).toBe(true);
    expect(ProviderRegistry.supportsCodingPlan(ProviderName.Qianfan)).toBe(true);
    expect(ProviderRegistry.supportsCodingPlan(ProviderName.Xiaomi)).toBe(true);
  });

  test('supportsCodingPlan is false for others', () => {
    expect(ProviderRegistry.supportsCodingPlan(ProviderName.OpenAI)).toBe(false);
    expect(ProviderRegistry.supportsCodingPlan(ProviderName.DeepSeek)).toBe(false);
    expect(ProviderRegistry.supportsCodingPlan('unknown')).toBe(false);
  });

  test('idsByRegion china returns 12 providers', () => {
    const china = ProviderRegistry.idsByRegion('china');
    expect(china.length).toBe(12);
    expect(china).toContain(ProviderName.DeepSeek);
    expect(china).toContain(ProviderName.Qianfan);
    expect(china).toContain(ProviderName.Ollama);
    expect(china).not.toContain(ProviderName.OpenAI);
  });

  test('idsByRegion global returns 6 providers', () => {
    const global = ProviderRegistry.idsByRegion('global');
    expect(global.length).toBe(6);
    expect(global).toContain(ProviderName.OpenAI);
    expect(global).toContain(ProviderName.Gemini);
    expect(global).toContain(ProviderName.Xai);
    expect(global).toContain(ProviderName.Anthropic);
    expect(global).toContain(ProviderName.OpenRouter);
    expect(global).toContain(ProviderName.Copilot);
  });

  test('xai is en-only and ordered right after gemini', () => {
    expect(ProviderRegistry.idsByRegion('china')).not.toContain(ProviderName.Xai);
    const en = ProviderRegistry.idsForEnLocale();
    expect(en[en.indexOf(ProviderName.Gemini) + 1]).toBe(ProviderName.Xai);
  });

  test('idsForEnLocale starts with EN_PRIORITY providers in order', () => {
    const en = ProviderRegistry.idsForEnLocale();
    expect(en[0]).toBe(ProviderName.OpenAI);
    expect(en[1]).toBe(ProviderName.Anthropic);
    expect(en[2]).toBe(ProviderName.Gemini);
  });

  test('idsForEnLocale puts lm-studio at end', () => {
    const en = ProviderRegistry.idsForEnLocale();
    expect(en[en.length - 1]).toBe(ProviderName.LmStudio);
    expect(en).not.toContain(ProviderName.Custom);
  });

  test('idsForEnLocale has no duplicates', () => {
    const en = ProviderRegistry.idsForEnLocale();
    expect(new Set(en).size).toBe(en.length);
  });

  test('every definition has non-empty defaultBaseUrl', () => {
    for (const id of ProviderRegistry.providerIds) {
      const def = ProviderRegistry.get(id)!;
      expect(def.defaultBaseUrl.length).toBeGreaterThan(0);
    }
  });

  test('every definition has valid ApiFormat', () => {
    const validFormats = new Set([ApiFormat.OpenAI, ApiFormat.Anthropic, ApiFormat.Gemini]);
    for (const id of ProviderRegistry.providerIds) {
      const def = ProviderRegistry.get(id)!;
      expect(validFormats.has(def.defaultApiFormat)).toBe(true);
    }
  });

  describe('getCodingPlanUrl', () => {
    test('returns anthropic endpoint for coding-plan-supported providers', () => {
      expect(ProviderRegistry.getCodingPlanUrl(ProviderName.Moonshot, 'anthropic')).toBe('https://api.kimi.com/coding');
      expect(ProviderRegistry.getCodingPlanUrl(ProviderName.Qwen, 'anthropic')).toBe('https://coding.dashscope.aliyuncs.com/apps/anthropic');
      expect(ProviderRegistry.getCodingPlanUrl(ProviderName.Zhipu, 'anthropic')).toBe('https://open.bigmodel.cn/api/anthropic');
      expect(ProviderRegistry.getCodingPlanUrl(ProviderName.Volcengine, 'anthropic')).toBe('https://ark.cn-beijing.volces.com/api/coding');
      expect(ProviderRegistry.getCodingPlanUrl(ProviderName.Xiaomi, 'anthropic')).toBe('https://token-plan-cn.xiaomimimo.com/anthropic');
    });

    test('returns openai endpoint for coding-plan-supported providers', () => {
      expect(ProviderRegistry.getCodingPlanUrl(ProviderName.Moonshot, 'openai')).toBe('https://api.kimi.com/coding/v1');
      expect(ProviderRegistry.getCodingPlanUrl(ProviderName.Qwen, 'openai')).toBe('https://coding.dashscope.aliyuncs.com/v1');
      expect(ProviderRegistry.getCodingPlanUrl(ProviderName.Zhipu, 'openai')).toBe('https://open.bigmodel.cn/api/coding/paas/v4');
      expect(ProviderRegistry.getCodingPlanUrl(ProviderName.Volcengine, 'openai')).toBe('https://ark.cn-beijing.volces.com/api/coding/v3');
      expect(ProviderRegistry.getCodingPlanUrl(ProviderName.Qianfan, 'openai')).toBe('https://qianfan.baidubce.com/v2/coding/chat/completions');
      expect(ProviderRegistry.getCodingPlanUrl(ProviderName.Xiaomi, 'openai')).toBe('https://token-plan-cn.xiaomimimo.com/v1');
    });

    test('returns undefined for providers that do not support codingPlan', () => {
      expect(ProviderRegistry.getCodingPlanUrl(ProviderName.OpenAI, 'openai')).toBeUndefined();
      expect(ProviderRegistry.getCodingPlanUrl(ProviderName.DeepSeek, 'anthropic')).toBeUndefined();
      expect(ProviderRegistry.getCodingPlanUrl('unknown', 'anthropic')).toBeUndefined();
    });
  });

  describe('getSwitchableBaseUrl', () => {
    test('returns anthropic url for providers with switchableBaseUrls', () => {
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.DeepSeek, 'anthropic')).toBe(DEEPSEEK_INTRANET_BASE_URL);
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Moonshot, 'anthropic')).toBe('https://api.moonshot.cn/anthropic');
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Zhipu, 'anthropic')).toBe('https://open.bigmodel.cn/api/anthropic');
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Minimax, 'anthropic')).toBe('https://api.minimaxi.com/anthropic');
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Qwen, 'anthropic')).toBe('https://dashscope.aliyuncs.com/apps/anthropic');
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Ollama, 'anthropic')).toBe('http://localhost:11434');
    });

    test('returns openai url for providers with switchableBaseUrls', () => {
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.DeepSeek, 'openai')).toBe(DEEPSEEK_INTRANET_BASE_URL);
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Moonshot, 'openai')).toBe('https://api.moonshot.cn/v1');
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Zhipu, 'openai')).toBe('https://open.bigmodel.cn/api/paas/v4');
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Minimax, 'openai')).toBe('https://api.minimaxi.com/v1');
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Qwen, 'openai')).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Ollama, 'openai')).toBe('http://localhost:11434/v1');
    });

    test('returns undefined for providers without switchableBaseUrls', () => {
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.OpenAI, 'openai')).toBeUndefined();
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Anthropic, 'anthropic')).toBeUndefined();
      expect(ProviderRegistry.getSwitchableBaseUrl(ProviderName.Gemini, 'openai')).toBeUndefined();
      expect(ProviderRegistry.getSwitchableBaseUrl('unknown', 'anthropic')).toBeUndefined();
    });
  });
});

describe('definition-owned providers', () => {
  test('only DeepSeek is owned by the build config', () => {
    expect(isDefinitionOwnedProvider(ProviderName.DeepSeek)).toBe(true);
    for (const id of ProviderRegistry.providerIds) {
      if (id === ProviderName.DeepSeek) continue;
      expect(isDefinitionOwnedProvider(id)).toBe(false);
    }
    expect(isDefinitionOwnedProvider('custom_0')).toBe(false);
  });

  test('forces the connection fields and leaves the rest alone', () => {
    const stored = {
      enabled: false,
      apiKey: 'sk-stale',
      baseUrl: 'https://api.deepseek.com',
      apiFormat: ApiFormat.Anthropic,
      codingPlanEnabled: true,
      displayName: 'My DeepSeek',
      models: [{ id: 'deepseek-reasoner', name: 'Stale', supportsImage: false }],
    };

    const applied = applyDefinitionOwnedProviderConfig(ProviderName.DeepSeek, stored);

    expect(applied.baseUrl).toBe(DEEPSEEK_INTRANET_BASE_URL);
    expect(applied.apiKey).toBe('sk-7s9KpR2GzN5dQv8Bc4jXtF6mYh3aLw1U-TEST');
    expect(applied.apiFormat).toBe(ApiFormat.OpenAI);
    expect(applied.models?.map(model => model.id)).toEqual(['DeepSeek-V4-Flash']);
    // Untouched: the user's enable/disable and labelling intent survives.
    expect(applied.enabled).toBe(false);
    expect(applied.codingPlanEnabled).toBe(true);
    expect(applied.displayName).toBe('My DeepSeek');
  });

  test('returns a fresh model array that cannot corrupt the registry', () => {
    const applied = applyDefinitionOwnedProviderConfig(ProviderName.DeepSeek, {
      models: [{ id: 'stale', name: 'Stale', supportsImage: false }],
    });

    applied.models[0].name = 'mutated';

    expect(ProviderRegistry.get(ProviderName.DeepSeek)?.defaultModels[0].name).toBe('DeepSeek V4 Flash');
  });

  test('passes other providers through untouched', () => {
    const stored = { apiKey: 'sk-mine', baseUrl: 'https://api.moonshot.cn/v1', enabled: true };
    expect(applyDefinitionOwnedProviderConfig(ProviderName.Moonshot, stored)).toBe(stored);
  });

  test('map-level overlay never injects a provider the stored config lacks', () => {
    const providers = {
      [ProviderName.Moonshot]: { apiKey: 'sk-mine', baseUrl: 'https://api.moonshot.cn/v1' },
      [ProviderName.DeepSeek]: { apiKey: 'sk-stale', baseUrl: 'https://api.deepseek.com' },
    };

    const applied = applyDefinitionOwnedProviders(providers)!;

    expect(Object.keys(applied)).toEqual([ProviderName.Moonshot, ProviderName.DeepSeek]);
    expect(applied[ProviderName.Moonshot]).toBe(providers[ProviderName.Moonshot]);
    expect(applied[ProviderName.DeepSeek].baseUrl).toBe(DEEPSEEK_INTRANET_BASE_URL);
    expect(applyDefinitionOwnedProviders(undefined)).toBeUndefined();
  });
});
