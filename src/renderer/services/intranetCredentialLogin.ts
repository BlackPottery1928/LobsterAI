// [INTRA-ONLY] Drives the in-app intranet credential form end to end.
//
// Kept out of `services/auth.ts` so the upstream service only needs a small
// branch in `login()`; everything specific to the intranet flow lives here.
//
// The password is passed straight to the main process and is never logged,
// stored, or echoed back.

import type { AuthLoginResult } from '@shared/auth/constants';

import type { EnterpriseAccountContext } from '../../shared/enterpriseAccount/types';
import {
  IntranetLoginFailureReason,
  type IntranetLoginFailureReason as IntranetLoginFailureReasonValue,
} from '../../shared/intranetAuth/constants';
import {
  closeIntranetCredentialLogin,
  type IntranetCredentialLoginInput,
  isIntranetCredentialLoginCancelled,
  reportIntranetCredentialLoginFailure,
  requestIntranetCredentialLogin,
} from '../components/auth/intranetCredentialLoginBridge';
import { store } from '../store';
import type { UserProfile, UserQuota } from '../store/slices/authSlice';
import { invalidateAuthAccountContext } from '../store/slices/authSlice';
import { clearMediaAccountState } from '../store/slices/coworkSlice';
import { i18nService } from './i18n';

/** Carries the failure tag so the form can render a localized message. */
class IntranetCredentialLoginFailure extends Error {
  readonly reason?: IntranetLoginFailureReasonValue;

  constructor(reason?: IntranetLoginFailureReasonValue) {
    super('Intranet credential login failed');
    this.name = 'IntranetCredentialLoginFailure';
    this.reason = reason;
  }
}

const MESSAGE_KEY_BY_REASON: Record<IntranetLoginFailureReasonValue, string> = {
  [IntranetLoginFailureReason.InvalidCredentials]: 'intranetLoginInvalidCredentials',
  [IntranetLoginFailureReason.InvalidResponse]: 'intranetLoginInvalidResponse',
  [IntranetLoginFailureReason.Network]: 'intranetLoginNetworkError',
  [IntranetLoginFailureReason.Timeout]: 'intranetLoginTimeout',
};

/**
 * Typed view of the preload bridge method. Declared here rather than added to
 * `types/electron.d.ts` so this build does not edit that upstream file.
 */
type CredentialLoginBridge = (
  employeeId: string,
  password: string,
) => Promise<{
  success: boolean;
  user?: UserProfile;
  quota?: UserQuota;
  enterpriseContext?: EnterpriseAccountContext | null;
  reason?: IntranetLoginFailureReasonValue;
}>;

const getCredentialLoginBridge = (): CredentialLoginBridge | undefined => (
  (window.electron?.auth as { loginWithCredentials?: CredentialLoginBridge } | undefined)
    ?.loginWithCredentials
);

export interface IntranetCredentialLoginDeps {
  /** Commits the session into the auth store (the service's private method). */
  applyAuthenticatedState: (
    user: UserProfile,
    quota: UserQuota | null | undefined,
    enterpriseContext: EnterpriseAccountContext | null | undefined,
  ) => void;
  log: (level: 'info' | 'warn', message: string, error?: unknown) => void;
}

let inFlight: Promise<AuthLoginResult> | null = null;

/** Called from `AuthService.destroy()` so a later login starts clean. */
export function resetIntranetCredentialLogin(): void {
  inFlight = null;
  closeIntranetCredentialLogin();
}

/**
 * Show the credential form and commit the session it produces, retrying in
 * place until the intranet API accepts the credentials or the user cancels.
 */
export function loginWithIntranetCredentials(
  deps: IntranetCredentialLoginDeps,
  attemptId: number,
): Promise<AuthLoginResult> {
  if (inFlight) {
    return inFlight;
  }
  const attempt = runCredentialLogin(deps, attemptId)
    .finally(() => {
      if (inFlight === attempt) {
        inFlight = null;
      }
    });
  inFlight = attempt;
  return attempt;
}

async function runCredentialLogin(
  deps: IntranetCredentialLoginDeps,
  attemptId: number,
): Promise<AuthLoginResult> {
  for (;;) {
    const credentials = await requestIntranetCredentialLogin();
    if (!credentials) {
      deps.log('info', `login attempt ${attemptId} cancelled before submitting credentials`);
      return { success: false, error: i18nService.t('intranetLoginCancelled') };
    }

    try {
      await commitCredentialLogin(deps, credentials);
      closeIntranetCredentialLogin();
      deps.log('info', `login attempt ${attemptId} completed via the in-app form`);
      return { success: true };
    } catch (error) {
      if (isIntranetCredentialLoginCancelled()) {
        return { success: false, error: i18nService.t('intranetLoginCancelled') };
      }
      deps.log('warn', `login attempt ${attemptId} was rejected by the intranet API`);
      const reason = error instanceof IntranetCredentialLoginFailure ? error.reason : undefined;
      const messageKey = reason ? MESSAGE_KEY_BY_REASON[reason] : undefined;
      reportIntranetCredentialLoginFailure(
        i18nService.t(messageKey ?? 'intranetLoginFailed'),
      );
    }
  }
}

/**
 * Deliberately skips `authService.handleCallback`'s tail (server model loading,
 * profile summary, quota refresh): those request the existing LobsterAI server
 * with the intranet token, and a 401 there drives `AuthSessionManager` into its
 * terminal-refresh path, which would clear the session just created.
 */
async function commitCredentialLogin(
  deps: IntranetCredentialLoginDeps,
  credentials: IntranetCredentialLoginInput,
): Promise<void> {
  const loginWithCredentials = getCredentialLoginBridge();
  if (typeof loginWithCredentials !== 'function') {
    throw new IntranetCredentialLoginFailure();
  }

  const result = await loginWithCredentials(credentials.employeeId, credentials.password);
  if (!result.success || !result.user) {
    throw new IntranetCredentialLoginFailure(result.reason);
  }

  store.dispatch(invalidateAuthAccountContext());
  store.dispatch(clearMediaAccountState());
  deps.applyAuthenticatedState(result.user, result.quota, result.enterpriseContext ?? null);
}
