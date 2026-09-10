import {
  type AuthSessionChangedEvent,
  AuthSessionChangeReason,
  AuthSessionStatus,
} from '@shared/auth/constants';
import { LobsterAIRequestCapability, ProviderName } from '@shared/providers';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  EnterpriseMemberRole,
  EnterpriseQuotaReason,
} from '../../shared/enterpriseAccount/constants';
import type { EnterpriseAccountContext } from '../../shared/enterpriseAccount/types';
import {
  closeIntranetCredentialLogin,
  getIntranetCredentialLoginState,
  submitIntranetCredentialLogin,
} from '../components/auth/intranetCredentialLoginBridge';
import { setEnterpriseAccountContext } from '../features/enterpriseAccount/enterpriseAccountSlice';
import { store } from '../store';
import { setLoggedIn, setLoggedOut } from '../store/slices/authSlice';
import { clearServerModels } from '../store/slices/modelSlice';
import {
  authService,
  isAuthAccountRequestCurrent,
  mapAvailableServerModelsToModels,
  mapPricingCatalogTextModelsToServerModels,
  mapPricingCatalogToPublicServerModels,
} from './auth';
import { i18nService } from './i18n';

afterEach(() => {
  authService.destroy();
  store.dispatch(setLoggedOut());
  store.dispatch(clearServerModels());
  store.dispatch(setEnterpriseAccountContext(null));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  i18nService.setLanguage('zh', { persist: false });
});

describe('pricing catalog model mapping', () => {
  test('maps public text models to locked server models', () => {
    const [model] = mapPricingCatalogTextModelsToServerModels([
      {
        modelId: 'qwen3.7-plus',
        modelName: 'Qwen3.7-Plus',
        provider: 'LobsterAI',
        providerLabel: 'LobsterAI Plan',
        description: 'Strong multimodal model',
        supportsImage: true,
        supportsThinking: true,
        thinkingConfig: {
          options: [
            { level: 'off', openclawLevel: 'off' },
            { level: 'high', openclawLevel: 'high' },
            { level: 'max', openclawLevel: 'xhigh' },
          ],
          defaultLevel: 'high',
        },
        contextWindow: 1_000_000,
        costMultiplier: 1.6,
        moreModel: true,
      },
    ]);

    expect(model).toMatchObject({
      id: 'qwen3.7-plus',
      name: 'Qwen3.7-Plus',
      provider: 'LobsterAI Plan',
      providerKey: ProviderName.LobsteraiServer,
      isServerModel: true,
      accessible: false,
      description: 'Strong multimodal model',
      supportsImage: true,
      supportsThinking: true,
      thinkingConfig: {
        options: [
          { level: 'off', openclawLevel: 'off' },
          { level: 'high', openclawLevel: 'high' },
          { level: 'max', openclawLevel: 'xhigh' },
        ],
        defaultLevel: 'high',
      },
      contextWindow: 1_000_000,
      costMultiplier: 1.6,
      moreModel: true,
    });
  });

  test('maps only textModels from the pricing catalog', () => {
    const models = mapPricingCatalogToPublicServerModels({
      textModels: [
        {
          modelId: 'MiniMax-M3',
          modelName: 'MiniMax M3',
        },
      ],
      imageModels: [
        {
          modelId: 'image-01',
          modelName: 'MiniMax-Image-01',
        },
      ],
      videoModels: [
        {
          modelId: 'happyhorse-1.0-i2v',
          modelName: 'HappyHorse',
        },
      ],
    });

    expect(models.map(model => model.id)).toEqual(['MiniMax-M3']);
    expect(models[0].accessible).toBe(false);
  });
});

