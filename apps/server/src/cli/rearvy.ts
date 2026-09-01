import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import { REARVY_CODING_AGENT_BASE_NAME } from "@t3tools/shared/rearvyBranding";

import { RearvySignInError, signInToRearvy } from "../provider/RearvySignIn.ts";

/**
 * `t3 rearvy login` — connect a Rearvy account without handling a key.
 *
 * Providers in this app authenticate out of band (`codex login`, `claude
 * login`) and the probe reports what it finds; Rearvy follows the same shape
 * rather than inventing an in-app credential form.
 */
const loginCommand = Command.make("login").pipe(
  Command.withDescription(
    `Sign in to Rearvy so ${REARVY_CODING_AGENT_BASE_NAME} can use Rearvy models.`,
  ),
  Command.withHandler(() =>
    signInToRearvy().pipe(
      Effect.asVoid,
      Effect.catchTag("RearvySignInError", (error: RearvySignInError) =>
        Console.error(`Rearvy sign-in failed: ${error.detail}`).pipe(
          Effect.andThen(Effect.fail(error)),
        ),
      ),
    ),
  ),
);

export const rearvyCommand = Command.make("rearvy").pipe(
  Command.withDescription("Manage the Rearvy account this server uses."),
  Command.withSubcommands([loginCommand]),
);
