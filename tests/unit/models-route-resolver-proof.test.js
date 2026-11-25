import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolated proof that the OpenRouter live RESOLVER (not the static seed, not the
// pattern table) is what surfaces image models. Uses a sentinel id that exists in
// NO static table and matches NO capability pattern, so the only way it can reach
// /v1/models/image is through fetchOpenRouterImageModels().
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

const SENTINEL = "acme/sentinel-image-9x7"; // not in any static table, matches no pattern
const conn = () => ({
  id: "or-1", provider: "openrouter", isActive: true, apiKey: "sk-test",
  providerSpecificData: {},
});

let realFetch;
beforeEach(() => {
  state.connections = [conn()]; state.combos = []; state.customModels = []; state.aliases = {}; state.disabled = {};
  realFetch = globalThis.fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

describe("openrouter live resolver is the source of image models", () => {
  it("surfaces a sentinel id that exists in no static table and matches no pattern", async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url).includes("/images/models")) {
        return { ok: true, json: async () => ({ data: [
          { id: SENTINEL, name: "Sentinel", architecture: { output_modalities: ["image"] } },
        ] }) };
      }
      return { ok: false, json: async () => ({}) };
    });

    const image = await buildModelsList(["image"]);
    const hit = image.find((m) => m.id === `openrouter/${SENTINEL}`);
    expect(hit, "sentinel must appear via the live resolver").toBeTruthy();
    expect(hit.capabilities?.imageOutput).toBe(true);
    // prove it actually hit the live endpoint
    expect(calls.some((u) => u.endsWith("/images/models"))).toBe(true);
  });

  it("does NOT surface the sentinel when the live fetch fails (fail-open to static seed)", async () => {
    // Fresh module copy so the 10-min TTL cache from the previous test does not
    // serve the sentinel — this exercises the real network-failure path.
    vi.resetModules();
    const fresh = await import("../../src/app/api/v1/models/route.js?failopen=1");
    globalThis.fetch = vi.fn(async () => { throw new Error("offline"); });
    const image = await fresh.buildModelsList(["image"]);
    expect(image.find((m) => m.id === `openrouter/${SENTINEL}`)).toBeUndefined();
    // static seed still present
    expect(image.find((m) => m.id === "openrouter/openai/dall-e-3")).toBeTruthy();
  });
});