describe('authenticated server model mapping', () => {
  test('preserves K3 runtime, modality, token, and agentic metadata', () => {
    const [model] = mapAvailableServerModelsToModels([{
      modelId: 'kimi-k3-YoudaoInner',
      modelName: 'Kimi K3',
      provider: 'moonshot',
      apiFormat: 'openai',
      runtimeProfile: 'moonshot-kimi-k3',
      supportsImage: true,
      supportsVideo: true,
      supportsThinking: true,
      thinkingConfig: {
        options: [
          { level: 'off', openclawLevel: 'off' },
          { level: 'high', openclawLevel: 'high' },
          { level: 'max', openclawLevel: 'xhigh' },
        ],
        defaultLevel: 'high',
      },
      requestCapabilities: [LobsterAIRequestCapability.OptionsV1],
      supportsToolCalling: true,
      agenticReady: false,
      contextWindow: 1_048_576,
      maxTokens: 8_192,
      moreModel: true,
      accessible: true,
    }]);

    expect(model).toMatchObject({
      id: 'kimi-k3-YoudaoInner',
      providerKey: ProviderName.LobsteraiServer,
      isServerModel: true,
      serverApiFormat: 'openai',
      runtimeProfile: 'moonshot-kimi-k3',
      supportsImage: true,
      supportsVideo: true,
      supportsThinking: true,
      thinkingConfig: {
        options: [
          { level: 'off', openclawLevel: 'off' },
          { level: 'high', openclawLevel: 'high' },
          { level: 'max', openclawLevel: 'xhigh' },
        ],
        defaultLevel: 'high',
      },
      requestCapabilities: [LobsterAIRequestCapability.OptionsV1],
      supportsToolCalling: true,
      agenticReady: false,
      contextWindow: 1_048_576,
      maxTokens: 8_192,
      moreModel: true,
      accessible: true,
    });
  });

  test('ignores malformed thinking configuration without hiding the model', () => {
    const [model] = mapAvailableServerModelsToModels([{
      modelId: 'deepseek-v4-flash',
      modelName: 'DeepSeek V4 Flash',
      provider: 'LobsterAI',
      apiFormat: 'openai',
      supportsThinking: true,
      thinkingConfig: {
        options: [
          { level: 'off', openclawLevel: 'off' },
          { level: 'high', openclawLevel: 'high' },
        ],
        defaultLevel: 'max',
      },
    }]);

    expect(model.id).toBe('deepseek-v4-flash');
    expect(model.supportsThinking).toBe(true);
    expect(model.thinkingConfig).toBeUndefined();
  });

  test('filters unknown request capabilities from the server response', () => {
    const [model] = mapAvailableServerModelsToModels([{
      modelId: 'capability-test',
      modelName: 'Capability Test',
      provider: 'LobsterAI',
      apiFormat: 'openai',
      requestCapabilities: [
        LobsterAIRequestCapability.OptionsV1,
        'future-unknown-capability',
      ],
    }]);

    expect(model.requestCapabilities).toEqual([LobsterAIRequestCapability.OptionsV1]);
  });
});

describe('auth-scoped renderer requests', () => {
  test('rejects late model, profile, and public-catalog responses after auth changes', () => {
    const personalA = {
      isLoggedIn: true,
      ownerAccountKey: 'personal:6',
      accountGeneration: 3,
    };

    expect(isAuthAccountRequestCurrent(personalA, { ...personalA })).toBe(true);
    expect(isAuthAccountRequestCurrent(personalA, {
      isLoggedIn: true,
      ownerAccountKey: 'enterprise:6:1001',
      accountGeneration: 4,
    })).toBe(false);
    expect(isAuthAccountRequestCurrent({
      isLoggedIn: false,
      ownerAccountKey: null,
      accountGeneration: 4,
    }, personalA)).toBe(false);
  });

  test('clears the previous renderer account when a committed exchange lacks a stable owner', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('window', {
      electron: {
        auth: {
          exchange: vi.fn().mockResolvedValue({
            success: true,
            user: {
              yid: 'enterprise-user',
              accountMode: 'enterprise',
              nickname: 'Enterprise User',
              avatarUrl: null,
            },
            quota: null,
            enterpriseContext: null,
          }),
        },
        log: { fromRenderer: vi.fn() },
      },
    });
    store.dispatch(setLoggedIn({
      user: {
        yid: 'previous-user',
        nickname: 'Previous User',
        avatarUrl: null,
      },
      quota: null,
      ownerAccountKey: 'personal:previous-user',
    }));

    await expect(authService.handleCallback('auth-code')).resolves.toBe(false);
    expect(store.getState().auth).toMatchObject({
      isLoggedIn: false,
      ownerAccountKey: null,
      user: null,
      quota: null,
    });
  });
});

