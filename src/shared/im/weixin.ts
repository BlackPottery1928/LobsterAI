export const WeixinPlugin = {
  Id: 'openclaw-weixin',
  LoginStart: 'web.login.start',
  LoginWait: 'web.login.wait',
} as const;

export const WEIXIN_QR_ACTIVATION_TIMEOUT_MS = 10 * 60_000;
