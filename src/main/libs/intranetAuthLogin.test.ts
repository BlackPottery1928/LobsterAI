// [INTRA-ONLY] Tests for the intranet credential login contract.
import { describe, expect, test, vi } from 'vitest';

import { IntranetLoginFailureReason } from '../../shared/intranetAuth/constants';
import {
  buildIntranetLoginRequest,
  INTRANET_AUTH_LOGIN_PATH,
  IntranetLoginError,
  normalizeIntranetUser,
  parseIntranetLoginResponse,
  performIntranetCredentialLogin,
} from './intranetAuthLogin';

const jsonResponse = (body: unknown, status = 200): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
} as unknown as Response);

const successBody = (data: Record<string, unknown>) => ({ code: 0, data });

const captureLoginError = (run: () => unknown): IntranetLoginError => {
  try {
    run();
  } catch (error) {
    return error as IntranetLoginError;
  }
  throw new Error('expected the call to throw');
};

describe('buildIntranetLoginRequest', () => {
  test('joins the login path onto the base URL and sends the credentials', () => {
    const { url, init } = buildIntranetLoginRequest({
      baseUrl: 'https://perm.intranet.example.com/',
      credentials: { employeeId: 'E1001', password: 'p@ssw0rd' },
    });

    expect(url).toBe(`https://perm.intranet.example.com${INTRANET_AUTH_LOGIN_PATH}`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({
      employeeId: 'E1001',
      password: 'p@ssw0rd',
    });
  });
});

describe('parseIntranetLoginResponse', () => {
  test('returns the tokens and the account from a successful response', () => {
    const session = parseIntranetLoginResponse(
      successBody({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        user: { employeeId: 'E1001', nickname: '张三' },
      }),
      'E1001',
    );

    expect(session.accessToken).toBe('access-token');
    expect(session.refreshToken).toBe('refresh-token');
    expect(session.user).toMatchObject({
      userId: 'E1001',
      yid: 'E1001',
      nickname: '张三',
      accountMode: 'personal',
    });
  });

  test('falls back to the submitted employee id when the user record omits it', () => {
    const session = parseIntranetLoginResponse(
      successBody({ accessToken: 'access-token', refreshToken: 'refresh-token', user: {} }),
      'E1001',
    );

    expect(session.user).toMatchObject({
      userId: 'E1001',
      yid: 'E1001',
      nickname: 'E1001',
    });
  });

  test('keeps the owner key stable when the service also returns a numeric row id', () => {
    const session = parseIntranetLoginResponse(
      successBody({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        user: { id: 42, nickname: '张三' },
      }),
      'E1001',
    );

    // `userId` wins over `id` in createAccountOwnerKey, so the 工号 is the owner.
    expect(session.user.userId).toBe('E1001');
  });

  test('drops credential-shaped fields from the persisted user record', () => {
    const user = normalizeIntranetUser({
      employeeId: 'E1001',
      nickname: '张三',
      token: 'leaked-token',
      password: 'leaked-password',
      nested: { keep: true },
    }, 'E1001');

    expect(user).not.toHaveProperty('token');
    expect(user).not.toHaveProperty('password');
    expect(user).toMatchObject({ employeeId: 'E1001', nested: { keep: true } });
  });

  test('falls back to the access token when no refresh token is issued', () => {
    const session = parseIntranetLoginResponse(
      successBody({ accessToken: 'access-token', user: { employeeId: 'E1001' } }),
      'E1001',
    );

    expect(session.refreshToken).toBe('access-token');
  });

  test('rejects a non-zero business code', () => {
    const error = captureLoginError(() => parseIntranetLoginResponse(
      { code: 40001, message: 'bad credentials' },
      'E1001',
    ));

    expect(error.reason).toBe(IntranetLoginFailureReason.InvalidCredentials);
    expect(error.code).toBe(40001);
    expect(error.message).toBe('bad credentials');
  });

  test('rejects a response without data or an access token', () => {
    expect(captureLoginError(() => parseIntranetLoginResponse({ code: 0 }, 'E1001')).reason)
      .toBe(IntranetLoginFailureReason.InvalidResponse);
    expect(captureLoginError(() => (
      parseIntranetLoginResponse(successBody({ user: {} }), 'E1001')
    )).reason).toBe(IntranetLoginFailureReason.InvalidResponse);
  });
});

describe('performIntranetCredentialLogin', () => {
  const credentials = { employeeId: 'E1001', password: 'p@ssw0rd' };

  test('returns the parsed session on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(successBody({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      user: { employeeId: 'E1001' },
    })));

    const session = await performIntranetCredentialLogin({
      baseUrl: 'https://perm.intranet.example.com',
      credentials,
      fetch: fetchImpl,
    });

    expect(session.accessToken).toBe('access-token');
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://perm.intranet.example.com${INTRANET_AUTH_LOGIN_PATH}`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('surfaces a transport failure as a network failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(performIntranetCredentialLogin({
      baseUrl: 'https://perm.intranet.example.com',
      credentials,
      fetch: fetchImpl,
    })).rejects.toBeInstanceOf(IntranetLoginError);

    await expect(performIntranetCredentialLogin({
      baseUrl: 'https://perm.intranet.example.com',
      credentials,
      fetch: fetchImpl,
    })).rejects.toMatchObject({ reason: IntranetLoginFailureReason.Network });
  });

  test('reports an aborted request as a timeout', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })
    ));

    await expect(performIntranetCredentialLogin({
      baseUrl: 'https://perm.intranet.example.com',
      credentials,
      fetch: fetchImpl,
      timeoutMs: 5,
    })).rejects.toMatchObject({ reason: IntranetLoginFailureReason.Timeout });
  });
});