// [INTRA-ONLY] Login is routed through the in-app credential form for intranet
// builds, so the system-browser handoff these tests used to cover is no longer
// reachable while `INTRANET_CREDENTIAL_LOGIN_ENABLED` is true.
// [INTRA-ONLY] Login is routed through the in-app credential form for intranet
// builds, so the system-browser handoff these tests used to cover is no longer
// reachable while `INTRANET_CREDENTIAL_LOGIN_ENABLED` is true.
describe('login diagnostics', () => {
  const INTRANET_USER = {
    userId: 'E1001',
    yid: 'E1001',
    nickname: 'E1001',
    avatarUrl: null,
  };

  const stubCredentialLoginWindow = (loginWithCredentials: ReturnType<typeof vi.fn>) => {
    const login = vi.fn();
    const fromRenderer = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.stubGlobal('window', {
      dispatchEvent: vi.fn(),
      electron: {
        auth: { login, loginWithCredentials },
        log: { fromRenderer },
      },
    });
    return { fromRenderer, login };
  };

  test('collects credentials in-app instead of handing off to the system browser', async () => {
    const loginWithCredentials = vi.fn().mockResolvedValue({
      success: true,
      user: INTRANET_USER,
      quota: null,
      enterpriseContext: null,
    });
    const { fromRenderer, login } = stubCredentialLoginWindow(loginWithCredentials);

    const pending = authService.login();
    expect(getIntranetCredentialLoginState().open).toBe(true);
    submitIntranetCredentialLogin({ employeeId: 'E1001', password: 'p@ssw0rd' });
    await expect(pending).resolves.toEqual({ success: true });

    expect(loginWithCredentials).toHaveBeenCalledWith('E1001', 'p@ssw0rd');
    expect(login).not.toHaveBeenCalled();
    expect(store.getState().auth.ownerAccountKey).toBe('personal:E1001');
    expect(getIntranetCredentialLoginState().open).toBe(false);
    expect(fromRenderer.mock.calls.flat().join(' ')).not.toContain('p@ssw0rd');
  });

  test('re-opens the form with an inline error and retries after a rejection', async () => {
    const loginWithCredentials = vi.fn()
      .mockResolvedValueOnce({ success: false, reason: 'invalid_credentials' })
      .mockResolvedValueOnce({
        success: true,
        user: INTRANET_USER,
        quota: null,
        enterpriseContext: null,
      });
    stubCredentialLoginWindow(loginWithCredentials);

    const pending = authService.login();
    submitIntranetCredentialLogin({ employeeId: 'E1001', password: 'wrong' });

    await vi.waitFor(() => {
      expect(getIntranetCredentialLoginState().error)
        .toBe(i18nService.t('intranetLoginInvalidCredentials'));
    });
    expect(getIntranetCredentialLoginState().open).toBe(true);

    submitIntranetCredentialLogin({ employeeId: 'E1001', password: 'right' });
    await expect(pending).resolves.toEqual({ success: true });
    expect(loginWithCredentials).toHaveBeenLastCalledWith('E1001', 'right');
  });

  test('resolves as cancelled when the form closes', async () => {
    const loginWithCredentials = vi.fn();
    stubCredentialLoginWindow(loginWithCredentials);

    const pending = authService.login();
    closeIntranetCredentialLogin();

    await expect(pending).resolves.toEqual({
      success: false,
      cancelled: true,
      error: i18nService.t('intranetLoginCancelled'),
    });
    expect(loginWithCredentials).not.toHaveBeenCalled();
  });
});

