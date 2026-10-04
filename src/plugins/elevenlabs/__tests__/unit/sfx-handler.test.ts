import { afterEach, describe, expect, it, vi } from "vitest";
import type { SfxRequest } from "../../../sfx/contract";
import { RetryableProviderError, TerminalProviderError } from "../../errors";
import { createSfxHandler } from "../../sfx/handler";
import { createFakeEnv, createFakeLog, createTestCtx } from "./fixtures";

/** The only model the ElevenLabs sound-generation endpoint serves. */
const MODEL = "eleven_text_to_sound_v2";

/** A successful ElevenLabs sound-generation response carrying `bytes`. */
function fakeAudioResponse(bytes: Uint8Array = new Uint8Array([7, 7, 7])): Response {
  const fake = {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: () => Promise.resolve({}),
    arrayBuffer: () => Promise.resolve(bytes.buffer)
  };
  return fake as unknown as Response;
}

/** A failed ElevenLabs response with the given status. */
function fakeFailureResponse(status: number): Response {
  const fake = {
    ok: false,
    status,
    headers: new Headers(),
    json: () => Promise.resolve({}),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0))
  };
  return fake as unknown as Response;
}

/**
 * Builds a handler with a resolved API key and a stubbed global fetch.
 *
 * @param fetchMock - The fetch mock to install.
 * @param priceOverrides - Price overrides for the context.
 * @returns The handler and the fake log it writes to.
 */
function handlerWithFetch(
  fetchMock: ReturnType<typeof vi.fn>,
  priceOverrides: Record<string, number> = {}
) {
  vi.stubGlobal("fetch", fetchMock);
  const log = createFakeLog();
  const ctx = createTestCtx({
    config: { priceOverrides },
    env: createFakeEnv({ ELEVENLABS_API_KEY: "test-key" }),
    log
  });
  return { handler: createSfxHandler(ctx), log };
}

/**
 * Reads the URL and the parsed JSON body of the first fetch call.
 *
 * @param fetchMock - The fetch mock that was called.
 * @returns The URL and the body.
 */
function firstCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, body: JSON.parse(init.body as string) as Record<string, unknown>, init };
}

