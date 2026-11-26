import { describe, expect, it, vi } from "vitest";

// Real-network proof: buildModelsList() runs for real against OpenRouter using a
// live API key. Only the persistence layer is mocked; fetch is NOT mocked.
// Skipped unless OPENROUTER_TEST_KEY is set — never hardcode a key here.
const KEY = process.env.OPENROUTER_TEST_KEY;

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

function conn(enabledModels) {
  return {
    id: "or-live", provider: "openrouter", isActive: true, apiKey: KEY,
    providerSpecificData: enabledModels ? { enabledModels } : {},
  };
}

describe("LIVE OpenRouter /v1/models/image (real network)", () => {
  it.skipIf(!KEY)("surfaces recraft free in /models/image WITHOUT enabledModels", async () => {
    state.connections = [conn()];
    const image = await buildModelsList(["image"]);
    const recraft = image.find((m) => m.id === "openrouter/recraft/recraft-v4.1-flash-v2:free");
    expect(recraft, "recraft free must appear").toBeTruthy();
    expect(recraft.capabilities?.imageOutput).toBe(true);
    expect(image.length).toBeGreaterThan(4); // more than the static seed
  });

  it.skipIf(!KEY)("surfaces recraft free in /models/image WITH enabledModels gate", async () => {
    state.connections = [conn(["recraft/recraft-v4.1-flash-v2:free"])];
    const image = await buildModelsList(["image"]);
    const recraft = image.find((m) => m.id === "openrouter/recraft/recraft-v4.1-flash-v2:free");
    expect(recraft, "recraft free must appear despite enabledModels").toBeTruthy();
    expect(recraft.capabilities?.imageOutput).toBe(true);
  });

  it.skipIf(!KEY)("does not leak recraft into the LLM list", async () => {
    state.connections = [conn()];
    const llm = await buildModelsList(["llm"]);
    expect(llm.find((m) => m.id === "openrouter/recraft/recraft-v4.1-flash-v2:free")).toBeUndefined();
  });
});