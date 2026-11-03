// [INTRA-ONLY] Intranet permission-API login.
// Intranet builds authenticate with an employee ID (工号) plus password against
// the company permission service instead of the browser portal flow.
// Only the cross-process surface lives here; the request/response contract is
// in `src/main/libs/intranetAuthLogin.ts` next to the code that uses it.

export const IntranetAuthIpcChannel = {
  Login: 'intranetAuth:login',
} as const;

export type IntranetAuthIpcChannel =
  typeof IntranetAuthIpcChannel[keyof typeof IntranetAuthIpcChannel];

/** Failure tag the renderer turns into a localized message. */
export const IntranetLoginFailureReason = {
  InvalidCredentials: 'invalid_credentials',
  InvalidResponse: 'invalid_response',
  Network: 'network',
  Timeout: 'timeout',
} as const;

export type IntranetLoginFailureReason =
  typeof IntranetLoginFailureReason[keyof typeof IntranetLoginFailureReason];
