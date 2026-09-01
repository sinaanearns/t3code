import { describe, expect, it } from "@effect/vitest";

import {
  REARVY_SIGN_IN_LOOPBACK_PORT,
  buildRearvyAuthorizeUrl,
  readRearvyCallback,
  rearvyCallbackUrl,
  rearvyExchangeUrl,
  resolveRearvySiteOrigin,
} from "./rearvySignInUrls.ts";

describe("resolveRearvySiteOrigin", () => {
  it("drops the API path so sign-in lands on the website", () => {
    expect(resolveRearvySiteOrigin("https://www.rearvy.com/api/v1")).toBe("https://www.rearvy.com");
    expect(resolveRearvySiteOrigin("https://www.rearvy.com/api/v2/")).toBe(
      "https://www.rearvy.com",
    );
  });

  it("keeps a self-hosted path prefix that sits above the API", () => {
    expect(resolveRearvySiteOrigin("https://host.test/rearvy/api/v1")).toBe(
      "https://host.test/rearvy",
    );
  });

  it("tolerates a base URL with no API suffix at all", () => {
    expect(resolveRearvySiteOrigin("https://www.rearvy.com")).toBe("https://www.rearvy.com");
  });

  it("refuses values that are not usable http(s) URLs", () => {
    expect(resolveRearvySiteOrigin("")).toBeNull();
    expect(resolveRearvySiteOrigin("   ")).toBeNull();
    expect(resolveRearvySiteOrigin("not a url")).toBeNull();
    expect(resolveRearvySiteOrigin("ftp://rearvy.com/api/v1")).toBeNull();
  });
});

describe("buildRearvyAuthorizeUrl", () => {
  const authorizeUrl = new URL(
    buildRearvyAuthorizeUrl({
      siteOrigin: "https://www.rearvy.com",
      redirectUri: rearvyCallbackUrl(),
      codeChallenge: "a".repeat(43),
      state: "state-value",
      clientName: "Rearvy Coding Agent",
    }),
  );

  it("targets the consent page and carries the loopback redirect", () => {
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe("https://www.rearvy.com/cli-auth");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      `http://127.0.0.1:${REARVY_SIGN_IN_LOOPBACK_PORT}/rearvy/callback`,
    );
  });

  it("sends the challenge but never the verifier", () => {
    expect(authorizeUrl.searchParams.get("code_challenge")).toBe("a".repeat(43));
    expect(authorizeUrl.toString()).not.toContain("code_verifier");
  });

  it("carries the state used to match the callback", () => {
    expect(authorizeUrl.searchParams.get("state")).toBe("state-value");
  });
});

describe("rearvyExchangeUrl", () => {
  it("points at the public exchange endpoint", () => {
    expect(rearvyExchangeUrl("https://www.rearvy.com")).toBe(
      "https://www.rearvy.com/api/developer/keys/cli/exchange",
    );
  });
});

describe("readRearvyCallback", () => {
  const code = "b".repeat(64);

  it("accepts a well-formed callback", () => {
    const params = new URLSearchParams({ code, state: "expected" });
    expect(readRearvyCallback(params, "expected")).toEqual({ ok: true, code });
  });

  it("refuses a callback for a different sign-in attempt", () => {
    const params = new URLSearchParams({ code, state: "other" });
    expect(readRearvyCallback(params, "expected")).toEqual({ ok: false, reason: "state_mismatch" });
  });

  it("refuses a callback with no state at all", () => {
    expect(readRearvyCallback(new URLSearchParams({ code }), "expected")).toEqual({
      ok: false,
      reason: "state_mismatch",
    });
  });

  it("surfaces an error the consent page reported", () => {
    const params = new URLSearchParams({ error: "access_denied", state: "expected" });
    expect(readRearvyCallback(params, "expected")).toEqual({
      ok: false,
      reason: "access_denied",
    });
  });

  it("refuses a missing or malformed code", () => {
    expect(readRearvyCallback(new URLSearchParams({ state: "expected" }), "expected")).toEqual({
      ok: false,
      reason: "missing_code",
    });
    expect(
      readRearvyCallback(new URLSearchParams({ state: "expected", code: "nope" }), "expected"),
    ).toEqual({ ok: false, reason: "missing_code" });
  });
});
