import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanStalePatchEntries, updateDeprecatedModels } from "../scripts/update-models.js";

// The sync script must keep a patch.json entry alive for exactly as long as
// its model: entries for upstream models, custom (hidden) models, AND models
// sitting in the deprecated-models.json grace period all survive cleaning;
// the entry dies in the same run that evicts the model from the graveyard.

const DAY_MS = 24 * 60 * 60 * 1000;

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "update-models-test-"));
}

describe("update-models.js patch/graveyard lifetime", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps patch entries for grace-period models, drops entries for evicted/gone models", () => {
    const dir = tmpdir();
    const patchPath = path.join(dir, "patch.json");
    const patch = {
      "upstream-model": { compat: { a: 1 } },
      "custom-model": { compat: { b: 2 } },
      "graveyard-model": { compat: { c: 3 } },
      "evicted-model": { compat: { d: 4 } },
      "gone-model": { compat: { e: 5 } },
    };
    fs.writeFileSync(patchPath, JSON.stringify(patch, null, 2));

    const cleaned = cleanStalePatchEntries(
      patch,
      new Set(["upstream-model"]),
      new Set(["custom-model"]),
      new Set(["graveyard-model"]), // evicted-model is absent: eviction already happened
      patchPath,
    );

    expect(Object.keys(cleaned).sort()).toEqual(["custom-model", "graveyard-model", "upstream-model"]);
    expect(JSON.parse(fs.readFileSync(patchPath, "utf8"))).toEqual(cleaned);
  });

  it("reconciles the graveyard: delist adds, resurrect drops, TTL evicts, timestamp sticks", () => {
    const dir = tmpdir();
    const modelsJsonPath = path.join(dir, "models.json");
    fs.writeFileSync(
      modelsJsonPath,
      JSON.stringify([
        { id: "live-model", name: "Live" },
        { id: "delisted-model", name: "Delisted" },
      ]),
    );
    const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS).toISOString();
    const twentyDaysAgo = new Date(Date.now() - 20 * DAY_MS).toISOString();
    fs.writeFileSync(
      path.join(dir, "deprecated-models.json"),
      JSON.stringify({
        "grace-model": { id: "grace-model", name: "Grace", deprecatedAt: tenDaysAgo },
        "expired-model": { id: "expired-model", name: "Expired", deprecatedAt: twentyDaysAgo },
        "resurrected-model": { id: "resurrected-model", name: "Resurrected", deprecatedAt: tenDaysAgo },
      }),
    );

    const deprecated = updateDeprecatedModels(modelsJsonPath, [
      { id: "live-model", name: "Live v2" },
      { id: "resurrected-model", name: "Resurrected v2" },
    ]);

    expect(Object.keys(deprecated).sort()).toEqual(["delisted-model", "grace-model"]);
    // The grace clock is not reset on repeat runs.
    expect(deprecated["grace-model"].deprecatedAt).toBe(tenDaysAgo);
    // A newly delisted model carries its last models.json snapshot forward, stamped now-ish.
    expect(deprecated["delisted-model"].name).toBe("Delisted");
    expect(Number.isNaN(Date.parse(deprecated["delisted-model"].deprecatedAt))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "deprecated-models.json"), "utf8"))).toEqual(deprecated);
  });

  it("end-to-end lifetime: patch entry survives delisting and dies with eviction", () => {
    const dir = tmpdir();
    const modelsJsonPath = path.join(dir, "models.json");
    const patchPath = path.join(dir, "patch.json");
    fs.writeFileSync(patchPath, JSON.stringify({ "doomed-model": { compat: { x: true } } }));

    // Sync 1: the model is delisted — the graveyard gains it and its patch
    // entry must survive this very run.
    fs.writeFileSync(modelsJsonPath, JSON.stringify([{ id: "doomed-model", name: "Doomed" }]));
    let deprecated = updateDeprecatedModels(modelsJsonPath, []);
    let patch = cleanStalePatchEntries(
      { "doomed-model": { compat: { x: true } } },
      new Set(),
      new Set(),
      new Set(Object.keys(deprecated)),
      patchPath,
    );
    expect(patch["doomed-model"]).toBeDefined();

    // Sync 2: the graveyard entry has aged past the TTL while the model stayed
    // delisted — eviction and patch cleanup happen in the same run.
    fs.writeFileSync(modelsJsonPath, "[]");
    fs.writeFileSync(
      path.join(dir, "deprecated-models.json"),
      JSON.stringify({
        "doomed-model": {
          id: "doomed-model",
          name: "Doomed",
          deprecatedAt: new Date(Date.now() - 20 * DAY_MS).toISOString(),
        },
      }),
    );
    deprecated = updateDeprecatedModels(modelsJsonPath, []);
    expect(deprecated["doomed-model"]).toBeUndefined();
    patch = cleanStalePatchEntries(patch, new Set(), new Set(), new Set(Object.keys(deprecated)), patchPath);
    expect(patch["doomed-model"]).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(patchPath, "utf8"))).toEqual({});
  });
});
