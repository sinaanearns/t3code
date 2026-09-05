/**
 * RearvyRouter — resolves the Rearvy composer selection into a real provider.
 *
 * Rearvy used to be a provider driver here: it ran the Codex CLI against
 * Rearvy's own model API and took a slot in the Providers list next to Claude
 * and Codex. It no longer is. Rearvy ships no harness, has no binary to probe
 * and no session of its own; it is the chooser that sits in front of the
 * harnesses the user has actually installed.
 *
 * One call, one decision:
 *
 *   1. Read the live provider snapshots and keep the instances a turn could
 *      really run on — enabled, available, `ready`, with at least one model.
 *   2. Ask Rearvy's API which of those fits the message about to be sent.
 *   3. Check the answer back against the candidate list and return it as a
 *      selection the composer can dispatch unchanged.
 *
 * Step 3 is what makes step 2 safe to trust. The API answers with names it
 * was given, but it is still a remote service answering in free-form JSON, so
 * an instance it names must be one we offered and a model it names must be
 * one that instance advertises — otherwise the turn would start against a
 * provider the user has not installed.
 *
 * The routing question is only asked when it has more than one answer. With a
 * single candidate model there is nothing to decide, and the network call is
 * skipped entirely — which is also what keeps a one-provider install working
 * while offline.
 *
 * @module provider/RearvyRouter
 */
