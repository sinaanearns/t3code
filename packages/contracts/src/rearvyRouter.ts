/**
 * Rearvy router contracts — Rearvy is not a provider, it is the thing that
 * picks one.
 *
 * Every other entry in the model picker names a harness the server can run:
 * Codex, Claude, Cursor, Grok, OpenCode. Rearvy names none of them. It is a
 * model in exactly one sense — you select it in the composer — and its only
 * job is to read the message you are about to send and answer two questions:
 * which installed provider should serve it, and which of that provider's
 * models. The turn then runs on the provider it named, as if you had picked
 * that provider yourself.
 *
 * The selection is therefore a *sentinel*, never a real instance. Nothing
 * downstream of the router may receive it: the client resolves
 * {@link REARVY_ROUTER_SELECTION} into a concrete `ModelSelection` through
 * `provider.route` before it starts a session or sends a turn, and the
 * session that results is bound to the chosen provider like any other.
 *
 * @module rearvyRouter
 */
import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import type { ModelSelection } from "./orchestration.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * Routing key the composer carries while Rearvy is selected.
 *
 * It is deliberately shaped like a real `ProviderInstanceId` so it can travel
 * inside a `ModelSelection` without widening that type, and deliberately
 * cannot collide with one: `defaultInstanceIdForDriver` never produces an id
 * containing `_router`, and no driver named `rearvy` ships any more.
 */
export const REARVY_ROUTER_INSTANCE_ID = ProviderInstanceId.make("rearvy_router");

/**
 * Driver kind carried by the router's picker entry.
 *
 * No driver registers it — that is the point. It exists so the client's
 * instance-shaped plumbing (icons, sorting, entry lookup) has a kind to key
 * on, and so any code that switches on a real driver kind falls through to its
 * default rather than mistaking the router for a harness.
 */
export const REARVY_ROUTER_DRIVER_KIND = ProviderDriverKind.make("rearvyRouter");

/** Model slug paired with {@link REARVY_ROUTER_INSTANCE_ID}. */
export const REARVY_ROUTER_MODEL = "rearvy-auto";

/** Sidebar label for the router's row in the model picker. */
export const REARVY_ROUTER_LABEL = "Rearvy";

/** Row title for the router's single "model". */
export const REARVY_ROUTER_MODEL_NAME = "Rearvy Auto";

/** One-line description rendered under the router row. */
export const REARVY_ROUTER_DESCRIPTION = "Picks the agent and model that fit each message.";

/** The composer selection that means "let Rearvy choose". */
export const REARVY_ROUTER_SELECTION: ModelSelection = {
  instanceId: REARVY_ROUTER_INSTANCE_ID,
  model: REARVY_ROUTER_MODEL,
};

/** Whether a routing key is the router sentinel rather than a real instance. */
export function isRearvyRouterInstanceId(
  instanceId: ProviderInstanceId | string | null | undefined,
): boolean {
  return instanceId === REARVY_ROUTER_INSTANCE_ID;
}

/**
 * Whether a selection asks Rearvy to choose.
 *
 * Guard every dispatch path with this: a sentinel that reaches
 * `ProviderService.startSession` resolves to no instance and fails the turn.
 */
export function isRearvyRouterSelection(
  selection: { readonly instanceId?: ProviderInstanceId | string | undefined } | null | undefined,
): boolean {
  return isRearvyRouterInstanceId(selection?.instanceId);
}

/** Longest prompt excerpt the router sends upstream to classify. */
export const REARVY_ROUTE_MAX_PROMPT_CHARS = 8_000;

/** Upper bound on candidates, so a fork with many instances cannot flood the API. */
export const REARVY_ROUTE_MAX_CANDIDATES = 32;

/** Upper bound on the models advertised per candidate. */
export const REARVY_ROUTE_MAX_MODELS_PER_CANDIDATE = 64;

const RearvyRouteCandidateModel = Schema.Struct({
  slug: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});

/**
 * One provider the router may choose, as the server sees it right now.
 *
 * Only ready, enabled instances are offered: the router picks among agents
 * the user can actually run, so it can never answer with a provider that is
 * not installed or is switched off.
 */
export const RearvyRouteCandidate = Schema.Struct({
  instanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  models: Schema.Array(RearvyRouteCandidateModel).check(
    Schema.isMaxLength(REARVY_ROUTE_MAX_MODELS_PER_CANDIDATE),
  ),
});
export type RearvyRouteCandidate = typeof RearvyRouteCandidate.Type;

/**
 * A routing question.
 *
 * `candidates` is computed server-side from the live provider snapshots, not
 * supplied by the client, so the answer is always constrained to what this
 * environment can run.
 */
export const RearvyRouteInput = Schema.Struct({
  /** The thread the routed turn belongs to. Routing is serialized per thread. */
  threadId: ThreadId,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(REARVY_ROUTE_MAX_PROMPT_CHARS)),
  /**
   * Restricts the answer to one instance. Set once a thread has a session:
   * the provider is fixed for the rest of the thread, so Rearvy chooses only
   * the model within it.
   */
  lockedInstanceId: Schema.optional(ProviderInstanceId),
});
export type RearvyRouteInput = typeof RearvyRouteInput.Type;

/**
 * The router's answer: a selection the composer can send unchanged, plus a
 * short human-readable reason so the choice is never silent.
 */
export const RearvyRouteResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  /** Provider label the UI shows alongside the model ("Claude", "Codex"). */
  providerLabel: TrimmedNonEmptyString,
  /** One sentence, shown in the composer: why this agent, for this message. */
  reason: Schema.String,
});
export type RearvyRouteResult = typeof RearvyRouteResult.Type;

export class RearvyRouteError extends Schema.TaggedErrorClass<RearvyRouteError>()(
  "RearvyRouteError",
  {
    detail: Schema.String,
    /**
     * True when the environment has no provider Rearvy could have chosen —
     * nothing installed, everything disabled. The client says "install or
     * enable a provider" rather than "Rearvy is down".
     */
    noCandidates: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
