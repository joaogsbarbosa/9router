import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock only the persistence layer + the live OpenRouter image catalog fetch.
// buildModelsList() runs for real, exercising the live openrouter resolver that
// trusts GET /api/v1/images/models instead of a hardcoded id list.
const state = {
  connections: [],
  combos: [],
  customModels: [],
  aliases: {},
  disabled: {},
};

// A trimmed but representative slice of the live image catalog (architecture.
// output_modalities includes "image"). The test asserts the resolver surfaces
// these verbatim, so no per-id registry maintenance is needed.
const LIVE_IMAGE_MODELS = [
  { id: "recraft/recraft-v4.1-flash-v2:free", name: "Recraft: Recraft V4.1 Flash V2 (free)", architecture: { output_modalities: ["image"] } },
  { id: "bytedance-seed/seedream-5-5", name: "ByteDance Seed: Seedream 5.5", architecture: { output_modalities: ["image"] } },
  { id: "black-forest-labs/flux.2-max", name: "Black Forest Labs: FLUX.2 Max", architecture: { output_modalities: ["image"] } },
  { id: "openai/gpt-image-2.6-sunburst", name: "OpenAI: GPT Image 2.6 Sunburst", architecture: { output_modalities: ["image"] } },
];

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => state.connections),
  getCombos: vi.fn(async () => state.combos),
  getCustomModels: vi.fn(async () => state.customModels),
  getModelAliases: vi.fn(async () => state.aliases),
}));
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => state.disabled),
}));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: vi.fn(async () => ({})),
  filterModelsListForKey: vi.fn(async (_ctx, list) => list),
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

function openRouterConnection(enabledModels) {
  return {
    id: "or-1",
    provider: "openrouter",
    isActive: true,
    apiKey: "sk-test",
    providerSpecificData: enabledModels ? { enabledModels } : {},
  };
}

let realFetch;
beforeEach(() => {
  state.connections = [];
  state.combos = [];
  state.customModels = [];
  state.aliases = {};
  state.disabled = {};
  realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("/images/models")) {
      return { ok: true, json: async () => ({ data: LIVE_IMAGE_MODELS }) };
    }
    return { ok: false, json: async () => ({}) };
  });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("/v1/models OpenRouter image models (live, no hardcode)", () => {
  it("surfaces the live image catalog in /v1/models/image with imageOutput:true", async () => {
    state.connections = [openRouterConnection()];

    const models = await buildModelsList(["image"]);
    const byId = new Map(models.map((m) => [m.id, m]));
    for (const m of LIVE_IMAGE_MODELS) {
      const entry = byId.get(`openrouter/${m.id}`);
      expect(entry, `${m.id} must be present`).toBeTruthy();
      expect(entry.capabilities?.imageOutput, `${m.id} imageOutput`).toBe(true);
    }
  });

  it("keeps static non-image OpenRouter models (embedding/tts) in their own lists", async () => {
    state.connections = [openRouterConnection()];
    const emb = await buildModelsList(["embedding"]);
    expect(emb.find((m) => m.id === "openrouter/openai/text-embedding-3-large")).toBeTruthy();
    const tts = await buildModelsList(["tts"]);
    expect(tts.find((m) => m.id === "openrouter/openai/tts-1")).toBeTruthy();
  });

  it("does not leak image models into the LLM list", async () => {
    state.connections = [openRouterConnection()];
    const llm = await buildModelsList(["llm"]);
    expect(llm.find((m) => m.id === "openrouter/recraft/recraft-v4.1-flash-v2:free")).toBeUndefined();
  });

  it("falls back to the static list when the live fetch fails (fail-open)", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("network down"); });
    state.connections = [openRouterConnection()];
    const image = await buildModelsList(["image"]);
    // static seed (dall-e-3/gpt-image-1/imagen/flux.1-schnell) still present
    expect(image.find((m) => m.id === "openrouter/openai/dall-e-3")).toBeTruthy();
  });
});