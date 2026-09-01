/**
 * RearvyDriver — `ProviderDriver` for Rearvy's own models.
 *
 * Rearvy is a model backend, not an agent harness. This driver therefore
 * reuses the Codex CLI as the local harness — the same adapter, session
 * runtime and text generation the `codex` driver uses — and redirects it at
 * Rearvy's OpenAI-wire API with a handful of `-c` config overrides:
 *
 *   model_provider              = rearvy
 *   model_providers.rearvy.*    = name / base_url / wire_api / env_key
 *
 * Those overrides live in `launchArgs` rather than `appServerArgs` on
 * purpose: `codexAppServerArgs` forwards them to `codex app-server` and
 * `codexExecLaunchArgs` filters them through to `codex exec`, so the session
 * runtime and the commit/PR text generation both talk to Rearvy. Putting them
 * on `appServerArgs` would cover only the former.
 *
 * The instance also gets its own CODEX_HOME (default `~/.rearvy-code`) so
 * Rearvy sessions, history and credentials never mix with the user's real
 * `~/.codex`.
 *
 * @module provider/Drivers/RearvyDriver
 */
import {
  ProviderDriverKind,
  REARVY_DEFAULT_HOME_PATH,
  RearvySettings,
  type CodexSettings,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCodexAdapter } from "../Layers/CodexAdapter.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { checkRearvyProviderStatus, makePendingRearvyProvider } from "../Layers/RearvyProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeRearvySettings = Schema.decodeSync(RearvySettings);

const DRIVER_KIND = ProviderDriverKind.make("rearvy");

/** Codex's config id for the provider these overrides declare. */
const REARVY_MODEL_PROVIDER_ID = "rearvy";
/** Env var Codex reads the bearer token from, per `model_providers.*.env_key`. */
export const REARVY_API_KEY_ENV = "REARVY_API_KEY";
/** Rearvy's default model, used when a turn arrives without a selection. */
const REARVY_FALLBACK_MODEL = "rearvy-coding";

/**
 * Codex parses each `-c` value as TOML and falls back to a raw string when
 * that fails. Single-quoting keeps values with spaces in one token through
 * `tokenizeCliArgs` and is a valid TOML literal string either way.
 */
function configOverride(key: string, value: string): string {
  return `-c ${key}='${value.replace(/'/g, "")}'`;
}

/**
 * Prefix Rearvy's provider overrides onto whatever the user configured, so a
 * user-supplied `-c` of the same key still wins (Codex takes the last one).
 */
export function buildRearvyLaunchArgs(config: RearvySettings): string {
  const baseUrl = config.baseUrl.trim();
  const overrides = [
    configOverride("model_provider", REARVY_MODEL_PROVIDER_ID),
    configOverride(`model_providers.${REARVY_MODEL_PROVIDER_ID}.name`, "Rearvy"),
    ...(baseUrl
      ? [configOverride(`model_providers.${REARVY_MODEL_PROVIDER_ID}.base_url`, baseUrl)]
      : []),
    configOverride(`model_providers.${REARVY_MODEL_PROVIDER_ID}.wire_api`, "responses"),
    configOverride(`model_providers.${REARVY_MODEL_PROVIDER_ID}.env_key`, REARVY_API_KEY_ENV),
  ];
  const userArgs = config.launchArgs.trim();
  return userArgs ? `${overrides.join(" ")} ${userArgs}` : overrides.join(" ");
}

/** Resolve this instance's isolated harness home to an absolute path. */
export function resolveRearvyHomePath(config: RearvySettings, path: Path.Path): string {
  const configured = config.homePath.trim();
  return path.resolve(
    expandHomePath(configured.length > 0 ? configured : REARVY_DEFAULT_HOME_PATH),
  );
}

/**
 * Project Rearvy settings onto the `CodexSettings` shape the shared harness
 * pieces consume. The API key is deliberately absent — it travels in the
 * process environment under `REARVY_API_KEY`, never on a command line where
 * it would land in process listings.
 */
function toHarnessConfig(config: RearvySettings, homePath: string): CodexSettings {
  return {
    enabled: config.enabled,
    binaryPath: config.binaryPath,
    homePath,
    shadowHomePath: "",
    launchArgs: buildRearvyLaunchArgs(config),
    customModels: config.customModels,
  };
}

export type RearvyDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const RearvyDriver: ProviderDriver<RearvySettings, RearvyDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Rearvy",
    supportsMultipleInstances: true,
  },
  configSchema: RearvySettings,
  defaultConfig: (): RearvySettings => decodeRearvySettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const homePath = resolveRearvyHomePath(config, path);

      // Codex refuses to start when CODEX_HOME points at a missing directory,
      // and this home is ours to own — the user never creates it by hand.
      yield* fileSystem.makeDirectory(homePath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to create the Rearvy harness home at '${homePath}': ${cause.message}`,
              cause,
            }),
        ),
      );

      const apiKey = config.apiKey.trim();
      const processEnv = {
        ...mergeProviderInstanceEnvironment(environment),
        ...(apiKey ? { [REARVY_API_KEY_ENV]: apiKey } : {}),
      };
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });

      const effectiveConfig = { ...config, enabled } satisfies RearvySettings;
      const harnessConfig = toHarnessConfig(effectiveConfig, homePath);

      const adapter = yield* makeCodexAdapter(harnessConfig, {
        instanceId,
        environment: processEnv,
        defaultModel: REARVY_FALLBACK_MODEL,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeCodexTextGeneration(harnessConfig, processEnv);

      // Pre-provide the spawner so the check satisfies
      // `makeManagedServerProvider.checkProvider`'s `R = never`.
      const checkProvider = checkRearvyProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<RearvySettings>>({
        // Updating the harness is the Codex provider's business, not
        // Rearvy's; there is no `rearvy` package to bump.
        maintenanceCapabilities: { provider: DRIVER_KIND, packageName: null, update: null },
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingRearvyProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Rearvy snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
