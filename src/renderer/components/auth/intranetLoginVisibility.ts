// [INTRA-ONLY] Route login through the intranet permission API (employee ID +
// password, entered in an in-app form) instead of the system-browser portal
// handoff used by upstream builds.
// Set to false to restore; delete this file and every
// `INTRANET_CREDENTIAL_LOGIN_ENABLED` reference when merging upstream.
export const INTRANET_CREDENTIAL_LOGIN_ENABLED = true;
