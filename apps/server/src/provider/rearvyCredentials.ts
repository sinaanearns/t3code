import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePath } from "../pathExpansion.ts";

/**
 * Credentials the surrounding Rearvy app leaves for the coding agent.
 *
 * Somebody running Rearvy Code is already signed in to Rearvy — the app they
 * launched it from holds the session. Making them sign in a second time, or
 * paste a key, is asking for something the machine already knows. The Rearvy
 * app provisions a free key for the signed-in account and writes it here; this
 * process picks it up and the provider is simply ready.
 *
 * The shape is the familiar one (`~/.aws/credentials`, `gh`'s hosts file): a
 * well-known path any producer can write, so the dev launcher, the packaged
 * desktop app, and `t3 rearvy login` all feed the same slot.
 */

/** Overrides the default location, mainly so tests and sandboxes stay isolated. */
export const REARVY_CREDENTIALS_PATH_ENV = "REARVY_CREDENTIALS_FILE";

export const REARVY_DEFAULT_CREDENTIALS_PATH = "~/.rearvy/credentials.json";

/**
 * Reads the API key out of a credentials document.
 *
 * Tolerant of both spellings because the producers are separate codebases: the
 * website and desktop app speak snake_case, this one camelCase.
 */
export function parseRearvyCredentials(contents: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const candidate = record.apiKey ?? record.api_key;
  if (typeof candidate !== "string") {
    return null;
  }

  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveRearvyCredentialsPath(
  environment: NodeJS.ProcessEnv,
  path: Path.Path,
): string {
  const configured = environment[REARVY_CREDENTIALS_PATH_ENV]?.trim();
  return path.resolve(
    expandHomePath(
      configured && configured.length > 0 ? configured : REARVY_DEFAULT_CREDENTIALS_PATH,
    ),
  );
}

/**
 * Never fails: a missing, unreadable, or malformed credentials file simply
 * means no key from this source. It is one of several, and a broken file must
 * not take the provider down.
 */
export const readRearvyCredentialsKey = Effect.fn("provider.rearvy.read_credentials")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const credentialsPath = resolveRearvyCredentialsPath(environment, path);

  const contents = yield* fileSystem
    .readFileString(credentialsPath)
    .pipe(Effect.catch(() => Effect.succeed(null)));

  return contents === null ? null : parseRearvyCredentials(contents);
});

/**
 * Which credential the harness should use, in precedence order:
 *
 *   1. the key typed into Settings — an explicit choice outranks everything;
 *   2. a key already in the environment — how a launcher or CI injects one;
 *   3. the credentials file the Rearvy app wrote for the signed-in account.
 *
 * Returning null means genuinely unauthenticated, which is the only case where
 * the user should be asked to do anything.
 */
export function resolveRearvyApiKey(input: {
  settingsApiKey: string;
  environmentApiKey: string | undefined;
  credentialsApiKey: string | null;
}): string | null {
  const candidates = [
    input.settingsApiKey,
    input.environmentApiKey ?? "",
    input.credentialsApiKey ?? "",
  ];

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return null;
}
