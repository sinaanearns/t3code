import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RearvySettings } from "@t3tools/contracts";

import { buildRearvyLaunchArgs } from "../Drivers/RearvyDriver.ts";
import {
  REARVY_BUILT_IN_MODELS,
  checkRearvyProviderStatus,
  hasRearvyApiKey,
  makePendingRearvyProvider,
  rearvyModelsFromSettings,
} from "./RearvyProvider.ts";

const decodeRearvySettings = Schema.decodeSync(RearvySettings);

/**
 * A binary whose `--version` is guaranteed to exist and exit 0 on every
 * platform CI runs on, so the probe's success path is reachable without
 * depending on a Codex install or on POSIX shell scripts.
 */
const RESOLVABLE_BINARY = process.execPath;

describe("rearvyModelsFromSettings", () => {
  it("serves Rearvy's four models with coding as the default", () => {
    const models = rearvyModelsFromSettings([]);

    expect(models.map((model) => model.slug)).toEqual([
      "rearvy-coding",
      "rearvy-auto",
      "rearvy-expert",
      "rearvy-general",
    ]);
    expect(models.filter((model) => model.isDefault).map((model) => model.slug)).toEqual([
      "rearvy-coding",
    ]);
    expect(models.every((model) => !model.isCustom)).toBe(true);
  });

  it("appends custom models after the built-ins without displacing them", () => {
    const models = rearvyModelsFromSettings(["rearvy-internal-preview"]);

    expect(models).toHaveLength(REARVY_BUILT_IN_MODELS.length + 1);
    const custom = models.at(-1);
    expect(custom?.slug).toBe("rearvy-internal-preview");
    expect(custom?.isCustom).toBe(true);
    expect(custom?.isDefault).toBeUndefined();
  });

  it("ignores a custom model that duplicates a built-in slug", () => {
    const models = rearvyModelsFromSettings(["rearvy-coding"]);

    expect(models).toHaveLength(REARVY_BUILT_IN_MODELS.length);
    expect(models.filter((model) => model.slug === "rearvy-coding")).toHaveLength(1);
  });
});

describe("hasRearvyApiKey", () => {
  // Always pass an explicit environment: the default is process.env, so a
  // developer machine with REARVY_API_KEY exported would otherwise flip these.
  const noEnv: NodeJS.ProcessEnv = {};

  it("treats whitespace as no key at all", () => {
    expect(hasRearvyApiKey(decodeRearvySettings({ apiKey: "   " }), noEnv)).toBe(false);
    expect(hasRearvyApiKey(decodeRearvySettings({ apiKey: "rk_live" }), noEnv)).toBe(true);
  });

  it("accepts a key from the environment the harness is spawned with", () => {
    // RearvyDriver merges the ambient process environment (and per-instance env
    // vars) into the spawn env, so a key supplied that way already works.
    expect(
      hasRearvyApiKey(decodeRearvySettings({ apiKey: "" }), { REARVY_API_KEY: "rk_env" }),
    ).toBe(true);
  });

  it("ignores an environment key that is only whitespace", () => {
    expect(hasRearvyApiKey(decodeRearvySettings({ apiKey: "" }), { REARVY_API_KEY: "   " })).toBe(
      false,
    );
  });
});

describe("buildRearvyLaunchArgs", () => {
  it("points the Codex harness at Rearvy without leaking the key onto the command line", () => {
    const args = buildRearvyLaunchArgs(
      decodeRearvySettings({ apiKey: "rk_secret", baseUrl: "https://example.test/api/v1" }),
    );

    expect(args).toContain("-c model_provider='rearvy'");
    expect(args).toContain("-c model_providers.rearvy.base_url='https://example.test/api/v1'");
    expect(args).toContain("-c model_providers.rearvy.wire_api='responses'");
    expect(args).toContain("-c model_providers.rearvy.env_key='REARVY_API_KEY'");
    // The key travels in the environment; a command line is world-readable.
    expect(args).not.toContain("rk_secret");
  });

  it("keeps user arguments last so their overrides win", () => {
    const args = buildRearvyLaunchArgs(
      decodeRearvySettings({ launchArgs: "-c model_reasoning_effort=high" }),
    );

    expect(args.endsWith("-c model_reasoning_effort=high")).toBe(true);
  });
});

describe("makePendingRearvyProvider", () => {
  it.effect("reports the models even before the harness has been probed", () =>
    Effect.gen(function* () {
      const snapshot = yield* makePendingRearvyProvider(decodeRearvySettings({ enabled: true }));

      expect(snapshot.displayName).toBe("Rearvy");
      expect(snapshot.status).toBe("warning");
      expect(snapshot.models.map((model) => model.slug)).toContain("rearvy-coding");
    }),
  );
});

it.layer(NodeServices.layer)("checkRearvyProviderStatus", (it) => {
  it.effect("stays disabled without probing when the provider is off", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkRearvyProviderStatus(
        decodeRearvySettings({ enabled: false, binaryPath: "/definitely/not/installed/codex" }),
      );

      expect(snapshot.enabled).toBe(false);
      expect(snapshot.installed).toBe(false);
      // `buildServerProvider` forces "disabled" whenever `enabled` is false.
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.message).toContain("disabled");
      // A disabled provider still advertises what it would serve.
      expect(snapshot.models.map((model) => model.slug)).toContain("rearvy-coding");
    }),
  );

  it.effect("reports the harness as missing when the binary does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkRearvyProviderStatus(
        decodeRearvySettings({
          enabled: true,
          apiKey: "rk_live",
          binaryPath: "/definitely/not/installed/codex",
        }),
      );

      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("Codex CLI");
    }),
  );

  it.effect("is ready with no credential at all", () =>
    Effect.gen(function* () {
      // Rearvy models are free and served anonymously, so an unsigned-in user
      // is not a broken state and must not be asked to do anything.
      const snapshot = yield* checkRearvyProviderStatus(
        decodeRearvySettings({ enabled: true, binaryPath: RESOLVABLE_BINARY, apiKey: "" }),
        {},
      );

      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
    }),
  );

  it("does not mistake the anonymous placeholder for a real key", () => {
    // The driver always populates REARVY_API_KEY, so presence alone would
    // otherwise report an anonymous session as a signed-in one.
    const settings = decodeRearvySettings({ apiKey: "" });

    expect(hasRearvyApiKey(settings, { REARVY_API_KEY: "anonymous" })).toBe(false);
    expect(hasRearvyApiKey(settings, { REARVY_API_KEY: "rvy_real" })).toBe(true);
  });

  it.effect("is ready when the environment already supplies a key", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkRearvyProviderStatus(
        decodeRearvySettings({ enabled: true, binaryPath: RESOLVABLE_BINARY, apiKey: "" }),
        { REARVY_API_KEY: "rvy_from_environment" },
      );

      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.status).toBe("ready");
    }),
  );

  it.effect("becomes ready once the API key is present", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkRearvyProviderStatus(
        decodeRearvySettings({ enabled: true, binaryPath: RESOLVABLE_BINARY, apiKey: "rk_live" }),
      );

      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "rearvy-coding",
        "rearvy-auto",
        "rearvy-expert",
        "rearvy-general",
      ]);
    }),
  );
});
