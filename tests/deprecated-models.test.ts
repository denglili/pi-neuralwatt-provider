import { describe, expect, it } from "vitest";
import { buildModels } from "../index";

// Grace-period deprecated models (deprecated-models.json) must go through the
// same buildModels pipeline as live models: seeded into the base list, then
// patch.json entries and user modelOverrides applied on top. The graveyard
// data is injected so these tests never age against the repo's real
// deprecated-models.json fixture.

const SECOND_MS = 1000;
const DAY_MS = 24 * 60 * 60 * SECOND_MS;

const liveModel: any = {
  id: "live-model",
  name: "Live Model",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 8192,
};

function ghostModel(deprecatedAt: string): any {
  return {
    id: "ghost-model",
    name: "Ghost Model",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.5, output: 1, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 65536,
    maxTokens: 8192,
    compat: { supportsDeveloperRole: false },
    deprecatedAt,
  };
}

// Patch entry shaped like the real ones (thinkingLevelMap + compat merge).
const GHOST_PATCH: Record<string, any> = {
  "ghost-model": {
    thinkingLevelMap: { minimal: null, low: "low", medium: "high", high: "high", max: "max" },
    compat: { requiresReasoningContentOnAssistantMessages: true },
  },
};

describe("buildModels and the deprecated-models grace period", () => {
  it("serves in-grace deprecated models with their patch.json overrides applied", () => {
    const recent = new Date(Date.now() - 60 * SECOND_MS).toISOString();
    const models = buildModels([liveModel], [], GHOST_PATCH, {}, { "ghost-model": ghostModel(recent) });

    const ghost = models.find((m) => m.id === "ghost-model");
    expect(ghost).toBeDefined();
    // Patch applied on top of the graveyard snapshot...
    expect(ghost!.thinkingLevelMap?.medium).toBe("high");
    expect(ghost!.compat?.requiresReasoningContentOnAssistantMessages).toBe(true);
    // ...deep-merged with the graveyard's own compat (not replaced)...
    expect(ghost!.compat?.supportsDeveloperRole).toBe(false);
    // ...carrying the graveyard's base data...
    expect(ghost!.cost.input).toBe(0.5);
    // ...without leaking deprecation metadata into the registered model.
    expect(ghost).not.toHaveProperty("deprecatedAt");
  });

  it("does not serve deprecated models past the 14-day grace period", () => {
    const expired = new Date(Date.now() - 15 * DAY_MS).toISOString();
    const models = buildModels([liveModel], [], GHOST_PATCH, {}, { "ghost-model": ghostModel(expired) });
    expect(models.find((m) => m.id === "ghost-model")).toBeUndefined();
    expect(models.map((m) => m.id)).toEqual(["live-model"]);
  });

  it("live base data wins over a graveyard entry with the same id", () => {
    const resurrected = { ...ghostModel(new Date(Date.now() - 60 * SECOND_MS).toISOString()), id: "live-model" };
    const models = buildModels([liveModel], [], {}, {}, { "live-model": resurrected });
    const live = models.filter((m) => m.id === "live-model");
    expect(live).toHaveLength(1);
    expect(live[0].cost.input).toBe(1); // base value, not the graveyard snapshot's 0.5
  });

  it("applies user modelOverrides to grace-period deprecated models", () => {
    const recent = new Date(Date.now() - 60 * SECOND_MS).toISOString();
    const overrides = {
      "ghost-model": { compat: { chatTemplateKwargs: { preserve_thinking: true } } },
    };
    const models = buildModels([], [], GHOST_PATCH, overrides, { "ghost-model": ghostModel(recent) });

    const ghost = models.find((m) => m.id === "ghost-model");
    expect(ghost!.compat?.chatTemplateKwargs?.preserve_thinking).toBe(true);
    // The patch-layer merge is still intact underneath the user override.
    expect(ghost!.compat?.requiresReasoningContentOnAssistantMessages).toBe(true);
  });
});