describe("createSfxHandler", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // estimate() — per started second, or the flat #auto price
  // -------------------------------------------------------------------------

  describe("estimate()", () => {
    it("bills every started second at the bundled #second price", () => {
      const handler = createSfxHandler(createTestCtx());

      const { usd } = handler.estimate({ prompt: "sword hit", model: MODEL, durationMs: 1500 });

      expect(usd).toBeCloseTo(2 * 0.002, 10);
    });

    it("bills the bundled #auto price when durationMs is omitted", () => {
      const handler = createSfxHandler(createTestCtx());

      const { usd } = handler.estimate({ prompt: "sword hit", model: MODEL });

      expect(usd).toBeCloseTo(0.01, 10);
    });

    it("uses priceOverrides for both price keys", () => {
      const handler = createSfxHandler(
        createTestCtx({
          config: {
            priceOverrides: {
              "sfx:eleven_text_to_sound_v2#second": 0.005,
              "sfx:eleven_text_to_sound_v2#auto": 0.03
            }
          }
        })
      );

      expect(handler.estimate({ prompt: "x", model: MODEL, durationMs: 3000 }).usd).toBeCloseTo(
        0.015,
        10
      );
      expect(handler.estimate({ prompt: "x", model: MODEL }).usd).toBeCloseTo(0.03, 10);
    });

    it("throws a terminal 400 with the pinned message when the price is missing", () => {
      const handler = createSfxHandler(createTestCtx({ state: { prices: {} } }));

      let caught: unknown;
      try {
        handler.estimate({ prompt: "x", model: MODEL, durationMs: 1000 });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(TerminalProviderError);
      expect((caught as TerminalProviderError).status).toBe(400);
      expect((caught as Error).message).toBe(
        '[ai] No price for ElevenLabs sfx model "eleven_text_to_sound_v2".\n  Add it to elevenlabs.priceOverrides.'
      );
    });

    it("rejects an unsupported model as terminal", () => {
      const handler = createSfxHandler(createTestCtx());

      expect(() => handler.estimate({ prompt: "x", model: "eleven_multilingual_v2" })).toThrow(
        TerminalProviderError
      );
    });

    it("rejects an out-of-range durationMs as terminal", () => {
      const handler = createSfxHandler(createTestCtx());

      expect(() => handler.estimate({ prompt: "x", model: MODEL, durationMs: 31_000 })).toThrow(
        TerminalProviderError
      );
    });

    it("does not call fetch", () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const handler = createSfxHandler(createTestCtx());

      handler.estimate({ prompt: "x", model: MODEL, durationMs: 800 });

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // execute() — request mapping: URL + body
  // -------------------------------------------------------------------------

  describe("execute() — request mapping", () => {
    it("POSTs to /v1/sound-generation with the mp3 output_format and the full body", async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeAudioResponse());
      const { handler } = handlerWithFetch(fetchMock);

      await handler.execute(
        { prompt: "coin pickup", model: MODEL, durationMs: 600, promptInfluence: 0.4, loop: true },
        {}
      );

      const { url, body, init } = firstCall(fetchMock);
      expect(url).toBe("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128");
      expect(init.method).toBe("POST");
      expect(body).toEqual({
        text: "coin pickup",
        model_id: MODEL,
        duration_seconds: 0.6,
        prompt_influence: 0.4,
        loop: true
      });
    });

    it("omits the optional body fields when the request omits them", async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeAudioResponse());
      const { handler } = handlerWithFetch(fetchMock);

      await handler.execute({ prompt: "coin pickup", model: MODEL }, {});

      expect(firstCall(fetchMock).body).toEqual({ text: "coin pickup", model_id: MODEL });
    });

    it("uses an mp3_ params.output_format in the query", async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeAudioResponse());
      const { handler } = handlerWithFetch(fetchMock);

      await handler.execute(
        { prompt: "x", model: MODEL, params: { output_format: "mp3_22050_32" } },
        {}
      );

      expect(firstCall(fetchMock).url).toContain("output_format=mp3_22050_32");
    });

    it("returns the audio bytes as audio/mpeg with model and duration in meta", async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeAudioResponse(new Uint8Array([1, 2, 3])));
      const { handler, log } = handlerWithFetch(fetchMock);

      const result = await handler.execute({ prompt: "x", model: MODEL, durationMs: 2000 }, {});

      expect(result.audio).toEqual(new Uint8Array([1, 2, 3]));
      expect(result.mimeType).toBe("audio/mpeg");
      expect(result.meta).toEqual({
        model: MODEL,
        outputFormat: "mp3_44100_128",
        durationMs: 2000
      });
      expect(log.info).toHaveBeenCalledWith("elevenlabs:sfx:done", {
        model: MODEL,
        outputFormat: "mp3_44100_128"
      });
    });
  });

  // -------------------------------------------------------------------------
  // execute() — cost: per started second, or #auto
  // -------------------------------------------------------------------------

  describe("execute() — cost", () => {
    it("charges every started second when durationMs is set", async () => {
      const { handler } = handlerWithFetch(vi.fn().mockResolvedValue(fakeAudioResponse()));

      const result = await handler.execute({ prompt: "x", model: MODEL, durationMs: 2001 }, {});

      expect(result.costUsd).toBeCloseTo(3 * 0.002, 10);
    });

    it("charges the #auto price when durationMs is omitted", async () => {
      const { handler } = handlerWithFetch(vi.fn().mockResolvedValue(fakeAudioResponse()));

      const result = await handler.execute({ prompt: "x", model: MODEL }, {});

      expect(result.costUsd).toBeCloseTo(0.01, 10);
    });

    it("charges the overridden price", async () => {
      const { handler } = handlerWithFetch(vi.fn().mockResolvedValue(fakeAudioResponse()), {
        "sfx:eleven_text_to_sound_v2#second": 0.004
      });

      const result = await handler.execute({ prompt: "x", model: MODEL, durationMs: 500 }, {});

      expect(result.costUsd).toBeCloseTo(0.004, 10);
    });

    it("throws the missing-price error before any HTTP call", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const handler = createSfxHandler(
        createTestCtx({
          state: { prices: {} },
          env: createFakeEnv({ ELEVENLABS_API_KEY: "test-key" })
        })
      );

      await expect(handler.execute({ prompt: "x", model: MODEL }, {})).rejects.toThrow(
        '[ai] No price for ElevenLabs sfx model "eleven_text_to_sound_v2".'
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // execute() — validation: terminal, before any HTTP call
  // -------------------------------------------------------------------------

  describe("execute() — validation", () => {
    const invalid: Array<[string, SfxRequest]> = [
      ["an unsupported model", { prompt: "x", model: "eleven_multilingual_v2" }],
      ["durationMs below 500", { prompt: "x", model: MODEL, durationMs: 499 }],
      ["durationMs above 30000", { prompt: "x", model: MODEL, durationMs: 30_001 }],
      ["a non-finite durationMs", { prompt: "x", model: MODEL, durationMs: Number.NaN }],
      ["a prompt over 450 characters", { prompt: "a".repeat(451), model: MODEL }],
      ["promptInfluence below 0", { prompt: "x", model: MODEL, promptInfluence: -0.1 }],
      ["promptInfluence above 1", { prompt: "x", model: MODEL, promptInfluence: 1.1 }],
      [
        "a wav output_format",
        { prompt: "x", model: MODEL, params: { output_format: "pcm_44100" } }
      ],
      ["a non-string output_format", { prompt: "x", model: MODEL, params: { output_format: 128 } }]
    ];

    it.each(
      invalid
    )("rejects %s as a terminal 400 without calling fetch", async (_name, request) => {
      const fetchMock = vi.fn();
      const { handler } = handlerWithFetch(fetchMock);

      const rejection = handler.execute(request, {});

      await expect(rejection).rejects.toBeInstanceOf(TerminalProviderError);
      await expect(rejection).rejects.toMatchObject({ status: 400 });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("accepts the inclusive bounds", async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeAudioResponse());
      const { handler } = handlerWithFetch(fetchMock);

      await handler.execute(
        { prompt: "a".repeat(450), model: MODEL, durationMs: 500, promptInfluence: 0 },
        {}
      );
      await handler.execute(
        { prompt: "x", model: MODEL, durationMs: 30_000, promptInfluence: 1 },
        {}
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("names the limits in the error, never the prompt text", async () => {
      const { handler } = handlerWithFetch(vi.fn());
      const secret = "S".repeat(451);

      const rejection = handler.execute({ prompt: secret, model: MODEL }, {});

      await expect(rejection).rejects.toThrow(
        "[ai] ElevenLabs sfx prompt is 451 characters; the limit is 450.\n  Shorten the prompt."
      );
    });

    it("throws the missing-key error before any HTTP call", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const handler = createSfxHandler(createTestCtx({ env: createFakeEnv({}) }));

      await expect(handler.execute({ prompt: "x", model: MODEL }, {})).rejects.toThrow(
        "[ai] ELEVENLABS_API_KEY is not set."
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // execute() — failures and abort
  // -------------------------------------------------------------------------

  describe("execute() — failures and abort", () => {
    it("propagates a classified HTTP failure and logs it redacted", async () => {
      const { handler, log } = handlerWithFetch(
        vi.fn().mockResolvedValue(fakeFailureResponse(503))
      );

      await expect(
        handler.execute({ prompt: "SECRET PROMPT", model: MODEL }, {})
      ).rejects.toBeInstanceOf(RetryableProviderError);

      expect(log.warn).toHaveBeenCalledWith("elevenlabs:sfx:failed", {
        errorType: "retryable",
        status: 503,
        kind: undefined
      });
      const [, payload] = vi.mocked(log.warn).mock.calls[0] as [string, unknown];
      expect(JSON.stringify(payload)).not.toContain("SECRET PROMPT");
    });

    it("passes opts.signal to fetch and rethrows a caller abort unclassified", async () => {
      const controller = new AbortController();
      const fetchMock = vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(init.signal?.reason);
            });
          })
      );
      const { handler } = handlerWithFetch(fetchMock);

      const pending = handler.execute({ prompt: "x", model: MODEL }, { signal: controller.signal });
      controller.abort();

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await expect(pending).rejects.not.toBeInstanceOf(RetryableProviderError);
    });
  });
});
