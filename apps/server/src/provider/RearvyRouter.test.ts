import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import { resolveRouteResponse, toRouteCandidates } from "./RearvyRouter.ts";

const makeProvider = ({
  instanceId,
  ...overrides
}: Partial<Omit<ServerProvider, "instanceId">> & { instanceId: string }): ServerProvider => ({
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [
    { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-luna", name: "GPT-5.6 Luna", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
  ...overrides,
  instanceId: ProviderInstanceId.make(instanceId),
});

describe("toRouteCandidates", () => {
  it("offers only instances a turn could actually run on", () => {
    const candidates = toRouteCandidates([
      makeProvider({ instanceId: "codex" }),
      makeProvider({ instanceId: "claude_disabled", enabled: false }),
      makeProvider({ instanceId: "grok_broken", status: "error" }),
      makeProvider({ instanceId: "fork_missing", availability: "unavailable", enabled: true }),
      makeProvider({ instanceId: "opencode_empty", models: [] }),
    ]);

    expect(candidates.map((candidate) => candidate.instanceId)).toEqual(["codex"]);
  });

  it("narrows to the bound instance once a thread has a session", () => {
    const candidates = toRouteCandidates(
      [
        makeProvider({ instanceId: "codex" }),
        makeProvider({
          instanceId: "claudeAgent",
          driver: ProviderDriverKind.make("claudeAgent"),
        }),
      ],
      ProviderInstanceId.make("claudeAgent"),
    );

    expect(candidates.map((candidate) => candidate.instanceId)).toEqual(["claudeAgent"]);
  });

  it("labels a candidate by its configured display name", () => {
    const [candidate] = toRouteCandidates([
      makeProvider({ instanceId: "codex_work", displayName: "Codex (work)" }),
    ]);

    expect(candidate?.displayName).toBe("Codex (work)");
  });

  it("falls back to the driver's product name when an instance has none", () => {
    const [candidate] = toRouteCandidates([
      makeProvider({ instanceId: "claudeAgent", driver: ProviderDriverKind.make("claudeAgent") }),
    ]);

    expect(candidate?.displayName).toBe("Claude");
  });
});

describe("resolveRouteResponse", () => {
  const candidates = toRouteCandidates([
    makeProvider({ instanceId: "codex" }),
    makeProvider({
      instanceId: "claudeAgent",
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Claude",
      models: [
        { slug: "claude-opus-5", name: "Claude Opus 5", isCustom: false, capabilities: null },
      ],
    }),
  ]);

  it("accepts an answer naming an offered instance and one of its models", () => {
    const resolved = resolveRouteResponse(
      {
        provider_instance_id: "claudeAgent",
        model: "claude-opus-5",
        reason: "Multi-file refactor.",
      },
      candidates,
    );

    expect(resolved).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5",
      providerLabel: "Claude",
      reason: "Multi-file refactor.",
    });
  });

  it("keeps the chosen agent and repairs a model it does not serve", () => {
    const resolved = resolveRouteResponse(
      { provider_instance_id: "claudeAgent", model: "gpt-5.6-sol" },
      candidates,
    );

    expect(resolved?.instanceId).toBe("claudeAgent");
    expect(resolved?.model).toBe("claude-opus-5");
  });

  it("rejects an answer naming an instance that was never offered", () => {
    expect(
      resolveRouteResponse({ provider_instance_id: "cursor", model: "composer-2" }, candidates),
    ).toBeNull();
  });

  it("supplies a reason when the answer omits one", () => {
    const resolved = resolveRouteResponse(
      { provider_instance_id: "codex", model: "gpt-5.6-luna", reason: "   " },
      candidates,
    );

    expect(resolved?.reason).toBe("Routed to Codex.");
  });
});
