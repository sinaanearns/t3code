/**
 * URL construction for Rearvy account sign-in.
 *
 * Kept free of Effect and Node imports so the derivations can be tested
 * directly — getting these wrong sends a user's browser somewhere unexpected
 * with an authorization request attached.
 */

/** Where the loopback callback listens. Fixed so the redirect URI is knowable. */
export const REARVY_SIGN_IN_LOOPBACK_PORT = 7391;
export const REARVY_SIGN_IN_CALLBACK_PATH = "/rearvy/callback";

/**
 * Turns the configured API base URL into the site origin.
 *
 * Settings hold an API base (`https://www.rearvy.com/api/v1`) because that is
 * what the harness talks to, but sign-in happens on the website. Any `/api/...`
 * suffix is dropped rather than assumed to be exactly `/api/v1`, so a
 * self-hosted base with a different prefix still resolves.
 */
export function resolveRearvySiteOrigin(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const apiIndex = url.pathname.indexOf("/api");
  const basePath = apiIndex >= 0 ? url.pathname.slice(0, apiIndex) : url.pathname;
  const normalizedPath = basePath.replace(/\/+$/, "");

  return `${url.origin}${normalizedPath}`;
}

export function rearvyCallbackUrl(port: number = REARVY_SIGN_IN_LOOPBACK_PORT): string {
  return `http://127.0.0.1:${port}${REARVY_SIGN_IN_CALLBACK_PATH}`;
}

export function rearvyExchangeUrl(siteOrigin: string): string {
  return `${siteOrigin}/api/developer/keys/cli/exchange`;
}

/**
 * The consent page the user's browser opens. The verifier stays in this
 * process; only its challenge travels, so an observer of the redirect cannot
 * redeem the code.
 */
export function buildRearvyAuthorizeUrl(input: {
  siteOrigin: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  clientName: string;
}): string {
  const url = new URL(`${input.siteOrigin}/cli-auth`);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("state", input.state);
  url.searchParams.set("client_name", input.clientName);
  return url.toString();
}

export type RearvyCallbackVerdict = { ok: true; code: string } | { ok: false; reason: string };

/** Validates the callback query before anything is redeemed with it. */
export function readRearvyCallback(
  searchParams: URLSearchParams,
  expectedState: string,
): RearvyCallbackVerdict {
  const error = searchParams.get("error");
  if (error) {
    return { ok: false, reason: error.slice(0, 120) };
  }

  // Compared before the code is touched: a mismatched state means this callback
  // belongs to a different sign-in attempt.
  if (searchParams.get("state") !== expectedState) {
    return { ok: false, reason: "state_mismatch" };
  }

  const code = searchParams.get("code");
  if (!code || !/^[0-9a-f]{64}$/.test(code)) {
    return { ok: false, reason: "missing_code" };
  }

  return { ok: true, code };
}
