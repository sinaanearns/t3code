import { describe, expect, it } from "@effect/vitest";

import { parseRearvyCredentials, resolveRearvyApiKey } from "./rearvyCredentials.ts";

describe("parseRearvyCredentials", () => {
  it("reads the key the Rearvy app wrote", () => {
    expect(parseRearvyCredentials(JSON.stringify({ apiKey: "rvy_abc" }))).toBe("rvy_abc");
  });

  it("accepts snake_case, since the producer is a different codebase", () => {
    expect(parseRearvyCredentials(JSON.stringify({ api_key: "rvy_abc" }))).toBe("rvy_abc");
  });

  it("ignores extra fields the producer may add later", () => {
    const contents = JSON.stringify({
      apiKey: "rvy_abc",
      accountEmail: "someone@example.com",
      updatedAt: "2026-09-02T00:00:00.000Z",
    });
    expect(parseRearvyCredentials(contents)).toBe("rvy_abc");
  });

  it("treats a broken or empty file as no credential rather than an error", () => {
    for (const contents of [
      "",
      "   ",
      "not json",
      "[]",
      "null",
      "{}",
      '{"apiKey":""}',
      '{"apiKey":123}',
    ]) {
      expect(parseRearvyCredentials(contents)).toBeNull();
    }
  });
});

describe("resolveRearvyApiKey", () => {
  it("prefers an explicitly configured key over everything else", () => {
    expect(
      resolveRearvyApiKey({
        settingsApiKey: "rvy_settings",
        environmentApiKey: "rvy_env",
        credentialsApiKey: "rvy_file",
      }),
    ).toBe("rvy_settings");
  });

  it("falls back to the environment when settings are empty", () => {
    expect(
      resolveRearvyApiKey({
        settingsApiKey: "   ",
        environmentApiKey: "rvy_env",
        credentialsApiKey: "rvy_file",
      }),
    ).toBe("rvy_env");
  });

  it("uses the signed-in account's credentials file as the last resort", () => {
    // The case that matters: nothing configured, but the user is already
    // signed in to Rearvy, so the app left a key behind.
    expect(
      resolveRearvyApiKey({
        settingsApiKey: "",
        environmentApiKey: undefined,
        credentialsApiKey: "rvy_file",
      }),
    ).toBe("rvy_file");
  });

  it("reports genuinely unauthenticated when no source has a key", () => {
    expect(
      resolveRearvyApiKey({
        settingsApiKey: "",
        environmentApiKey: "  ",
        credentialsApiKey: null,
      }),
    ).toBeNull();
  });

  it("trims whatever it returns", () => {
    expect(
      resolveRearvyApiKey({
        settingsApiKey: "  rvy_padded  ",
        environmentApiKey: undefined,
        credentialsApiKey: null,
      }),
    ).toBe("rvy_padded");
  });
});
