// [INTRA-ONLY] Intranet permission-API login.
//
// Intranet builds authenticate with an employee ID (工号) plus password instead
// of the browser portal handoff. The response carries the tokens directly, so
// there is no auth-code exchange step.
//
// This module is Electron-free on purpose so it can be unit tested with an
// injected fetch.

import { EnterpriseAccountMode } from '../../shared/enterpriseAccount/constants';
import {
  IntranetLoginFailureReason,
  type IntranetLoginFailureReason as IntranetLoginFailureReasonValue,
} from '../../shared/intranetAuth/constants';
import { getServerApiBaseUrl } from './endpoints';

// --- Service contract -------------------------------------------------------
// Default convention; adjust these to match the real permission API.
export const INTRANET_AUTH_LOGIN_PATH = '/api/auth/login';
const REQUEST_EMPLOYEE_ID_FIELD = 'employeeId';
const REQUEST_PASSWORD_FIELD = 'password';
const RESPONSE_ACCESS_TOKEN_FIELD = 'accessToken';
const RESPONSE_REFRESH_TOKEN_FIELD = 'refreshToken';
const RESPONSE_USER_FIELD = 'user';
/** Response business code that marks a successful login. */
const SUCCESS_CODE = 0;
const REQUEST_TIMEOUT_MS = 15_000;
/** Credential-shaped keys dropped from the returned user record. */
const SENSITIVE_USER_KEYS = ['accessToken', 'refreshToken', 'token', 'password', 'secret'];

/**
 * Base URL of the intranet permission service. Defaults to the Lobster server
 * origin so intranet builds reach the internal host without extra
 * configuration; override with `LOBSTER_INTRANET_AUTH_BASE_URL` when the
 * permission service lives elsewhere.
 */
export const getIntranetAuthBaseUrl = (): string => {
  const override = process.env.LOBSTER_INTRANET_AUTH_BASE_URL?.trim();
  if (!override) {
    return getServerApiBaseUrl();
  }
  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw new Error('LOBSTER_INTRANET_AUTH_BASE_URL must be an absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('LOBSTER_INTRANET_AUTH_BASE_URL must use HTTP(S)');
  }
  // `origin` drops any embedded credentials, query, or hash.
  return parsed.origin;
};

export type IntranetAuthFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface IntranetLoginCredentials {
  employeeId: string;
  password: string;
}

export interface IntranetLoginSession {
  accessToken: string;
  refreshToken: string;
  user: Record<string, unknown>;
}

export class IntranetLoginError extends Error {
  readonly reason: IntranetLoginFailureReasonValue;
  readonly code?: number;

  constructor(reason: IntranetLoginFailureReasonValue, message: string, code?: number) {
    super(message);
    this.name = 'IntranetLoginError';
    this.reason = reason;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function buildIntranetLoginRequest(input: {
  baseUrl: string;
  credentials: IntranetLoginCredentials;
}): { url: string; init: RequestInit } {
  return {
    url: `${input.baseUrl.replace(/\/+$/, '')}${INTRANET_AUTH_LOGIN_PATH}`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        [REQUEST_EMPLOYEE_ID_FIELD]: input.credentials.employeeId,
        [REQUEST_PASSWORD_FIELD]: input.credentials.password,
      }),
    },
  };
}

/**
 * Normalize the service's user record into the profile shape the renderer
 * expects. The submitted 工号 is pinned onto every id field because
 * `createAccountOwnerKey` needs `userId`/`yid`, and using the submitted value
 * keeps the owner key stable across logins.
 *
 * The account is always personal: the credential login never yields an
 * enterprise context, and `applyAuthenticatedState` rejects an enterprise
 * account without one.
 */
export function normalizeIntranetUser(
  rawUser: unknown,
  employeeId: string,
): Record<string, unknown> {
  const record = isRecord(rawUser) ? rawUser : {};
  const user: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (SENSITIVE_USER_KEYS.includes(key)) continue;
    user[key] = value;
  }

  const account = readString(record.employeeId) ?? employeeId;
  user.userId = account;
  user.yid = account;
  user.employeeId = account;
  user.accountMode = EnterpriseAccountMode.Personal;
  if (!readString(record.nickname)) {
    user.nickname = account;
  }
  return user;
}

export function parseIntranetLoginResponse(
  body: unknown,
  employeeId: string,
): IntranetLoginSession {
  if (!isRecord(body)) {
    throw new IntranetLoginError(
      IntranetLoginFailureReason.InvalidResponse,
      'Login response was not a JSON object',
    );
  }
  const code = typeof body.code === 'number' ? body.code : undefined;
  if (code !== SUCCESS_CODE) {
    throw new IntranetLoginError(
      IntranetLoginFailureReason.InvalidCredentials,
      readString(body.message) ?? readString(body.msg) ?? 'Login was rejected',
      code,
    );
  }
  const data = body.data;
  if (!isRecord(data)) {
    throw new IntranetLoginError(
      IntranetLoginFailureReason.InvalidResponse,
      'Login response is missing its data payload',
    );
  }
  const accessToken = readString(data[RESPONSE_ACCESS_TOKEN_FIELD]);
  if (!accessToken) {
    throw new IntranetLoginError(
      IntranetLoginFailureReason.InvalidResponse,
      'Login response is missing an access token',
    );
  }
  return {
    accessToken,
    // Downstream token refresh is out of scope for this change; fall back to the
    // access token so a session without a refresh token still stores a value.
    refreshToken: readString(data[RESPONSE_REFRESH_TOKEN_FIELD]) ?? accessToken,
    user: normalizeIntranetUser(data[RESPONSE_USER_FIELD], employeeId),
  };
}

export async function performIntranetCredentialLogin(options: {
  baseUrl: string;
  credentials: IntranetLoginCredentials;
  fetch: IntranetAuthFetch;
  timeoutMs?: number;
}): Promise<IntranetLoginSession> {
  const { url, init } = buildIntranetLoginRequest({
    baseUrl: options.baseUrl,
    credentials: options.credentials,
  });

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? REQUEST_TIMEOUT_MS);

  // Never log the credentials, the request body, or the response body.
  console.log('[Auth] requesting intranet credential login');

  try {
    const response = await options.fetch(url, { ...init, signal: controller.signal });
    const body: unknown = await response.json().catch((): null => null);
    if (!response.ok && !isRecord(body)) {
      throw new IntranetLoginError(
        IntranetLoginFailureReason.Network,
        `Login request failed with status ${response.status}`,
      );
    }
    return parseIntranetLoginResponse(body, options.credentials.employeeId);
  } catch (error) {
    if (error instanceof IntranetLoginError) {
      throw error;
    }
    if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
      console.warn('[Auth] intranet credential login timed out');
      throw new IntranetLoginError(
        IntranetLoginFailureReason.Timeout,
        'Login request timed out',
      );
    }
    console.warn('[Auth] intranet credential login failed:', error);
    throw new IntranetLoginError(
      IntranetLoginFailureReason.Network,
      'Login request failed',
    );
  } finally {
    clearTimeout(timeout);
  }
}