describe('quota checks', () => {
  test('returns a failure without issuing IPC requests when logged out', async () => {
    const getQuota = vi.fn();
    vi.stubGlobal('window', {
      electron: {
        auth: { getQuota },
        log: { fromRenderer: vi.fn() },
      },
    });

    await expect(authService.checkQuota()).resolves.toEqual({
      success: false,
      enterpriseQuotaAvailable: false,
    });
    expect(getQuota).not.toHaveBeenCalled();
  });

  test('refreshes quota and profile summary together', async () => {
    const getQuota = vi.fn().mockResolvedValue({
      success: true,
      quota: {
        planName: 'Enterprise',
        subscriptionStatus: 'active',
        creditsLimit: 100,
        creditsUsed: 10,
        creditsRemaining: 90,
      },
      enterpriseContext: null,
    });
    const getProfileSummary = vi.fn().mockResolvedValue({
      success: true,
      data: {
        id: 1,
        nickname: 'Tester',
        avatarUrl: null,
        totalCreditsRemaining: 90,
        creditItems: [],
      },
    });
    vi.stubGlobal('window', {
      electron: {
        auth: {
          getQuota,
          getProfileSummary,
        },
      },
    });
    store.dispatch(setLoggedIn({
      user: {
        yid: 'tester',
        nickname: 'Tester',
        avatarUrl: null,
      },
      quota: null,
      ownerAccountKey: 'personal:tester',
    }));

    await expect(authService.checkQuota()).resolves.toEqual({
      success: true,
      enterpriseQuotaAvailable: true,
    });

    expect(getQuota).toHaveBeenCalledOnce();
    expect(getProfileSummary).toHaveBeenCalledOnce();
    expect(store.getState().auth.quota?.creditsRemaining).toBe(90);
    // Server plan models are disabled in this build; none may enter the store.
    expect(store.getState().model.availableModels.some(m => m.isServerModel)).toBe(false);
  });

  test('shares concurrent quota checks to avoid duplicate IPC requests', async () => {
    let resolveQuota: ((value: {
      success: boolean;
      quota: null;
      enterpriseContext: null;
    }) => void) | undefined;
    const quotaResponse = new Promise<{
      success: boolean;
      quota: null;
      enterpriseContext: null;
    }>((resolve) => {
      resolveQuota = resolve;
    });
    const getQuota = vi.fn().mockReturnValue(quotaResponse);
    const getProfileSummary = vi.fn().mockResolvedValue({ success: true, data: null });
    vi.stubGlobal('window', {
      electron: {
        auth: {
          getQuota,
          getProfileSummary,
        },
        log: { fromRenderer: vi.fn() },
      },
    });
    store.dispatch(setLoggedIn({
      user: {
        yid: 'tester',
        nickname: 'Tester',
        avatarUrl: null,
      },
      quota: null,
      ownerAccountKey: 'personal:tester',
    }));

    const firstCheck = authService.checkQuota();
    const secondCheck = authService.checkQuota();
    resolveQuota?.({
      success: true,
      quota: null,
      enterpriseContext: null,
    });

    await expect(Promise.all([firstCheck, secondCheck])).resolves.toEqual([
      { success: true, enterpriseQuotaAvailable: true },
      { success: true, enterpriseQuotaAvailable: true },
    ]);
    expect(getQuota).toHaveBeenCalledOnce();
    expect(getProfileSummary).toHaveBeenCalledOnce();
  });

  test('does not join a quota check started by a previous account', async () => {
    let resolveFirstQuota!: (value: {
      success: boolean;
      quota: null;
      enterpriseContext: null;
    }) => void;
    const firstQuotaResponse = new Promise<{
      success: boolean;
      quota: null;
      enterpriseContext: null;
    }>(resolve => {
      resolveFirstQuota = resolve;
    });
    const getQuota = vi.fn()
      .mockReturnValueOnce(firstQuotaResponse)
      .mockResolvedValueOnce({
        success: true,
        quota: null,
        enterpriseContext: null,
      });
    vi.stubGlobal('window', {
      electron: {
        auth: {
          getQuota,
          getProfileSummary: vi.fn().mockResolvedValue({ success: true, data: null }),
          getModels: vi.fn().mockResolvedValue({ success: true, models: [] }),
        },
        log: { fromRenderer: vi.fn() },
      },
    });
    store.dispatch(setLoggedIn({
      user: { yid: 'first', nickname: 'First', avatarUrl: null },
      quota: null,
      ownerAccountKey: 'personal:first',
    }));

    const firstCheck = authService.checkQuota();
    store.dispatch(setLoggedIn({
      user: { yid: 'second', nickname: 'Second', avatarUrl: null },
      quota: null,
      ownerAccountKey: 'personal:second',
    }));
    const secondCheck = authService.checkQuota();

    await expect(secondCheck).resolves.toEqual({
      success: true,
      enterpriseQuotaAvailable: true,
    });
    expect(getQuota).toHaveBeenCalledTimes(2);

    resolveFirstQuota({ success: true, quota: null, enterpriseContext: null });
    await expect(firstCheck).resolves.toEqual({
      success: false,
      enterpriseQuotaAvailable: false,
    });
  });

  test('reports the refreshed enterprise quota as unavailable', async () => {
    const getQuota = vi.fn().mockResolvedValue({
      success: true,
      quota: null,
      enterpriseContext: {
        accountMode: 'enterprise',
        enterpriseId: 1001,
        memberId: 2001,
        enterpriseName: 'Example enterprise',
        role: EnterpriseMemberRole.Member,
        permissions: {
          manageEnterprise: false,
          adjustMemberQuota: false,
          rechargeEnterprise: false,
        },
        memberQuota: { limit: 100, used: 100, remaining: 0 },
        enterprisePool: { total: 1000, used: 400, remaining: 600 },
        quotaStatus: {
          available: false,
          reason: EnterpriseQuotaReason.MemberMonthlyQuotaExhausted,
          errorCode: 41606,
        },
      },
    });
    vi.stubGlobal('window', {
      electron: {
        auth: {
          getQuota,
          getProfileSummary: vi.fn(),
          getModels: vi.fn().mockResolvedValue({ success: true, models: [] }),
        },
        log: { fromRenderer: vi.fn() },
      },
    });
    store.dispatch(setLoggedIn({
      user: {
        yid: 'tester',
        nickname: 'Tester',
        avatarUrl: null,
      },
      quota: null,
      ownerAccountKey: 'enterprise:tester:1001',
    }));

    await expect(authService.checkQuota()).resolves.toEqual({
      success: true,
      enterpriseQuotaAvailable: false,
    });
    expect(store.getState().enterpriseAccount.context?.quotaStatus.reason)
      .toBe(EnterpriseQuotaReason.MemberMonthlyQuotaExhausted);
  });
});

