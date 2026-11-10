import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceoverHandler } from "../../voiceover/handler";
import { createFakeEnv, createFakeLog, createTestCtx } from "./fixtures";

/** A successful ElevenLabs TTS response: some non-empty audio bytes. */
function fakeAudioResponse(bytes: Uint8Array = new Uint8Array([9, 9, 9])): Response {
  const fake = {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: () => Promise.resolve({}),
    arrayBuffer: () => Promise.resolve(bytes.buffer)
  };
  return fake as unknown as Response;
}

/** A failed ElevenLabs response with the given status and (optional) JSON body. */
function fakeFailureResponse(status: number, body: unknown = {}): Response {
  const fake = {
    ok: false,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0))
  };
  return fake as unknown as Response;
}

describe("createVoiceoverHandler", () => {
  // -------------------------------------------------------------------------
  // estimate() — characters × price-per-char for the resolved model
  // -------------------------------------------------------------------------

  describe("estimate()", () => {
    it("computes characters × price-per-char for the resolved (default) model", () => {
      const ctx = createTestCtx({ config: { priceOverrides: { eleven_multilingual_v2: 0.001 } } });
      const handler = createVoiceoverHandler(ctx);

      const { usd } = handler.estimate({ text: "hello", voice: "v1" });

      expect(usd).toBeCloseTo(0.005, 10);
    });

    it("uses request.model over config.defaultModel when given", () => {
      const ctx = createTestCtx({
        config: { priceOverrides: { eleven_turbo_v2_5: 0.0002, eleven_multilingual_v2: 0.001 } }
      });
      const handler = createVoiceoverHandler(ctx);

      const { usd } = handler.estimate({ text: "hi", voice: "v1", model: "eleven_turbo_v2_5" });

      expect(usd).toBeCloseTo(0.0004, 10);
    });

    it("returns 0 for a model absent from the effective price table", () => {
      const handler = createVoiceoverHandler(createTestCtx());

      const { usd } = handler.estimate({ text: "hello", voice: "v1", model: "unknown_model" });

      expect(usd).toBe(0);
    });

    it("does not call fetch — an estimate never touches the network", () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const handler = createVoiceoverHandler(createTestCtx());

      handler.estimate({ text: "hi", voice: "v1" });

      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });

  // -------------------------------------------------------------------------
  // execute() — missing API key: exact two-line error, interpolated env name
  // -------------------------------------------------------------------------

  describe("execute() — missing API key", () => {
    it("throws the exact two-line error and never calls fetch", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const handler = createVoiceoverHandler(createTestCtx({ env: createFakeEnv({}) }));

      await expect(handler.execute({ text: "hi", voice: "v1" }, {})).rejects.toThrow(
        "[ai] ELEVENLABS_API_KEY is not set.\n  Export it or set config.apiKeyEnv to the variable that holds your key."
      );
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("interpolates a custom config.apiKeyEnv name into the first line", async () => {
      const handler = createVoiceoverHandler(
        createTestCtx({ config: { apiKeyEnv: "MY_CUSTOM_KEY" }, env: createFakeEnv({}) })
      );

      await expect(handler.execute({ text: "hi", voice: "v1" }, {})).rejects.toThrow(
        "[ai] MY_CUSTOM_KEY is not set.\n  Export it or set config.apiKeyEnv to the variable that holds your key."
      );
    });
  });

  // -------------------------------------------------------------------------
  // execute() — request mapping: voice/model/format -> URL + body
  // -------------------------------------------------------------------------

  describe("execute() — request mapping", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("POSTs to /v1/text-to-speech/{voiceId} with the resolved model in the body", async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeAudioResponse());
      vi.stubGlobal("fetch", fetchMock);
      const handler = createVoiceoverHandler(
        createTestCtx({ env: createFakeEnv({ ELEVENLABS_API_KEY: "test-key" }) })
      );

      await handler.execute({ text: "hello", voice: "voice-42" }, {});

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/v1/text-to-speech/voice-42");
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.text).toBe("hello");
      expect(body.model_id).toBe("eleven_multilingual_v2");
    });

    it("maps format to the output_format query param and the response mimeType", async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeAudioResponse());
      vi.stubGlobal("fetch", fetchMock);
      const handler = createVoiceoverHandler(
        createTestCtx({ env: createFakeEnv({ ELEVENLABS_API_KEY: "test-key" }) })
      );

      const result = await handler.execute({ text: "hi", voice: "v1", format: "wav" }, {});

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("output_format=wav_44100");
      expect(result.mimeType).toBe("audio/wav");
    });

    it("defaults to mp3 when the request omits format", async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeAudioResponse());
      vi.stubGlobal("fetch", fetchMock);
      const handler = createVoiceoverHandler(
        createTestCtx({ env: createFakeEnv({ ELEVENLABS_API_KEY: "test-key" }) })
      );

      const result = await handler.execute({ text: "hi", voice: "v1" }, {});

      expect(result.mimeType).toBe("audio/mpeg");
    });

    it("includes language as language_code (primary subtag) when the request gives one", async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeAudioResponse());
      vi.stubGlobal("fetch", fetchMock);
      const handler = createVoiceoverHandler(
        createTestCtx({ env: createFakeEnv({ ELEVENLABS_API_KEY: "test-key" }) })
      );

      await handler.execute({ text: "hi", voice: "v1", language: "es-ES", model: "eleven_v4" }, {});

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.language_code).toBe("es");
    });

    it("does not send language_code for eleven_multilingual_v2, which does not support it", async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeAudioResponse());
      vi.stubGlobal("fetch", fetchMock);
      const handler = createVoiceoverHandler(
        createTestCtx({ env: createFakeEnv({ ELEVENLABS_API_KEY: "test-key" }) })
      );

      await handler.execute({ text: "hi", voice: "v1", language: "ru" }, {});

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).not.toHaveProperty("language_code");
    });

    it("maps voice settings, seed and neighbour text onto ElevenLabs' names, only the ones set", async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeAudioResponse());
      vi.stubGlobal("fetch", fetchMock);
      const handler = createVoiceoverHandler(
        createTestCtx({ env: createFakeEnv({ ELEVENLABS_API_KEY: "test-key" }) })
      );

      await handler.execute(
        {
          text: "hi",
          voice: "v1",
          settings: {
            stability: 0.3,
            similarity: 0.75,
            style: 0.45,
            speakerBoost: true,
            speed: 1.1
          },
          seed: 7,
          previousText: "before",
          nextText: "after"
        },
        {}
      );

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual({
        text: "hi",
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.3,
          similarity_boost: 0.75,
          style: 0.45,
          use_speaker_boost: true,
          speed: 1.1
        },
        seed: 7,
        previous_text: "before",
        next_text: "after"
      });
    });

    it("drops style, speakerBoost and speed for a v4 model and warns with the key names only", async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeAudioResponse());
      vi.stubGlobal("fetch", fetchMock);
      const log = createFakeLog();
      const handler = createVoiceoverHandler(
        createTestCtx({ env: createFakeEnv({ ELEVENLABS_API_KEY: "test-key" }), log })
      );
      const settings = {
        stability: 0.3,
        similarity: 0.75,
        style: 0.45,
        speakerBoost: true,
        speed: 1.1
      };

      await handler.execute({ text: "SECRET", voice: "v1", model: "eleven_v4", settings }, {});

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.voice_settings).toEqual({ stability: 0.3, similarity_boost: 0.75 });
      expect(log.warn).toHaveBeenCalledWith("elevenlabs:voiceover:settings-ignored", {
        model: "eleven_v4",
        keys: ["style", "speakerBoost", "speed"]
      });
    });

    it("lets params override a mapped field (params are spread last)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeAudioResponse());
      vi.stubGlobal("fetch", fetchMock);
      const handler = createVoiceoverHandler(
        createTestCtx({ env: createFakeEnv({ ELEVENLABS_API_KEY: "test-key" }) })
      );

      await handler.execute({ text: "hi", voice: "v1", seed: 7, params: { seed: 1 } }, {});

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((JSON.parse(init.body as string) as Record<string, unknown>).seed).toBe(1);
    });

    it("puts an explicit outputFormat in the URL, over the legacy format", async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeAudioResponse());
      vi.stubGlobal("fetch", fetchMock);
      const handler = createVoiceoverHandler(
        createTestCtx({ env: createFakeEnv({ ELEVENLABS_API_KEY: "test-key" }) })
      );

      const result = await handler.execute(
        { text: "hi", voice: "v1", format: "wav", outputFormat: "mp3_44100_192" },
        {}
      );

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("output_format=mp3_44100_192");
      expect(result.mimeType).toBe("audio/mpeg");
    });

    it("spreads request.params into the body, on top of text/model_id", async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeAudioResponse());
      vi.stubGlobal("fetch", fetchMock);
      const handler = createVoiceoverHandler(
        createTestCtx({ env: createFakeEnv({ ELEVENLABS_API_KEY: "test-key" }) })
      );

      await handler.execute({ text: "hi", voice: "v1", params: { stability: 0.8 } }, {});

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.stability).toBe(0.8);
    });

    it("returns costUsd matching estimate()'s formula for the same request", async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeAudioResponse());
      vi.stubGlobal("fetch", fetchMock);
      const ctx = createTestCtx({
        config: { priceOverrides: { eleven_multilingual_v2: 0.001 } },
        env: createFakeEnv({ ELEVENLABS_API_KEY: "test-key" })
      });
      const handler = createVoiceoverHandler(ctx);
      const request = { text: "hello", voice: "v1" };

      const { usd } = handler.estimate(request);
      const result = await handler.execute(request, {});

      expect(result.costUsd).toBeCloseTo(usd, 10);
    });

    it("passes opts.signal through to fetch (clean-pause propagation)", async () => {
      const controller = new AbortController();
      let observedSignal: AbortSignal | undefined;
      const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        observedSignal = init.signal as AbortSignal;
        return Promise.resolve(fakeAudioResponse());
      });
      vi.stubGlobal("fetch", fetchMock);
      const handler = createVoiceoverHandler(
        createTestCtx({ env: createFakeEnv({ ELEVENLABS_API_KEY: "test-key" }) })
      );

      await handler.execute({ text: "hi", voice: "v1" }, { signal: controller.signal });

      expect(observedSignal).toBeDefined();
      expect(observedSignal?.aborted).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // execute() — redaction: ctx.log receives status codes + error classes only
  // -------------------------------------------------------------------------

  describe("execute() — redaction", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("logs status + errorType on a terminal 4xx failure, never the request text", async () => {
      const secretText = "SECRET PROMPT TEXT";
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeFailureResponse(400)));
      const log = createFakeLog();
      const handler = createVoiceoverHandler(
        createTestCtx({ env: createFakeEnv({ ELEVENLABS_API_KEY: "test-key" }), log })
      );

      await expect(handler.execute({ text: secretText, voice: "v1" }, {})).rejects.toThrow();

      expect(log.warn).toHaveBeenCalledWith(
        "elevenlabs:voiceover:failed",
        expect.objectContaining({ errorType: "terminal", status: 400 })
      );
      const [, loggedPayload] = vi.mocked(log.warn).mock.calls[0] as [string, unknown];
      expect(JSON.stringify(loggedPayload)).not.toContain(secretText);
    });

    it("never echoes request text or response bodies in the thrown error's message", async () => {
      const secretText = "ANOTHER SECRET PROMPT";
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(fakeFailureResponse(400, { detail: { message: "LEAKED BODY" } }))
      );
      const handler = createVoiceoverHandler(
        createTestCtx({ env: createFakeEnv({ ELEVENLABS_API_KEY: "test-key" }) })
      );

      let caught: unknown;
      try {
        await handler.execute({ text: secretText, voice: "v1" }, {});
      } catch (error) {
        caught = error;
      }

      const message = (caught as Error).message;
      expect(message).not.toContain(secretText);
      expect(message).not.toContain("LEAKED BODY");
    });
  });
});
