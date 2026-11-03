// [INTRA-ONLY] Employee-ID (工号) + password login against the intranet
// permission service.
//
// Lives outside `main.ts` so this build only adds a small registration call to
// the upstream entry point. The password is never logged, persisted, or echoed
// back to the renderer.

import type { IpcMain } from 'electron';

import { IntranetAuthIpcChannel } from '../../../shared/intranetAuth/constants';
import {
  type IntranetAuthFetch,
  IntranetLoginError,
  type IntranetLoginSession,
  performIntranetCredentialLogin,
} from '../../libs/intranetAuthLogin';

export interface IntranetAuthIpcHandlerDeps {
  ipcMain: IpcMain;
  fetch: IntranetAuthFetch;
  getBaseUrl: () => string;
  /**
   * Localized message for a session that changed mid-flight. Read per request:
   * the main-process language can change while the app is running.
   */
  getAccountChangedMessage: () => string;
  /** Process-wide auth account generation counter. */
  accountGeneration: {
    get: () => number;
    begin: () => void;
  };
  quotaGate: {
    get: () => unknown;
    sync: (before: unknown) => void;
    reset: () => void;
    normalize: (raw: Record<string, unknown>) => unknown;
  };
  session: {
    clearEnterpriseContext: () => void;
    clearServerModelMetadata: () => void;
    saveTokens: (accessToken: string, refreshToken: string) => void;
    saveUser: (user: Record<string, unknown>) => void;
    /** Drops selection/polling state belonging to the previous account. */
    clearMediaForAccountSwitch: () => void;
    settlePendingMediaTasks: () => void;
  };
}

export function registerIntranetAuthIpcHandlers(deps: IntranetAuthIpcHandlerDeps): void {
  const { ipcMain, session } = deps;

  /**
   * Commits the session locally. Unlike `auth:exchange` there is a single
   * network call that completes before any mutation, so there is nothing to
   * roll back - only the generation guard below is needed.
   */
  const commitSession = (login: IntranetLoginSession, quotaGateStateBefore: unknown): unknown => {
    session.clearMediaForAccountSwitch();
    deps.accountGeneration.begin();
    session.clearEnterpriseContext();
    session.clearServerModelMetadata();
    // Reset entitlement fallbacks before normalizing so a stale 'enterprise'
    // status cannot leak into the free-state quota below.
    deps.quotaGate.reset();
    session.saveTokens(login.accessToken, login.refreshToken);
    session.saveUser(login.user);
    session.settlePendingMediaTasks();
    // The intranet response carries no entitlement; the free state keeps
    // media/share/deployment gates off. Deliberately NOT notifying the renderer
    // of a quota change - it would fetch /api/user/quota immediately and tear
    // the fresh session down if the existing server rejects the intranet token.
    const quota = deps.quotaGate.normalize({});
    deps.quotaGate.sync(quotaGateStateBefore);
    return quota;
  };

  ipcMain.handle(
    IntranetAuthIpcChannel.Login,
    async (
      _event,
      { employeeId, password }: { employeeId?: string; password?: string } = {},
    ) => {
      const normalizedEmployeeId = typeof employeeId === 'string' ? employeeId.trim() : '';
      if (!normalizedEmployeeId || typeof password !== 'string' || !password) {
        return { success: false, error: 'Employee ID and password are required' };
      }

      const quotaGateStateBefore = deps.quotaGate.get();
      const generationBefore = deps.accountGeneration.get();
      // Never log the credentials or the request body.
      console.log(`[Auth] intranet credential login requested (employeeId=${normalizedEmployeeId})`);

      try {
        const login = await performIntranetCredentialLogin({
          baseUrl: deps.getBaseUrl(),
          credentials: { employeeId: normalizedEmployeeId, password },
          fetch: deps.fetch,
        });

        // A logout or another login committed while this request was in flight.
        if (deps.accountGeneration.get() !== generationBefore) {
          return { success: false, error: deps.getAccountChangedMessage() };
        }

        const quota = commitSession(login, quotaGateStateBefore);
        console.log('[Auth] intranet credential login completed');
        return { success: true, user: login.user, quota, enterpriseContext: null };
      } catch (error) {
        console.warn('[Auth] intranet credential login failed');
        return {
          success: false,
          reason: error instanceof IntranetLoginError ? error.reason : undefined,
          error: error instanceof Error ? error.message : 'Login failed',
        };
      }
    },
  );
}
