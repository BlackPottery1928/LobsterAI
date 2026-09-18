export const WeixinPlugin = {
  Id: 'openclaw-weixin',
  LoginStart: 'web.login.start',
  LoginWait: 'web.login.wait',
} as const;

export const WEIXIN_QR_ACTIVATION_TIMEOUT_MS = 10 * 60_000;

/** Stable, redacted diagnostics emitted by the pinned Weixin plugin patch. */
export const WeixinDeliveryError = {
  Rejected: 'WEIXIN_SEND_REJECTED',
  ContextExpired: 'WEIXIN_CONTEXT_EXPIRED',
  AccountExpired: 'WEIXIN_ACCOUNT_EXPIRED',
  InvalidResponse: 'WEIXIN_SEND_INVALID_RESPONSE',
  HttpError: 'WEIXIN_SEND_HTTP_ERROR',
  Unknown: 'WEIXIN_SEND_UNCONFIRMED',
  ReportUnavailable: 'WEIXIN_REPORT_UNAVAILABLE',
} as const;

export function sanitizeWeixinDeliveryError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/\bWEIXIN_[A-Z_]+(?: (?:ret|errcode|status)=-?\d+)*/);
  if (!match || !Object.values(WeixinDeliveryError).some(code => match[0].split(' ')[0] === code)) {
    return WeixinDeliveryError.Unknown;
  }
  return match[0];
}