describe('server model loading', () => {
  const signIn = (ownerAccountKey = 'personal:tester') => {
    store.dispatch(setLoggedIn({
      user: { yid: 'tester', nickname: 'Tester', avatarUrl: null },
      quota: null,
      ownerAccountKey,
    }));
  };

  test('does not request or dispatch server models while disabled', async () => {
    const getModels = vi.fn();
    vi.stubGlobal('window', {
      electron: {
        auth: { getModels },
        log: { fromRenderer: vi.fn() },
      },
    });
    signIn();

    await expect(authService.refreshServerModels()).resolves.toBe(false);
    expect(getModels).not.toHaveBeenCalled();
    expect(store.getState().model.availableModels.some(model => model.isServerModel)).toBe(false);
  });
});

describe('enterprise quota period boundary refresh', () => {
  const context = (endExclusive: string): EnterpriseAccountContext => ({
    accountMode: 'enterprise',
    enterpriseId: 1001,
    memberId: 2001,
    enterpriseName: 'Example enterprise',
    role: EnterpriseMemberRole.Member,
    permissions: {
      manageEnterprise: false,
      adjustMemberQuota: false,
      rechargeEnterprise: false,
    },
    memberQuota: {
      limit: 100,
      used: 100,
      remaining: 0,
      refreshCycle: 'natural_week',
      periodStart: '2026-08-10T00:00:00+08:00',
      periodEndExclusive: endExclusive,
    },
    enterprisePool: { total: 1000, used: 400, remaining: 600 },
    quotaStatus: {
      available: false,
      reason: EnterpriseQuotaReason.MemberMonthlyQuotaExhausted,
      errorCode: 41606,
    },
  });

  test('checks quota once after the current period boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T23:59:58+08:00'));
    store.dispatch(setLoggedIn({
      user: { yid: 'tester', nickname: 'Tester', avatarUrl: null },
      quota: null,
      ownerAccountKey: 'enterprise:tester:1001',
    }));
    const enterpriseContext = context('2026-08-17T00:00:00+08:00');
    store.dispatch(setEnterpriseAccountContext(enterpriseContext));
    const quotaSpy = vi.spyOn(authService, 'checkQuota').mockResolvedValue({
      success: true,
      enterpriseQuotaAvailable: true,
    });
    const boundaryService = authService as unknown as {
      scheduleEnterpriseQuotaBoundary: (
        value: EnterpriseAccountContext | null,
      ) => void;
    };

    boundaryService.scheduleEnterpriseQuotaBoundary(enterpriseContext);
    await vi.advanceTimersByTimeAsync(3_001);

    expect(quotaSpy).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quotaSpy).toHaveBeenCalledOnce();
  });

  test('clears the old boundary timer when enterprise context is removed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T23:59:58+08:00'));
    store.dispatch(setLoggedIn({
      user: { yid: 'tester', nickname: 'Tester', avatarUrl: null },
      quota: null,
      ownerAccountKey: 'enterprise:tester:1001',
    }));
    const enterpriseContext = context('2026-08-17T00:00:00+08:00');
    store.dispatch(setEnterpriseAccountContext(enterpriseContext));
    const quotaSpy = vi.spyOn(authService, 'checkQuota').mockResolvedValue({
      success: true,
      enterpriseQuotaAvailable: true,
    });
    const boundaryService = authService as unknown as {
      scheduleEnterpriseQuotaBoundary: (
        value: EnterpriseAccountContext | null,
      ) => void;
    };

    boundaryService.scheduleEnterpriseQuotaBoundary(enterpriseContext);
    boundaryService.scheduleEnterpriseQuotaBoundary(null);
    store.dispatch(setEnterpriseAccountContext(null));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(quotaSpy).not.toHaveBeenCalled();
  });
});

