import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const withProviderInstances = (
  providerInstances: ServerSettings["providerInstances"],
): ServerSettings => ({ ...DEFAULT_SERVER_SETTINGS, providerInstances });

describe("deriveProviderInstanceConfigMap", () => {
  it("drops instances naming a driver this build has retired", () => {
    // Rearvy shipped as a provider driver before it became the router. An
    // install from that era still carries the envelope, and keeping it would
    // surface an unavailable card the user has no way to fix.
    const derived = deriveProviderInstanceConfigMap(
      withProviderInstances({
        [ProviderInstanceId.make("rearvy")]: {
          driver: ProviderDriverKind.make("rearvy"),
          config: { enabled: true },
        },
      }),
    );

    expect(Object.keys(derived)).not.toContain("rearvy");
  });

  it("keeps an instance whose driver this build still ships", () => {
    const derived = deriveProviderInstanceConfigMap(
      withProviderInstances({
        [ProviderInstanceId.make("codex_work")]: {
          driver: ProviderDriverKind.make("codex"),
          config: { enabled: true },
        },
      }),
    );

    expect(Object.keys(derived)).toContain("codex_work");
  });

  it("still synthesizes a default instance for every shipped driver", () => {
    const derived = deriveProviderInstanceConfigMap(withProviderInstances({}));

    expect(Object.keys(derived).toSorted()).toEqual(
      ["claudeAgent", "codex", "cursor", "grok", "opencode"].toSorted(),
    );
  });
});
