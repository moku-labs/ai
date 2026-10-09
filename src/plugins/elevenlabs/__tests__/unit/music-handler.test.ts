import { afterEach, describe, expect, it, vi } from "vitest";
import type { MusicRequest } from "../../../music/contract";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "../../errors";
import { createMusicHandler } from "../../music/handler";
import { createFakeEnv, createFakeLog, createTestCtx } from "./fixtures";

/** A model that takes both a prompt and a chunk plan. */
const MODEL = "music_v2_5";

/** A prompt request every check accepts. */
const PROMPT_REQUEST: MusicRequest = {
  prompt: "tense synth pulse",
  model: MODEL,
  lengthMs: 65_000
};

/** A chunk-plan request every check accepts: 40 s + 25 s = 65 s. */
const PLAN_REQUEST: MusicRequest = {
  prompt: "tense synth pulse",
  model: MODEL,
  lengthMs: 65_000,
  chunks: [
    { text: "[Intro]", durationMs: 40_000, styles: ["synthwave", "dark"], avoid: ["vocals"] },
    { text: "[Drop]", durationMs: 25_000, styles: ["driving bass"] }
  ]
};

/** A successful `/v1/music` response carrying `bytes`. */
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

/** A failed ElevenLabs response with the given status, headers and JSON body. */
function fakeFailureResponse(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {}
): Response {
  const fake = {
    ok: false,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
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
  return { handler: createMusicHandler(ctx), log };
}

/**
 * Reads the URL, the init and the parsed JSON body of the first fetch call.
 *
 * @param fetchMock - The fetch mock that was called.
 * @returns The URL, the body and the init.
 */
function firstCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, body: JSON.parse(init.body as string) as Record<string, unknown>, init };
}

/**
 * Runs `execute` and returns what it rejected with.
 *
 * @param handler - The handler under test.
 * @param request - The request to execute.
 * @returns The rejection.
 */
async function rejectionOf(
  handler: ReturnType<typeof createMusicHandler>,
  request: MusicRequest
): Promise<unknown> {
  try {
    await handler.execute?.(request, {});
  } catch (error) {
    return error;
  }
  throw new Error("execute() did not reject");
}

