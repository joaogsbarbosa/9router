// OpenRouter TTS — endpoint dedicado /audio/speech (modelos TTS) com fallback
// para chat completions + audio modality (modelos conversacionais com áudio).
import { PROVIDER_MEDIA } from "../../providers/index.js";

const TTS_CFG = PROVIDER_MEDIA["openrouter"]?.ttsConfig || {};
const SPEECH_URL = TTS_CFG.speechUrl || TTS_CFG.baseUrl;

export default {
  async synthesize(text, model, credentials, _responseFormat, opts = {}) {
    if (!credentials?.apiKey) throw new Error("No OpenRouter API key configured");

    // `model` é o id do modelo OpenRouter (ex.: "fish-audio/s2.1-pro-free");
    // a voz vem do corpo (body.voice), pois ids de modelo contêm "/".
    const ttsModel = model || TTS_CFG.defaultModel;
    const voice = opts?.options?.voice || opts?.voice || "alloy";
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${credentials.apiKey}`,
      ...(TTS_CFG.headers || {}),
    };

    // 1) Endpoint dedicado (/audio/speech). Sem response_format: provedores
    // dedicados variam (ex.: heygen só aceita "pcm") e escolhem o default.
    const speechRes = await fetch(SPEECH_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: ttsModel, input: text, voice }),
    });
    if (speechRes.ok) {
      const buf = Buffer.from(await speechRes.arrayBuffer());
      if (buf.length > 0) {
        const ct = (speechRes.headers.get("content-type") || "").toLowerCase();
        const format = /wav/.test(ct) ? "wav" : /pcm/.test(ct) ? "pcm" : /mpeg|mp3/.test(ct) ? "mp3" : "mp3";
        return { base64: buf.toString("base64"), format };
      }
    } else if ([401, 402, 403, 429].includes(speechRes.status)) {
      // Auth/quota errors are not fixed by the chat/completions fallback (which
      // would 400 on TTS-only models and mask the real cause). Surface them.
      const err = await speechRes.json().catch(() => ({}));
      throw new Error(`[${speechRes.status}] ${err?.error?.message || "OpenRouter TTS failed"}`);
    }

    // 2) Fallback: chat completions + audio modality.
    const res = await fetch(TTS_CFG.baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: ttsModel,
        modalities: ["text", "audio"],
        audio: { voice, format: "wav" },
        stream: true,
        messages: [{ role: "user", content: text }],
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `OpenRouter TTS failed: ${res.status}`);
    }

    // Parse SSE stream, accumulate base64 audio chunks
    const chunks = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        try {
          const json = JSON.parse(line.slice(6));
          const audioData = json.choices?.[0]?.delta?.audio?.data;
          if (audioData) chunks.push(audioData);
        } catch {}
      }
    }

    if (chunks.length === 0) throw new Error("OpenRouter TTS returned no audio data");
    return { base64: chunks.join(""), format: "wav" };
  },
};