describe('auth state restoration', () => {
  const user = {
    yid: 'user@example.com',
    nickname: 'Lobster User',
    avatarUrl: null,
  };
  const quota = {
    planName: '专业',
    subscriptionStatus: 'active',
    creditsLimit: 1_000,
    creditsUsed: 100,
    creditsRemaining: 900,
  };

  test('preserves the current login snapshot for a temporary verification failure', async () => {
    store.dispatch(setLoggedIn({
      user,
      quota,
      ownerAccountKey: 'personal:user@example.com',
    }));
    vi.stubGlobal('window', {
      electron: {
        auth: {
          getUser: vi.fn().mockResolvedValue({
            success: false,
            status: AuthSessionStatus.TemporarilyUnavailable,
            hasCredentials: true,
            cachedUser: user,
          }),
        },
      },
    });

    const result = await authService.refreshAuthState({ clearOnFailure: true });

    expect(result.isLoggedIn).toBe(true);
    expect(store.getState().auth).toMatchObject({
      isLoggedIn: true,
      sessionStatus: AuthSessionStatus.TemporarilyUnavailable,
      user,
      quota,
    });
  });

  test('clears the current login snapshot for terminal expiration', async () => {
    store.dispatch(setLoggedIn({
      user,
      quota,
      ownerAccountKey: 'personal:user@example.com',
    }));
    vi.stubGlobal('window', {
      electron: {
        auth: {
          getUser: vi.fn().mockResolvedValue({
            success: false,
            status: AuthSessionStatus.Expired,
            hasCredentials: false,
          }),
          getPricingCatalog: vi.fn().mockResolvedValue({
            success: true,
            textModels: [],
          }),
        },
      },
    });

    const result = await authService.refreshAuthState({ clearOnFailure: true });

    expect(result.isLoggedIn).toBe(false);
    expect(store.getState().auth).toMatchObject({
      isLoggedIn: false,
      sessionStatus: AuthSessionStatus.Expired,
      user: null,
      quota: null,
    });
  });

  test('shows a re-login toast when the main process reports terminal expiration', async () => {
    const dispatchEvent = vi.fn();
    store.dispatch(setLoggedIn({
      user,
      quota,
      ownerAccountKey: 'personal:user@example.com',
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('window', {
      dispatchEvent,
      electron: {
        auth: {
          getPricingCatalog: vi.fn().mockResolvedValue({
            success: true,
            textModels: [],
          }),
        },
      },
    });

    const serviceWithSessionHandler = authService as unknown as {
      handleSessionChanged: (event: AuthSessionChangedEvent) => Promise<void>;
    };
    await serviceWithSessionHandler.handleSessionChanged({
      status: AuthSessionStatus.Expired,
      reason: AuthSessionChangeReason.RefreshRejected,
    });

    expect(store.getState().auth.sessionStatus).toBe(AuthSessionStatus.Expired);
    expect(dispatchEvent).toHaveBeenCalledOnce();
    const toastEvent = dispatchEvent.mock.calls[0][0] as CustomEvent<string>;
    expect(toastEvent.type).toBe('app:showToast');
    expect(toastEvent.detail).toContain('登录状态已过期');
  });

  test('shows the dedicated signed-out toast when enterprise membership is revoked', async () => {
    const dispatchEvent = vi.fn();
    store.dispatch(setLoggedIn({
      user,
      quota,
      ownerAccountKey: 'enterprise:user@example.com:1001',
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('window', {
      dispatchEvent,
      electron: {
        auth: {
          getPricingCatalog: vi.fn().mockResolvedValue({
            success: true,
            textModels: [],
          }),
        },
      },
    });

    const serviceWithSessionHandler = authService as unknown as {
      handleSessionChanged: (event: AuthSessionChangedEvent) => Promise<void>;
    };
    await serviceWithSessionHandler.handleSessionChanged({
      status: AuthSessionStatus.Expired,
      reason: AuthSessionChangeReason.EnterpriseMembershipRevoked,
    });

    expect(store.getState().auth.sessionStatus).toBe(AuthSessionStatus.Expired);
    expect(dispatchEvent).toHaveBeenCalledOnce();
    const toastEvent = dispatchEvent.mock.calls[0][0] as CustomEvent<string>;
    expect(toastEvent.type).toBe('app:showToast');
    expect(toastEvent.detail).toBe('你已被移出当前团队，已退出登录。请重新登录并选择可用身份。');
  });

  test('provides the enterprise membership revocation message in English', () => {
    i18nService.setLanguage('en', { persist: false });

    expect(i18nService.t('coworkErrorEnterpriseMembershipRevoked')).toBe(
      'You have been removed from the current team and signed out. '
      + 'Sign in again to choose an available identity.',
    );
  });

  test('discards a stale restore response after the renderer account changes', async () => {
    let resolveUser!: (value: {
      success: true;
      user: typeof user;
      quota: typeof quota;
      enterpriseContext: null;
    }) => void;
    const getUser = vi.fn(() => new Promise<{
      success: true;
      user: typeof user;
      quota: typeof quota;
      enterpriseContext: null;
    }>(resolve => {
      resolveUser = resolve;
    }));
    vi.stubGlobal('window', {
      electron: {
        auth: { getUser },
        log: { fromRenderer: vi.fn() },
      },
    });
    store.dispatch(setLoggedIn({
      user,
      quota,
      ownerAccountKey: 'personal:user@example.com',
    }));

    const refresh = authService.refreshAuthState({ clearOnFailure: true });
    const nextUser = {
      ...user,
      yid: 'next@example.com',
      nickname: 'Next User',
    };
    store.dispatch(setLoggedIn({
      user: nextUser,
      quota: null,
      ownerAccountKey: 'personal:next@example.com',
    }));
    resolveUser({
      success: true,
      user,
      quota,
      enterpriseContext: null,
    });

    await expect(refresh).resolves.toMatchObject({
      isLoggedIn: true,
      user: nextUser,
      quota: null,
    });
    expect(store.getState().auth.ownerAccountKey).toBe('personal:next@example.com');
  });

  test('does not apply a stale enterprise context after the renderer account changes', async () => {
    let resolveContext!: (value: {
      success: true;
      context: {
        enterpriseId: number;
        enterpriseName: string;
        role: EnterpriseMemberRole;
        quotaStatus: {
          available: true;
          reason: null;
        };
      };
    }) => void;
    const getContext = vi.fn(() => new Promise<{
      success: true;
      context: {
        enterpriseId: number;
        enterpriseName: string;
        role: EnterpriseMemberRole;
        quotaStatus: {
          available: true;
          reason: null;
        };
      };
    }>(resolve => {
      resolveContext = resolve;
    }));
    vi.stubGlobal('window', {
      electron: {
        auth: {
          getUser: vi.fn().mockResolvedValue({
            success: true,
            user,
            quota,
          }),
        },
        enterpriseAccount: { getContext },
        log: { fromRenderer: vi.fn() },
      },
    });
    store.dispatch(setLoggedIn({
      user,
      quota,
      ownerAccountKey: 'personal:user@example.com',
    }));

    const refresh = authService.refreshAuthState({ clearOnFailure: true });
    await vi.waitFor(() => expect(getContext).toHaveBeenCalledOnce());
    const nextUser = {
      ...user,
      yid: 'next@example.com',
      nickname: 'Next User',
    };
    store.dispatch(setLoggedIn({
      user: nextUser,
      quota: null,
      ownerAccountKey: 'personal:next@example.com',
    }));
    resolveContext({
      success: true,
      context: {
        enterpriseId: 1001,
        enterpriseName: 'Stale Enterprise',
        role: EnterpriseMemberRole.Member,
        quotaStatus: {
          available: true,
          reason: null,
        },
      },
    });

    await expect(refresh).resolves.toMatchObject({
      isLoggedIn: true,
      user: nextUser,
      quota: null,
      enterpriseContext: null,
    });
    expect(store.getState().enterpriseAccount.context).toBeNull();
    expect(store.getState().auth.ownerAccountKey).toBe('personal:next@example.com');
  });
});
