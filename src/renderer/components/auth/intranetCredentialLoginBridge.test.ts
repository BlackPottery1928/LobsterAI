// [INTRA-ONLY] Tests for the in-app login form bridge.
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  closeIntranetCredentialLogin,
  getIntranetCredentialLoginState,
  isIntranetCredentialLoginCancelled,
  reportIntranetCredentialLoginFailure,
  requestIntranetCredentialLogin,
  submitIntranetCredentialLogin,
  subscribeIntranetCredentialLogin,
} from './intranetCredentialLoginBridge';

afterEach(() => {
  closeIntranetCredentialLogin();
});

describe('intranetCredentialLoginBridge', () => {
  test('opens the form and resolves with the submitted credentials', async () => {
    expect(getIntranetCredentialLoginState().open).toBe(false);

    const pending = requestIntranetCredentialLogin();
    expect(getIntranetCredentialLoginState()).toMatchObject({ open: true, error: null });

    submitIntranetCredentialLogin({ employeeId: 'E1001', password: 'p@ssw0rd' });

    await expect(pending).resolves.toEqual({ employeeId: 'E1001', password: 'p@ssw0rd' });
    expect(getIntranetCredentialLoginState()).toMatchObject({
      open: true,
      submitting: true,
      error: null,
    });
  });

  test('resolves with null when the user cancels', async () => {
    const pending = requestIntranetCredentialLogin();
    closeIntranetCredentialLogin();

    await expect(pending).resolves.toBeNull();
    expect(getIntranetCredentialLoginState().open).toBe(false);
    expect(isIntranetCredentialLoginCancelled()).toBe(true);
  });

  test('keeps the form open with an inline error after a rejected attempt', async () => {
    const pending = requestIntranetCredentialLogin();
    submitIntranetCredentialLogin({ employeeId: 'E1001', password: 'wrong' });
    await pending;

    reportIntranetCredentialLoginFailure('工号或密码错误');
    expect(getIntranetCredentialLoginState()).toMatchObject({
      open: true,
      submitting: false,
      error: '工号或密码错误',
    });

    // The caller can request the next submission without re-opening the form.
    const retry = requestIntranetCredentialLogin();
    expect(getIntranetCredentialLoginState().open).toBe(true);
    submitIntranetCredentialLogin({ employeeId: 'E1001', password: 'right' });

    await expect(retry).resolves.toEqual({ employeeId: 'E1001', password: 'right' });
  });

  test('serves every caller that requested the form', async () => {
    const first = requestIntranetCredentialLogin();
    const second = requestIntranetCredentialLogin();

    submitIntranetCredentialLogin({ employeeId: 'E1001', password: 'p@ssw0rd' });

    await expect(first).resolves.toEqual({ employeeId: 'E1001', password: 'p@ssw0rd' });
    await expect(second).resolves.toEqual({ employeeId: 'E1001', password: 'p@ssw0rd' });
  });

  test('notifies subscribers once per transition and ignores no-op updates', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeIntranetCredentialLogin(listener);

    const pending = requestIntranetCredentialLogin();
    expect(listener).toHaveBeenCalledTimes(1);

    // Re-requesting while the form is already open is not a state transition.
    const second = requestIntranetCredentialLogin();
    expect(listener).toHaveBeenCalledTimes(1);

    closeIntranetCredentialLogin();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    submitIntranetCredentialLogin({ employeeId: 'E1001', password: 'p@ssw0rd' });
    expect(listener).toHaveBeenCalledTimes(2);

    // Settle the dangling promises so the test cannot leak pending work.
    return Promise.all([pending, second]);
  });

  test('ignores submits and cancels with nothing pending', () => {
    expect(() => {
      submitIntranetCredentialLogin({ employeeId: 'E1001', password: 'p@ssw0rd' });
      closeIntranetCredentialLogin();
    }).not.toThrow();
    expect(getIntranetCredentialLoginState().open).toBe(false);
  });
});
