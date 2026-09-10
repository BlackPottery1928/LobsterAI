// [INTRA-ONLY] Intranet deployment routing.
//
// Two things this build must reach on the intranet instead of over the public
// internet: the credential login (`/api/auth/login`) and the auto-update check
// (`/openapi/get/luna/hardware/lobsterai/{test,prod}/update[-manual]`).
// Everything else keeps the upstream addresses on purpose — the Lobster server
// origin is also the model-inference proxy base, so repointing it wholesale
// would take the whole app offline, not just the parts the intranet serves.
//
// Set `INTRANET_BASE_URL` to '' to restore the upstream origins without deleting
// any code. Delete this file and every `[INTRA-ONLY]` reference to it when
// merging upstream.
//
// The value must be a bare origin: `new URL(value).origin` drops any path, so
// `http://gw.corp/lobsterai` silently becomes `http://gw.corp` and every request
// 404s with no configuration error.
//
// This module is Electron-free on purpose so it can be unit tested directly,
// matching `developmentServerBaseUrl.ts`.

/**
 * Intranet origin used by this build. Change this line to deploy elsewhere; the
 * `LOBSTER_INTRANET_BASE_URL` environment variable overrides it at runtime
 * (usable for dev runs, but a Finder-launched .app on macOS does not inherit the
 * shell environment, so the compiled value is the production mechanism).
 */
export const INTRANET_BASE_URL = 'http://127.0.0.1:8080';

export const INTRANET_BASE_URL_ENV = 'LOBSTER_INTRANET_BASE_URL';

let loggedIntranetBaseUrl: string | null = null;

/**
 * Normalizes an intranet origin, or returns null when neither source is set.
 *
 * Unlike `resolveDevelopmentServerBaseUrl` there is no dev/packaged gate, no
 * loopback requirement and no explicit-port requirement: an intranet deployment
 * targets a real host, which is exactly what that override refused to allow in a
 * packaged build. A non-absolute or non-HTTP(S) value throws rather than
 * silently falling back, so a typo cannot send credentials to a public host.
 */
export function resolveIntranetBaseUrl(
  envValue: string | undefined,
  fallback: string,
): string | null {
  const candidate = envValue?.trim() || fallback.trim();
  if (!candidate) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(
      `${INTRANET_BASE_URL_ENV} must be an absolute URL, for example http://10.0.0.5:8080`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${INTRANET_BASE_URL_ENV} must use HTTP(S)`);
  }
  // `origin` drops any embedded credentials, query, hash and path.
  return url.origin;
}

/**
 * The effective intranet origin: the environment variable, else the compiled
 * default. `null` when the switch is off, in which case callers keep using the
 * upstream address.
 */
export const getIntranetBaseUrl = (): string | null => {
  const baseUrl = resolveIntranetBaseUrl(process.env[INTRANET_BASE_URL_ENV], INTRANET_BASE_URL);
  if (baseUrl && loggedIntranetBaseUrl !== baseUrl) {
    loggedIntranetBaseUrl = baseUrl;
    console.warn(`[Endpoints] routing intranet login and update traffic to ${baseUrl}`);
  }
  return baseUrl;
};
