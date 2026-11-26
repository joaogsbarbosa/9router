import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Reproduce PRODUCTION: enabledModels set AND live fetch fails (Railway egress).
// recraft must still reach /models/image via the capability-pattern fallback.
const state = { connections: [], combos: [], customModels: [], aliases: {}, disabled: {} };

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => state.connections),
  getCombos: vi.fn(async () => state.combos),
  getCustomModels: vi.fn(async () => state.customModels),
  getModelAliases: vi.fn(async () => state.aliases),
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: vi.fn(async () => state.disabled) }));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: vi.fn(async () => ({})),
  filterModelsListForKey: vi.fn(async (_c, l) => l),
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

let realFetch;
beforeEach(() => {
  state.connections = [{
    id: "or-1", provider: "openrouter", isActive: true, apiKey: "sk-test",
    providerSpecificData: { enabledModels: ["recraft/recraft-v4.1-flash-v2:free"] },
  }];
  state.combos = []; state.customModels = []; state.aliases = {}; state.disabled = {};
  realFetch = globalThis.fetch;
  // live fetch fails (production egress)
  globalThis.fetch = vi.fn(async () => { throw new Error("offline"); });
});
afterEach(() => { globalThis.fetch = realFetch; });

describe("PROD repro: enabledModels + live fetch failure", () => {
  it("recraft reaches /models/image via pattern fallback", async () => {
    const image = await buildModelsList(["image"]);
    const recraft = image.find((m) => m.id === "openrouter/recraft/recraft-v4.1-flash-v2:free");
    expect(recraft, "recraft must be in image list").toBeTruthy();
    expect(recraft.capabilities?.imageOutput).toBe(true);
  });

  it("recraft does NOT leak into LLM", async () => {
    const llm = await buildModelsList(["llm"]);
    expect(llm.find((m) => m.id === "openrouter/recraft/recraft-v4.1-flash-v2:free")).toBeUndefined();
  });
});

// Reproduce the ACTUAL production root cause: recraft is registered as an
// UNTYPED custom model (no explicit kind). An untyped custom model must not be
// forced to llm — its kind is resolved from the live catalog / name heuristic,
// so it reaches /v1/models/image.
describe("PROD repro: untyped custom model recraft", () => {
  beforeEach(() => {
    state.customModels = [{
      id: "recraft/recraft-v4.1-flash-v2:free",
      providerAlias: "openrouter",
      // no kind -> untyped
    }];
  });

  it("untyped custom recraft reaches /models/image", async () => {
    const image = await buildModelsList(["image"]);
    const recraft = image.find((m) => m.id === "openrouter/recraft/recraft-v4.1-flash-v2:free");
    expect(recraft, "recraft must be in image list").toBeTruthy();
    expect(recraft.capabilities?.imageOutput).toBe(true);
  });

  it("untyped custom recraft does NOT leak into LLM", async () => {
    const llm = await buildModelsList(["llm"]);
    expect(llm.find((m) => m.id === "openrouter/recraft/recraft-v4.1-flash-v2:free")).toBeUndefined();
  });

  it("explicit llm custom model is overridden by authoritative image kind", async () => {
    state.customModels = [{
      id: "recraft/recraft-v4.1-flash-v2:free",
      providerAlias: "openrouter",
      kind: "llm",
    }];
    const image = await buildModelsList(["image"]);
    const recraft = image.find((m) => m.id === "openrouter/recraft/recraft-v4.1-flash-v2:free");
    expect(recraft, "authoritative image kind must win over a default llm custom row").toBeTruthy();
    expect(recraft.capabilities?.imageOutput).toBe(true);
  });

  it("explicit non-llm custom kind is respected", async () => {
    state.customModels = [{
      id: "recraft/recraft-v4.1-flash-v2:free",
      providerAlias: "openrouter",
      kind: "image",
    }];
    const image = await buildModelsList(["image"]);
    expect(image.find((m) => m.id === "openrouter/recraft/recraft-v4.1-flash-v2:free")).toBeTruthy();
  });
});