import {
  isProviderAvailable,
  PROVIDER_DISPLAY_NAMES,
  type ProviderInstanceId,
  type RearvyRouteCandidate,
  RearvyRouteError,
  type RearvyRouteInput,
  type RearvyRouteResult,
  REARVY_ROUTE_MAX_CANDIDATES,
  REARVY_ROUTE_MAX_MODELS_PER_CANDIDATE,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { ProviderRegistry } from "./Services/ProviderRegistry.ts";

/** Rearvy's API root. Overridable so a fork or a staging build can retarget it. */
export const REARVY_API_BASE_URL_ENV = "REARVY_API_BASE_URL";
export const REARVY_DEFAULT_API_BASE_URL = "https://www.rearvy.com/api/v1";

/**
 * Optional bearer token. Routing is served on the free anonymous tier, so an
 * absent key is normal — it raises rate limits and attributes usage, it does
 * not gate the feature.
 */
export const REARVY_API_KEY_ENV = "REARVY_API_KEY";

/** Routing must not hold the composer. One decision, four seconds, or it fails. */
const ROUTE_TIMEOUT_MS = 4_000;

/**
 * Rearvy's answer. Snake case because this is the public REST shape, not an
 * internal contract; `reason` is optional so the API can stay terse.
 */
const RearvyRouteResponse = Schema.Struct({
  provider_instance_id: Schema.String,
  model: Schema.String,
  reason: Schema.optional(Schema.String),
});
type RearvyRouteResponse = typeof RearvyRouteResponse.Type;

export interface RearvyRouterShape {
  /**
   * Choose the provider instance and model that should serve `prompt`.
   *
   * Fails rather than guessing: a caller that cannot route should tell the
   * user Rearvy could not choose, not silently send the turn somewhere
   * arbitrary.
   */
  readonly route: (input: RearvyRouteInput) => Effect.Effect<RearvyRouteResult, RearvyRouteError>;
}

export class RearvyRouter extends Context.Service<RearvyRouter, RearvyRouterShape>()(
  "t3/provider/RearvyRouter",
) {}

function providerLabel(snapshot: ServerProvider): string {
  const configured = snapshot.displayName?.trim();
  if (configured) return configured;
  return PROVIDER_DISPLAY_NAMES[snapshot.driver] ?? snapshot.instanceId;
}

/**
 * Project the snapshot list onto the instances Rearvy is allowed to pick.
 *
 * Exported for tests: candidate selection is the half of routing that decides
 * what the user can possibly get, and it is worth pinning down without a
 * network in the way.
 */
export function toRouteCandidates(
  providers: ReadonlyArray<ServerProvider>,
  lockedInstanceId?: ProviderInstanceId | undefined,
): ReadonlyArray<RearvyRouteCandidate> {
  const candidates: Array<RearvyRouteCandidate> = [];

  for (const snapshot of providers) {
    if (lockedInstanceId !== undefined && snapshot.instanceId !== lockedInstanceId) continue;
    if (!snapshot.enabled) continue;
    if (!isProviderAvailable(snapshot)) continue;
    if (snapshot.status !== "ready") continue;

    const models = snapshot.models
      .slice(0, REARVY_ROUTE_MAX_MODELS_PER_CANDIDATE)
      .map((model) => ({ slug: model.slug, name: model.name || model.slug }));
    // An instance with no models cannot serve a turn, so offering it would
    // only give the router a way to answer with something unusable.
    if (models.length === 0) continue;

    candidates.push({
      instanceId: snapshot.instanceId,
      driverKind: snapshot.driver,
      displayName: providerLabel(snapshot),
      models,
    });
    if (candidates.length >= REARVY_ROUTE_MAX_CANDIDATES) break;
  }

  return candidates;
}

/** The model a candidate falls back to when the API names one it does not serve. */
function defaultModelFor(candidate: RearvyRouteCandidate): string {
  return candidate.models[0]!.slug;
}

/**
 * Reconcile Rearvy's answer with what we offered.
 *
 * Returns `null` when the answer names an instance that was not a candidate —
 * that is not a near-miss to be repaired, it is an answer to a question we
 * did not ask.
 */
export function resolveRouteResponse(
  response: RearvyRouteResponse,
  candidates: ReadonlyArray<RearvyRouteCandidate>,
): RearvyRouteResult | null {
  const requestedInstanceId = response.provider_instance_id.trim();
  const chosen = candidates.find((candidate) => candidate.instanceId === requestedInstanceId);
  if (chosen === undefined) return null;

  const requestedModel = response.model.trim();
  // A named model the instance does not advertise falls back to its first,
  // rather than failing the turn: the provider half of the decision is the
  // one the user notices, and it was answered correctly.
  const model = chosen.models.some((candidateModel) => candidateModel.slug === requestedModel)
    ? requestedModel
    : defaultModelFor(chosen);

  return {
    instanceId: chosen.instanceId,
    model,
    providerLabel: chosen.displayName,
    reason: response.reason?.trim() || `Routed to ${chosen.displayName}.`,
  };
}

function resolveBaseUrl(environment: NodeJS.ProcessEnv): string {
  const configured = environment[REARVY_API_BASE_URL_ENV]?.trim();
  return (configured || REARVY_DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}

/** Only what the decision needs: the message, and what it may be routed to. */
function toRequestPayload(prompt: string, candidates: ReadonlyArray<RearvyRouteCandidate>) {
  return {
    prompt,
    candidates: candidates.map((candidate) => ({
      provider_instance_id: candidate.instanceId,
      driver: candidate.driverKind,
      name: candidate.displayName,
      models: candidate.models.map((model) => ({ id: model.slug, name: model.name })),
    })),
  };
}

export const makeRearvyRouter = Effect.fn("makeRearvyRouter")(function* (options?: {
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const registry = yield* ProviderRegistry;
  const httpClient = yield* HttpClient.HttpClient;
  const environment = options?.environment ?? process.env;

  const askRearvy = Effect.fn("RearvyRouter.ask")(function* (
    prompt: string,
    candidates: ReadonlyArray<RearvyRouteCandidate>,
  ) {
    const apiKey = environment[REARVY_API_KEY_ENV]?.trim();
    const routeUrl = `${resolveBaseUrl(environment)}/route`;
    const baseRequest = HttpClientRequest.post(routeUrl);
    const request = apiKey ? HttpClientRequest.bearerToken(baseRequest, apiKey) : baseRequest;

    // Only transport failures are folded into one message here. A response
    // that arrives is inspected below, because "Rearvy said no" and "Rearvy
    // was not there" call for different things from the user and collapsing
    // them leaves nothing to act on.
    const httpResponse = yield* HttpClientRequest.bodyJson(
      request,
      toRequestPayload(prompt, candidates),
    ).pipe(
      Effect.flatMap(httpClient.execute),
      // The timeout wraps the request, not the error handling below it, so a
      // slow answer reads as `None` here rather than as an unreachable host.
      Effect.timeoutOption(ROUTE_TIMEOUT_MS),
      Effect.catchCause((cause) =>
        Effect.logWarning("Rearvy routing request failed.", cause).pipe(
          Effect.andThen(
            Effect.fail(
              new RearvyRouteError({
                detail: `Could not reach Rearvy at ${routeUrl} to choose an agent.`,
              }),
            ),
          ),
        ),
      ),
    );

    if (Option.isNone(httpResponse)) {
      return yield* new RearvyRouteError({
        detail: "Rearvy took too long to choose an agent.",
      });
    }

    const { status } = httpResponse.value;
    if (status === 404) {
      // The host answered, so the network is fine and the base URL resolves —
      // this build is pointed at a Rearvy that does not serve routing. Naming
      // the URL is the whole diagnosis.
      yield* Effect.logWarning("Rearvy has no routing endpoint at the configured base URL.", {
        url: routeUrl,
      });
      return yield* new RearvyRouteError({
        detail: `Rearvy has no routing endpoint at ${routeUrl}. Set ${REARVY_API_BASE_URL_ENV} to a Rearvy that serves it.`,
      });
    }
    if (status >= 400) {
      yield* Effect.logWarning("Rearvy refused the routing request.", { status, url: routeUrl });
      return yield* new RearvyRouteError({
        detail: `Rearvy refused the routing request (HTTP ${status}).`,
      });
    }

    const decoded = yield* HttpClientResponse.schemaBodyJson(RearvyRouteResponse)(
      httpResponse.value,
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Rearvy returned a routing answer we could not read.", cause).pipe(
          Effect.andThen(
            Effect.fail(
              new RearvyRouteError({ detail: "Rearvy returned an answer we could not read." }),
            ),
          ),
        ),
      ),
    );

    const resolved = resolveRouteResponse(decoded, candidates);
    if (resolved === null) {
      yield* Effect.logWarning("Rearvy routed to an instance that was not offered.", {
        instanceId: decoded.provider_instance_id,
      });
      return yield* new RearvyRouteError({
        detail: "Rearvy chose an agent that is not installed here.",
      });
    }

    return resolved;
  });

  const route: RearvyRouterShape["route"] = Effect.fn("RearvyRouter.route")(function* (input) {
    const providers = yield* registry.getProviders;
    const candidates = toRouteCandidates(providers, input.lockedInstanceId);

    if (candidates.length === 0) {
      return yield* new RearvyRouteError({
        detail:
          input.lockedInstanceId === undefined
            ? "No coding agent is installed and enabled for Rearvy to choose from."
            : "This thread's agent is no longer available.",
        noCandidates: true,
      });
    }

    // Nothing to decide, so nothing to ask. Keeps a single-provider install
    // working with no network and no latency on every send.
    const onlyCandidate = candidates[0]!;
    if (candidates.length === 1 && onlyCandidate.models.length === 1) {
      return {
        instanceId: onlyCandidate.instanceId,
        model: defaultModelFor(onlyCandidate),
        providerLabel: onlyCandidate.displayName,
        reason: `${onlyCandidate.displayName} is the only agent available.`,
      } satisfies RearvyRouteResult;
    }

    yield* Effect.annotateCurrentSpan({
      "rearvy.route.candidates": candidates.length,
      "rearvy.route.locked": input.lockedInstanceId !== undefined,
    });

    const result = yield* askRearvy(input.prompt, candidates);
    yield* Effect.annotateCurrentSpan({
      "rearvy.route.instance_id": result.instanceId,
      "rearvy.route.model": result.model,
    });
    return result;
  });

  return { route } satisfies RearvyRouterShape;
});

export const RearvyRouterLive: Layer.Layer<
  RearvyRouter,
  never,
  ProviderRegistry | HttpClient.HttpClient
> = Layer.effect(RearvyRouter, makeRearvyRouter());