describe("createMusicHandler", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers estimate + execute and no submit + poll: /v1/music is synchronous", () => {
    const handler = createMusicHandler(createTestCtx());

    expect(typeof handler.execute).toBe("function");
    expect(handler.submit).toBeUndefined();
    expect(handler.poll).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // estimate() — every started minute at the music:<model> price
  // -------------------------------------------------------------------------

  describe("estimate()", () => {
    it("bills every started minute at the bundled $0.15", () => {
      const handler = createMusicHandler(createTestCtx());

      expect(handler.estimate(PROMPT_REQUEST).usd).toBeCloseTo(0.3, 10);
      expect(handler.estimate({ ...PROMPT_REQUEST, lengthMs: 60_000 }).usd).toBeCloseTo(0.15, 10);
      expect(handler.estimate({ ...PROMPT_REQUEST, lengthMs: 600_000 }).usd).toBeCloseTo(1.5, 10);
    });

    it.each(["music_v1", "music_v2", "music_v2_5"])("prices model %s", model => {
      const handler = createMusicHandler(createTestCtx());

      expect(handler.estimate({ ...PROMPT_REQUEST, model, lengthMs: 30_000 }).usd).toBe(0.15);
    });

    it("reads a music:<model> price override", () => {
      const handler = createMusicHandler(
        createTestCtx({ config: { priceOverrides: { "music:music_v2_5": 0.2 } } })
      );

      expect(handler.estimate(PROMPT_REQUEST).usd).toBeCloseTo(0.4, 10);
    });

    it("refuses the fal alias: the model is an ElevenLabs model id", () => {
      const handler = createMusicHandler(createTestCtx());

      expect(() => handler.estimate({ ...PROMPT_REQUEST, model: "elevenlabs-music-v2.5" })).toThrow(
        /does not support model "elevenlabs-music-v2.5".*\n.*music_v1, music_v2, music_v2_5/
      );
    });

    it.each([2999, 600_001, 60_000.5, Number.NaN])("refuses lengthMs %s", lengthMs => {
      const handler = createMusicHandler(createTestCtx());

      expect(() => handler.estimate({ ...PROMPT_REQUEST, lengthMs })).toThrow(
        TerminalProviderError
      );
    });

    it("does not check the fields only execute sends", () => {
      const handler = createMusicHandler(createTestCtx());

      expect(handler.estimate({ ...PROMPT_REQUEST, seed: 7 }).usd).toBeCloseTo(0.3, 10);
    });
  });

  // -------------------------------------------------------------------------
  // execute() — request mapping
  // -------------------------------------------------------------------------

  describe("execute() request mapping", () => {
    it("POSTs a prompt request to /v1/music with the key in xi-api-key", async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeAudioResponse());
      const { handler } = handlerWithFetch(fetchMock);

      await handler.execute?.(PROMPT_REQUEST, {});

      const { url, body, init } = firstCall(fetchMock);
      expect(url).toBe("https://api.elevenlabs.io/v1/music");
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("xi-api-key")).toBe("test-key");
      expect(body).toEqual({
        prompt: "tense synth pulse",
        music_length_ms: 65_000,
        model_id: MODEL,
        force_instrumental: true
      });
    });

    it("sends force_instrumental false when params say so", async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeAudioResponse());
      const { handler } = handlerWithFetch(fetchMock);

      await handler.execute?.({ ...PROMPT_REQUEST, params: { force_instrumental: false } }, {});

      expect(firstCall(fetchMock).body.force_instrumental).toBe(false);
    });

    it("maps chunks to composition_plan.chunks, without prompt and music_length_ms", async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeAudioResponse());
      const { handler } = handlerWithFetch(fetchMock);

      await handler.execute?.({ ...PLAN_REQUEST, seed: 42 }, {});

      expect(firstCall(fetchMock).body).toEqual({
        composition_plan: {
          chunks: [
            {
              text: "[Intro]",
              duration_ms: 40_000,
              positive_styles: ["synthwave", "dark"],
              negative_styles: ["vocals"]
            },
            { text: "[Drop]", duration_ms: 25_000, positive_styles: ["driving bass"] }
          ]
        },
        model_id: MODEL,
        seed: 42
      });
    });

    it("sends no output_format query by default, and the mp3 format when set", async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeAudioResponse());
      const { handler } = handlerWithFetch(fetchMock);

      const result = await handler.execute?.(
        { ...PROMPT_REQUEST, params: { output_format: "mp3_44100_192" } },
        {}
      );

      expect(firstCall(fetchMock).url).toBe(
        "https://api.elevenlabs.io/v1/music?output_format=mp3_44100_192"
      );
      expect(result?.meta).toEqual({
        model: MODEL,
        lengthMs: 65_000,
        outputFormat: "mp3_44100_192"
      });
    });

    it("returns the mp3 bytes, the cost and the metadata, and logs the success", async () => {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const { handler, log } = handlerWithFetch(
        vi.fn().mockResolvedValue(fakeAudioResponse(bytes))
      );

      const result = await handler.execute?.(PROMPT_REQUEST, {});

      expect(result).toEqual({
        audio: bytes,
        mimeType: "audio/mpeg",
        costUsd: 0.3,
        meta: { model: MODEL, lengthMs: 65_000 }
      });
      expect(log.info).toHaveBeenCalledWith("elevenlabs:music:done", {
        model: MODEL,
        lengthMs: 65_000,
        bytes: 4
      });
    });

    it("waits config.musicTimeoutMs, not the short timeoutMs", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      const { handler } = handlerWithFetch(vi.fn().mockResolvedValue(fakeAudioResponse()));

      await handler.execute?.(PROMPT_REQUEST, {});

      expect(timeoutSpy).toHaveBeenCalledWith(600_000);
      timeoutSpy.mockRestore();
    });

    it("throws the pinned error without a key, before any HTTP call", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const handler = createMusicHandler(createTestCtx());

      const caught = await rejectionOf(handler, PROMPT_REQUEST);

      expect((caught as Error).message).toContain("ELEVENLABS_API_KEY is not set");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // execute() — what the API cannot do is refused before any HTTP call
  // -------------------------------------------------------------------------

  describe("execute() refusals", () => {
    const refused: [string, MusicRequest, RegExp][] = [
      ["a seed next to a prompt", { ...PROMPT_REQUEST, seed: 7 }, /seed only with chunks/],
      ["an empty prompt", { ...PROMPT_REQUEST, prompt: "  " }, /prompt is empty/],
      ["chunks on music_v1", { ...PLAN_REQUEST, model: "music_v1" }, /does not take chunks/],
      [
        "chunks that do not add up to lengthMs",
        { ...PLAN_REQUEST, lengthMs: 70_000 },
        /add up to 65000 ms, not lengthMs 70000/
      ],
      [
        "a chunk shorter than 3 s",
        {
          ...PLAN_REQUEST,
          chunks: [
            { text: "a", durationMs: 2000, styles: ["x"] },
            { text: "b", durationMs: 63_000, styles: ["x"] }
          ]
        },
        /chunks\.0\.durationMs/
      ],
      [
        "a chunk longer than 120 s",
        {
          ...PLAN_REQUEST,
          lengthMs: 130_000,
          chunks: [{ text: "a", durationMs: 130_000, styles: ["x"] }]
        },
        /chunks\.0\.durationMs/
      ],
      [
        "a chunk text of over 30 lines",
        {
          ...PLAN_REQUEST,
          chunks: [{ text: "la\n".repeat(31), durationMs: 65_000, styles: ["x"] }]
        },
        /chunks\.0\.text takes at most 30 lines/
      ],
      [
        "a chunk line of over 200 characters",
        {
          ...PLAN_REQUEST,
          chunks: [{ text: "a".repeat(201), durationMs: 65_000, styles: ["x"] }]
        },
        /at most 200 characters/
      ],
      [
        "force_instrumental next to chunks",
        { ...PLAN_REQUEST, params: { force_instrumental: true } },
        /force_instrumental only with a prompt/
      ],
      ["a fractional seed", { ...PLAN_REQUEST, seed: 1.5 }, /seed must be a whole number/],
      [
        "a force_instrumental that is not a boolean",
        { ...PROMPT_REQUEST, params: { force_instrumental: "yes" } },
        /force_instrumental must be true or false/
      ],
      [
        "an output format that is not mp3",
        { ...PROMPT_REQUEST, params: { output_format: "pcm_44100" } },
        /"pcm_44100" is not an mp3 format/
      ],
      [
        "an output format that is not a string",
        { ...PROMPT_REQUEST, params: { output_format: 5 } },
        /of type number is not an mp3 format/
      ],
      [
        "an unknown params key",
        { ...PROMPT_REQUEST, params: { store_for_inpainting: true } },
        /does not read params\.store_for_inpainting/
      ],
      ["an unknown model", { ...PROMPT_REQUEST, model: "suno" }, /does not support model "suno"/],
      ["a length over 10 minutes", { ...PROMPT_REQUEST, lengthMs: 600_001 }, /lengthMs must be/]
    ];

    it.each(
      refused
    )("refuses %s with a terminal 400 and no HTTP call", async (_name, request, message) => {
      const fetchMock = vi.fn();
      const { handler } = handlerWithFetch(fetchMock);

      const caught = await rejectionOf(handler, request);

      expect(caught).toBeInstanceOf(TerminalProviderError);
      expect((caught as TerminalProviderError).status).toBe(400);
      expect((caught as Error).message).toMatch(message);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a missing price before any HTTP call", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const ctx = createTestCtx({
        state: { prices: {} },
        env: createFakeEnv({ ELEVENLABS_API_KEY: "test-key" })
      });

      const caught = await rejectionOf(createMusicHandler(ctx), PROMPT_REQUEST);

      expect(caught).toBeInstanceOf(TerminalProviderError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // execute() — error mapping
  // -------------------------------------------------------------------------

  describe("execute() error mapping", () => {
    it.each([401, 403, 404, 422])("maps HTTP %s to a terminal error", async status => {
      const { handler, log } = handlerWithFetch(
        vi.fn().mockResolvedValue(fakeFailureResponse(status))
      );

      const caught = await rejectionOf(handler, PROMPT_REQUEST);

      expect(caught).toBeInstanceOf(TerminalProviderError);
      expect((caught as TerminalProviderError).status).toBe(status);
      expect(log.warn).toHaveBeenCalledWith("elevenlabs:music:failed", {
        errorType: "terminal",
        status
      });
    });

    it("maps HTTP 429 to a retryable error with the Retry-After delay", async () => {
      const { handler } = handlerWithFetch(
        vi.fn().mockResolvedValue(fakeFailureResponse(429, {}, { "retry-after": "3" }))
      );

      const caught = await rejectionOf(handler, PROMPT_REQUEST);

      expect(caught).toBeInstanceOf(RetryableProviderError);
      expect((caught as RetryableProviderError).status).toBe(429);
      expect((caught as RetryableProviderError).retryAfterMs).toBe(3000);
    });

    it.each([500, 502, 503])("maps HTTP %s to a retryable error", async status => {
      const { handler } = handlerWithFetch(vi.fn().mockResolvedValue(fakeFailureResponse(status)));

      const caught = await rejectionOf(handler, PROMPT_REQUEST);

      expect(caught).toBeInstanceOf(RetryableProviderError);
      expect((caught as RetryableProviderError).status).toBe(status);
    });

    it("maps a network failure to a retryable error of kind network", async () => {
      const { handler } = handlerWithFetch(
        vi.fn().mockRejectedValue(new TypeError("fetch failed"))
      );

      const caught = await rejectionOf(handler, PROMPT_REQUEST);

      expect(caught).toBeInstanceOf(RetryableProviderError);
      expect((caught as RetryableProviderError).kind).toBe("network");
    });

    it.each([
      ["bad_prompt", PROMPT_REQUEST],
      ["bad_composition_plan", PLAN_REQUEST],
      ["content_policy_violation", PROMPT_REQUEST]
    ])("maps a %s refusal to a flagged error, never echoing the suggestion", async (status, request) => {
      const body = { detail: { status, data: { prompt_suggestion: "SUGGESTED TEXT" } } };
      const { handler, log } = handlerWithFetch(
        vi.fn().mockResolvedValue(fakeFailureResponse(400, body))
      );

      const caught = await rejectionOf(handler, request);

      expect(caught).toBeInstanceOf(FlaggedProviderError);
      expect((caught as FlaggedProviderError).kind).toBe("content-policy");
      expect((caught as Error).message).not.toContain("SUGGESTED TEXT");
      expect(log.warn).toHaveBeenCalledWith("elevenlabs:music:failed", {
        errorType: "flagged",
        kind: "content-policy"
      });
    });

    it("propagates a caller abort unchanged", async () => {
      const controller = new AbortController();
      const abortError = new DOMException("aborted", "AbortError");
      const { handler } = handlerWithFetch(
        vi.fn().mockImplementation(() => {
          controller.abort();
          return Promise.reject(abortError);
        })
      );

      await expect(handler.execute?.(PROMPT_REQUEST, { signal: controller.signal })).rejects.toBe(
        abortError
      );
    });
  });
});
