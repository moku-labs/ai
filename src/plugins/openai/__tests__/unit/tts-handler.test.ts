import { describe, expect, it, vi } from "vitest";
import { createTtsHandler } from "../../tts/handler";
import { createFakeOpenaiClient, createFakeOpenaiContext } from "./fixtures";

describe("openai unit: tts handler (voiceover contract)", () => {
  describe("estimate", () => {
    it("prices text.length characters against the tts per-million-characters price", () => {
      const ctx = createFakeOpenaiContext();
      const handler = createTtsHandler(ctx);

      const result = handler.estimate({ text: "Hello", voice: "alloy" });

      // bundled "gpt-4o-mini-tts" price is 15 USD / 1M chars.
      expect(result.usd).toBeCloseTo(("Hello".length / 1_000_000) * 15, 10);
    });

    it("prices against a request-level model override", () => {
      const ctx = createFakeOpenaiContext({
        config: { priceOverrides: { "tts-1-hd": { ttsPerMChars: 30 } } }
      });
      const handler = createTtsHandler(ctx);

      const result = handler.estimate({ text: "Hello", voice: "alloy", model: "tts-1-hd" });

      expect(result.usd).toBeCloseTo(("Hello".length / 1_000_000) * 30, 10);
    });

    it("never needs an API key (state.client stays null)", () => {
      const ctx = createFakeOpenaiContext();
      const handler = createTtsHandler(ctx);

      handler.estimate({ text: "Hello", voice: "alloy" });

      expect(ctx.state.client).toBeNull();
    });
  });

  describe("execute", () => {
    it("maps voice/model/format and returns the synthesized audio with metadata-only meta", async () => {
      const { client, speechCalls } = createFakeOpenaiClient({
        speechResult: { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }
      });
      const ctx = createFakeOpenaiContext({ state: { client } });
      const handler = createTtsHandler(ctx);

      const result = await handler.execute(
        { text: "Hello", voice: "alloy", model: "gpt-4o-mini-tts", format: "wav" },
        {}
      );

      expect(speechCalls[0]?.params).toEqual({
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        input: "Hello",
        response_format: "wav"
      });
      expect(result.mimeType).toBe("audio/wav");
      expect([...result.audio]).toEqual([1, 2, 3]);
      expect(result.meta).toEqual({ characters: "Hello".length, model: "gpt-4o-mini-tts" });
    });

    it('maps the "ogg" contract format to OpenAI\'s "opus" codec', async () => {
      const { client, speechCalls } = createFakeOpenaiClient();
      const ctx = createFakeOpenaiContext({ state: { client } });
      const handler = createTtsHandler(ctx);

      const result = await handler.execute({ text: "Hi", voice: "alloy", format: "ogg" }, {});

      expect(speechCalls[0]?.params.response_format).toBe("opus");
      expect(result.mimeType).toBe("audio/ogg");
    });

    it("defaults to mp3 when no format is requested", async () => {
      const { client, speechCalls } = createFakeOpenaiClient();
      const ctx = createFakeOpenaiContext({ state: { client } });
      const handler = createTtsHandler(ctx);

      const result = await handler.execute({ text: "Hi", voice: "alloy" }, {});

      expect(speechCalls[0]?.params.response_format).toBe("mp3");
      expect(result.mimeType).toBe("audio/mpeg");
    });

    it("forwards the abort signal to the SDK call", async () => {
      const { client, speechCalls } = createFakeOpenaiClient();
      const ctx = createFakeOpenaiContext({ state: { client } });
      const handler = createTtsHandler(ctx);
      const controller = new AbortController();

      await handler.execute({ text: "Hi", voice: "alloy" }, { signal: controller.signal });

      expect(speechCalls[0]?.signal).toBe(controller.signal);
    });

    it("never includes the synthesized text in meta (redaction)", async () => {
      const { client } = createFakeOpenaiClient();
      const ctx = createFakeOpenaiContext({ state: { client } });
      const handler = createTtsHandler(ctx);

      const result = await handler.execute({ text: "SECRET_TEXT", voice: "alloy" }, {});

      expect(JSON.stringify(result.meta)).not.toContain("SECRET_TEXT");
    });

    it("throws the pinned missing-key error when no API key is configured and no client is pre-seeded", async () => {
      const ctx = createFakeOpenaiContext();
      const handler = createTtsHandler(ctx);

      await expect(handler.execute({ text: "Hi", voice: "alloy" }, {})).rejects.toThrow(
        "[ai] OPENAI_API_KEY is not set.\n  Export it or set config.apiKeyEnv to the variable that holds your key."
      );
    });

    it("logs redacted diagnostics on success and failure — never the request text", async () => {
      const { client } = createFakeOpenaiClient();
      const successCtx = createFakeOpenaiContext({ state: { client } });
      await createTtsHandler(successCtx).execute({ text: "SECRET_TEXT", voice: "alloy" }, {});
      expect(successCtx.log.info).toHaveBeenCalledWith(
        "openai:tts:done",
        expect.objectContaining({ model: expect.any(String) })
      );

      const failingCtx = createFakeOpenaiContext();
      await expect(
        createTtsHandler(failingCtx).execute({ text: "SECRET_TEXT", voice: "alloy" }, {})
      ).rejects.toThrow();
      expect(failingCtx.log.warn).toHaveBeenCalledWith("openai:tts:failed", expect.any(Object));

      const infoMock = vi.mocked(successCtx.log.info);
      const warnMock = vi.mocked(failingCtx.log.warn);
      const loggedPayloads = JSON.stringify([...infoMock.mock.calls, ...warnMock.mock.calls]);
      expect(loggedPayloads).not.toContain("SECRET_TEXT");
    });
  });
});
