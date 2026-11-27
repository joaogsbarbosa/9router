import { beforeEach, describe, expect, it, vi } from "vitest";

import { PROVIDER_MEDIA } from "../../open-sse/providers/index.js";
import openrouter from "../../open-sse/handlers/ttsProviders/openrouter.js";

const AUDIO = new Uint8Array(256).fill(7);
const audioResponse = (ctype = "audio/mpeg") =>
  new Response(AUDIO, { status: 200, headers: { "content-type": ctype } });

const SSE = 'data: {"choices":[{"delta":{"audio":{"data":"QUJD"}}}]}\n\ndata: [DONE]\n\n';

describe("OpenRouter TTS", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn(async () => audioResponse());
    global.fetch = fetchMock;
  });

  const body = (n = 0) => JSON.parse(fetchMock.mock.calls[n][1].body);

  it("uses the dedicated /audio/speech endpoint declared in the registry", async () => {
    expect(PROVIDER_MEDIA["openrouter"]?.ttsConfig?.speechUrl).toBe(
      "https://openrouter.ai/api/v1/audio/speech",
    );
    await openrouter.synthesize("olá", "fish-audio/s2.1-pro-free", { apiKey: "k" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/audio/speech");
  });

  it("sends the model id untouched and reads the voice from the request body", async () => {
    await openrouter.synthesize("olá", "fish-audio/s2.1-pro-free", { apiKey: "k" }, undefined, {
      options: { voice: "serena" },
    });
    expect(body()).toEqual({ model: "fish-audio/s2.1-pro-free", input: "olá", voice: "serena" });
  });

  it("does not force response_format (dedicated providers vary)", async () => {
    await openrouter.synthesize("olá", "heygen/heygen-voice-1", { apiKey: "k" }, "mp3");
    expect(body()).not.toHaveProperty("response_format");
  });

  it("detects the codec from the upstream content-type", async () => {
    global.fetch = vi.fn(async () => audioResponse("audio/wav"));
    await expect(openrouter.synthesize("olá", "openai/tts-1", { apiKey: "k" })).resolves.toMatchObject({
      format: "wav",
    });
  });

  it("falls back to chat completions when the dedicated endpoint rejects", async () => {
    const mock = vi.fn(async (url) =>
      String(url).endsWith("/audio/speech")
        ? new Response(JSON.stringify({ error: { message: "bad voice" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          })
        : new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    global.fetch = mock;

    const out = await openrouter.synthesize("olá", "openai/gpt-4o-mini-tts", { apiKey: "k" });
    expect(mock.mock.calls[1][0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(out.format).toBe("wav");
  });

  it("surfaces 402 (no credits) instead of masking it with the chat fallback", async () => {
    const mock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "Insufficient credits" } }), {
        status: 402,
        headers: { "content-type": "application/json" },
      }),
    );
    global.fetch = mock;

    await expect(
      openrouter.synthesize("olá", "google/gemini-2.5-flash-tts", { apiKey: "k" }),
    ).rejects.toThrow("[402] Insufficient credits");
    expect(mock).toHaveBeenCalledTimes(1);
  });
});