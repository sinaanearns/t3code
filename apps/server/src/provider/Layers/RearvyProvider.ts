/**
 * RearvyProvider — snapshot + probe for the `rearvy` driver kind.
 *
 * Rearvy does not ship its own agent harness. It runs the Codex CLI locally
 * (file edits, shell, approvals) and points it at Rearvy's own OpenAI-wire API
 * for the model itself, so the probe here answers two questions the Codex
 * probe cannot:
 *
 *   1. Is the harness binary present? — a plain `codex --version`, rather than
 *      a full `app-server` boot. Codex's own `model/list` would report
 *      OpenAI's catalog, which is not what this provider serves.
 *   2. Can we reach Rearvy? — that is the configured API key, not the
 *      `auth.json` inside CODEX_HOME that the Codex probe reads.
 *
 * @module provider/Layers/RearvyProvider
 */
import {
  type ModelCapabilities,
  type RearvySettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const REARVY_PRESENTATION = {
  displayName: "Rearvy",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;

/**
 * Rearvy's published catalog, mirroring `PUBLIC_MODELS` in the website's
 * `src/lib/developer/public-models.ts` by hand — the two live in independent
 * apps with no shared package, so a model added there has to be added here
 * too. Slugs are the ids the API addresses; the rest is presentation.
 */
export const REARVY_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "rearvy-coding",
    name: "Rearvy Coding",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "rearvy-auto",
    name: "Rearvy Auto",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "rearvy-expert",
    name: "Rearvy Expert 2.7",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "rearvy-general",
    name: "Rearvy General 5.5",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function rearvyModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(REARVY_BUILT_IN_MODELS, customModels ?? [], EMPTY_CAPABILITIES);
}

/**
 * Env var Codex reads the bearer token from, per `model_providers.*.env_key`.
 * Declared here rather than in the driver because the probe needs it too, and
 * the driver already imports this module.
 */
export const REARVY_API_KEY_ENV = "REARVY_API_KEY";

/**
 * Sent when nobody is signed in.
 *
 * Codex requires the variable named by `model_providers.*.env_key` to exist, so
 * the harness needs *something* to send. Rearvy only recognises credentials in
 * its own `rvy_` key format, so this value reads as no credential at all and the
 * request is served on the free anonymous tier.
 */
export const REARVY_ANONYMOUS_API_KEY = "anonymous";

/**
 * An API key is the only credential this provider has; there is no OAuth.
 *
 * The Settings field is not the only way to supply it. `RearvyDriver` spawns
 * the harness with the ambient process environment merged in, plus any
 * per-instance env vars, so a `REARVY_API_KEY` from either source authenticates
 * every request. Checking only the settings field made the probe report
 * "unauthenticated" for a perfectly working setup and told the user to paste a
 * key they had already provided.
 */
export function hasRearvyApiKey(
  rearvySettings: RearvySettings,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (rearvySettings.apiKey.trim().length > 0) {
    return true;
  }

  // The driver always populates this variable, using the anonymous placeholder
  // when nobody is signed in, so its mere presence proves nothing.
  const fromEnvironment = environment[REARVY_API_KEY_ENV]?.trim() ?? "";
  return fromEnvironment.length > 0 && fromEnvironment !== REARVY_ANONYMOUS_API_KEY;
}

export function makePendingRearvyProvider(
  rearvySettings: RearvySettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = rearvyModelsFromSettings(rearvySettings.customModels);

    if (!rearvySettings.enabled) {
      return buildServerProvider({
        presentation: REARVY_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Rearvy is disabled in Rearvy Coding Agent settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: REARVY_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking the Rearvy agent harness...",
      },
    });
  });
}

const runHarnessVersionCommand = (
  rearvySettings: RearvySettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = rearvySettings.binaryPath || "codex";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkRearvyProviderStatus = Effect.fn("checkRearvyProviderStatus")(function* (
  rearvySettings: RearvySettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = rearvyModelsFromSettings(rearvySettings.customModels);
  const harnessBinary = rearvySettings.binaryPath || "codex";

  if (!rearvySettings.enabled) {
    return buildServerProvider({
      presentation: REARVY_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Rearvy is disabled in Rearvy Coding Agent settings.",
      },
    });
  }

  const versionResult = yield* runHarnessVersionCommand(rearvySettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    const installed = !isCommandMissingCause(error);
    yield* Effect.logWarning("Rearvy agent harness health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: REARVY_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: installed
          ? "Failed to execute the Rearvy agent harness health check."
          : `Rearvy runs on the Codex CLI, but \`${harnessBinary}\` was not found on PATH.`,
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: REARVY_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `Rearvy's agent harness timed out while running \`${harnessBinary} --version\`.`,
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);

  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Rearvy harness version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
    });
    return buildServerProvider({
      presentation: REARVY_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Rearvy's agent harness is installed but failed to run.",
      },
    });
  }

  // Rearvy models are free and served without an account, so a missing
  // credential is not a problem to report — the provider is ready either way.
  // A key only raises the rate limit and attributes usage, so it is reported as
  // the difference between "signed in" and "anonymous", not ready and broken.
  const authenticated = hasRearvyApiKey(rearvySettings, environment);

  return buildServerProvider({
    presentation: REARVY_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: authenticated
        ? { status: "authenticated", type: "api_key", label: "Rearvy API key" }
        : { status: "authenticated", type: "api_key", label: "Rearvy (free, no sign-in)" },
    },
  });
});
