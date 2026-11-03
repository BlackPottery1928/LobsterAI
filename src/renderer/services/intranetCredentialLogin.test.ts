// [INTRA-ONLY] Tests for the in-app credential login driver.
//
// Only the cancellation contract is covered here: every other path reaches for
// `window.electron`, and this suite runs in a node environment.
import { beforeEach, describe, expect, test, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  requestIntranetCredentialLogin: vi.fn(),
  closeIntranetCredentialLogin: vi.fn(),
  isIntranetCredentialLoginCancelled: vi.fn(() => false),
  reportIntranetCredentialLoginFailure: vi.fn(),
}));

vi.mock('../components/auth/intranetCredentialLoginBridge', () => bridge);

import { loginWithIntranetCredentials, resetIntranetCredentialLogin } from './intranetCredentialLogin';

const deps = {
  applyAuthenticatedState: vi.fn(),
  log: vi.fn(),
};

describe('loginWithIntranetCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridge.isIntranetCredentialLoginCancelled.mockReturnValue(false);
    resetIntranetCredentialLogin();
  });

  test('reports a dismissed form as cancelled rather than failed', async () => {
    // `null` is what the bridge resolves with when the user closes the form
    // (Esc or the cancel button) — not an error condition.
    bridge.requestIntranetCredentialLogin.mockResolvedValue(null);

    const result = await loginWithIntranetCredentials(deps, 1);

    expect(result.success).toBe(false);
    // `cancelled` is what lets callers stay silent instead of reporting a failure.
    expect(result.cancelled).toBe(true);
  });

  test('does not ask the form to report an error when cancelled', async () => {
    bridge.requestIntranetCredentialLogin.mockResolvedValue(null);

    await loginWithIntranetCredentials(deps, 1);

    expect(bridge.reportIntranetCredentialLoginFailure).not.toHaveBeenCalled();
    expect(deps.applyAuthenticatedState).not.toHaveBeenCalled();
  });
});
