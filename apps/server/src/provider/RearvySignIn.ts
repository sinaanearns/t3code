// @effect-diagnostics nodeBuiltinImport:off - The loopback sign-in callback is a Node HTTP boundary.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Terminal from "effect/Terminal";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { REARVY_CODING_AGENT_BASE_NAME } from "@t3tools/shared/rearvyBranding";

import * as ExternalLauncher from "../process/externalLauncher.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { waitForLoopbackAuthorization } from "../cloud/CliTokenManager.ts";
import { renderLoopbackAuthorizationCompleteHtml } from "../cloud/cliAuthHtml.ts";
import {
  REARVY_SIGN_IN_LOOPBACK_PORT,
  REARVY_SIGN_IN_CALLBACK_PATH,
  buildRearvyAuthorizeUrl,
  readRearvyCallback,
  rearvyCallbackUrl,
  rearvyExchangeUrl,
  resolveRearvySiteOrigin,
} from "./rearvySignInUrls.ts";

const SIGN_IN_CALLBACK_TIMEOUT = Duration.minutes(10);

export class RearvySignInError extends Data.TaggedError("RearvySignInError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message() {
    return this.detail;
  }
}

const ExchangeResponse = Schema.Struct({
  api_key: Schema.String,
});

/**
 * Signs the user in to Rearvy and stores the API key the website issues.
 *
 * Rearvy keys are free, so nothing here is a purchase decision — the point is
 * that the user approves once in a browser they already trust and never handles
 * the credential. The shape is a standard PKCE authorization-code flow against
 * a loopback redirect, matching how T3 Connect authorizes, so the key is never
 * carried in a URL and only this process can redeem the code.
 */
export const signInToRearvy = Effect.fn("provider.rearvy.sign_in")(function* () {
  const settingsService = yield* ServerSettingsService;
  const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
  const terminal = yield* Terminal.Terminal;
  const crypto = yield* Crypto.Crypto;
  const httpClient = yield* HttpClient.HttpClient;

  const settings = yield* settingsService.getSettings.pipe(
    Effect.mapError(
      (cause) => new RearvySignInError({ detail: "Could not read settings.", cause }),
    ),
  );

  const siteOrigin = resolveRearvySiteOrigin(settings.providers.rearvy.baseUrl);
  if (!siteOrigin) {
    return yield* new RearvySignInError({
      detail: "The Rearvy base URL in settings is not a valid URL.",
    });
  }

  const verifier = Encoding.encodeBase64Url(yield* crypto.randomBytes(32));
  const codeChallenge = Encoding.encodeBase64Url(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const state = Encoding.encodeBase64Url(yield* crypto.randomBytes(16));

  const redirectUri = rearvyCallbackUrl();
  const callback = yield* Deferred.make<string, RearvySignInError>();

  const callbackRoute = HttpRouter.add(
    "GET",
    REARVY_SIGN_IN_CALLBACK_PATH,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.originalUrl, redirectUri);
      const verdict = readRearvyCallback(url.searchParams, state);

      if (!verdict.ok) {
        yield* Deferred.fail(
          callback,
          new RearvySignInError({ detail: `Sign-in was not completed (${verdict.reason}).` }),
        );
        return HttpServerResponse.text("Invalid Rearvy sign-in callback.", { status: 400 });
      }

      yield* Deferred.succeed(callback, verdict.code);
      return HttpServerResponse.html(renderLoopbackAuthorizationCompleteHtml());
    }),
  );

  yield* HttpRouter.serve(callbackRoute, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(
      NodeHttpServer.layer(NodeHttp.createServer, {
        host: "127.0.0.1",
        port: REARVY_SIGN_IN_LOOPBACK_PORT,
        disablePreemptiveShutdown: true,
      }),
    ),
    Layer.build,
    Effect.mapError(
      (cause) =>
        new RearvySignInError({
          detail: `Could not listen on 127.0.0.1:${REARVY_SIGN_IN_LOOPBACK_PORT} for the sign-in callback. Close whatever is using that port and try again.`,
          cause,
        }),
    ),
  );

  const authorizationUrl = buildRearvyAuthorizeUrl({
    siteOrigin,
    redirectUri,
    codeChallenge,
    state,
    clientName: REARVY_CODING_AGENT_BASE_NAME,
  });

  yield* Console.log(
    [
      "Open this URL to connect your Rearvy account:",
      `  ${authorizationUrl}`,
      "",
      "Press Enter to open it in your browser.",
    ].join("\n"),
  );

  const authorization = yield* waitForLoopbackAuthorization({
    authorizationUrl,
    callback: Deferred.await(callback).pipe(
      Effect.timeout(SIGN_IN_CALLBACK_TIMEOUT),
      Effect.catchTag(
        "TimeoutError",
        (cause) =>
          new RearvySignInError({ detail: "Timed out waiting for sign-in to finish.", cause }),
      ),
    ),
    terminal,
    launchBrowser: externalLauncher.launchBrowser,
  });

  if (authorization._tag === "HeadlessRequested") {
    return yield* new RearvySignInError({
      detail: `Rearvy sign-in needs a browser. Open the URL above on any device, then re-run it here.`,
    });
  }

  // Server-to-server: the verifier proves this is the process that started the
  // flow, so the code alone is useless to anyone who observed the redirect.
  const response = yield* HttpClientRequest.post(rearvyExchangeUrl(siteOrigin)).pipe(
    HttpClientRequest.bodyJson({ code: authorization.code, code_verifier: verifier }),
    Effect.flatMap(httpClient.execute),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ExchangeResponse)),
    Effect.mapError(
      (cause) =>
        new RearvySignInError({
          detail: "Rearvy did not return an API key for this sign-in.",
          cause,
        }),
    ),
  );

  yield* settingsService
    .updateSettings({ providers: { rearvy: { apiKey: response.api_key, enabled: true } } })
    .pipe(
      Effect.mapError(
        (cause) => new RearvySignInError({ detail: "Could not save the Rearvy API key.", cause }),
      ),
    );

  yield* Console.log(`Connected. ${REARVY_CODING_AGENT_BASE_NAME} can now use Rearvy models.`);

  return { connected: true as const };
});
