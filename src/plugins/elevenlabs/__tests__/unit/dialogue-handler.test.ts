import { afterEach, describe, expect, it, vi } from "vitest";
import type { DialogueRequest } from "../../../dialogue/contract";
import { createDialogueHandler } from "../../dialogue/handler";
import { RetryableProviderError, TerminalProviderError } from "../../errors";
import { dialogueBody, fakeJsonResponse, syntheticMp3, syntheticWav } from "../audio-fixtures";
import { createFakeEnv, createFakeLog, createTestCtx } from "./fixtures";

/** Two voices of the spike's H1 recipe. */
const ELEN = "TPIitICAZ8CqlGZ81AKm";
const EGOR = "6A9D8WSMm4rFsg2DWFeE";

/** The spike's H1 recipe: v4 dialogue, stability 0.5, seed 7, language ru. */
const H1: DialogueRequest = {
  model: "eleven_v4",
  language: "ru",
  settings: { stability: 0.5, similarity: 0.75 },
  seed: 7,
  lines: [
    { id: "signAlice", text: "[angry] Я ничего не подписывала!", voice: ELEN },
    { text: "[tired] Ты давно здесь не живёшь.", voice: EGOR }
  ]
};

/** A ctx with an API key and a fake log. */
function keyedCtx(config: Parameters<typeof createTestCtx>[0] = {}) {
  const log = createFakeLog();
  const ctx = createTestCtx({
    env: createFakeEnv({ ELEVENLABS_API_KEY: "test-key" }),
    log,
    ...config
  });
  return { ctx, log };
}

/** Stubs fetch with a dialogue response over a synthetic 100-frame mp3. */
function stubDialogueFetch(audio: Uint8Array = syntheticMp3(100).bytes) {
  const body = dialogueBody(audio, [
    { dialogue_input_index: 0, start_time_seconds: 0.1, end_time_seconds: 1 },
    { dialogue_input_index: 1, start_time_seconds: 1.2, end_time_seconds: 2 }
  ]);
  const fetchMock = vi.fn().mockResolvedValue(fakeJsonResponse(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Runs `estimate` and returns what it threw. */
function estimateError(request: DialogueRequest, config: Parameters<typeof createTestCtx>[0] = {}) {
  try {
    createDialogueHandler(createTestCtx(config)).estimate(request);
  } catch (error) {
    return error;
  }
  throw new Error("expected estimate to throw");
}

/** `count` lines of one character each, one voice per line. */
function linesWithVoices(count: number): DialogueRequest["lines"] {
  return Array.from({ length: count }, (_, index) => ({ text: "a", voice: `voice-${index}` }));
}

/** One line of `count` characters. */
function oneLineOf(count: number): DialogueRequest["lines"] {
  return [{ text: "a".repeat(count), voice: ELEN }];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createDialogueHandler — request", () => {
  it("sends exactly the spike's H1 request: one POST with inputs, model_id, language_code, settings, seed", async () => {
    const fetchMock = stubDialogueFetch();
    const { ctx } = keyedCtx();

    await createDialogueHandler(ctx).execute(H1, {});

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(url).toBe(
      "https://api.elevenlabs.io/v1/text-to-dialogue/with-timestamps?output_format=mp3_44100_128"
    );
    expect(init.body).toBe(
      JSON.stringify({
        inputs: [
          { text: "[angry] Я ничего не подписывала!", voice_id: ELEN },
          { text: "[tired] Ты давно здесь не живёшь.", voice_id: EGOR }
        ],
        model_id: "eleven_v4",
        language_code: "ru",
        settings: { stability: 0.5, similarity: 0.75 },
        seed: 7
      })
    );
  });

  it("does not send line keys the endpoint lacks, and names them in one warning without text", async () => {
    const fetchMock = stubDialogueFetch();
    const { ctx, log } = keyedCtx();
    const lines = [
      { text: "Secret line one", voice: ELEN, settings: { stability: 0.6 }, model: "eleven_v3" },
      { text: "Secret line two", voice: EGOR, settings: { stability: 0.4 } }
    ];

    await createDialogueHandler(ctx).execute({ lines }, {});

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { inputs: unknown[] };
    expect(body.inputs).toEqual([
      { text: "Secret line one", voice_id: ELEN },
      { text: "Secret line two", voice_id: EGOR }
    ]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith("elevenlabs:dialogue:line-fields-ignored", {
      keys: ["model", "settings"]
    });
  });

  it("asks for wav_44100 in the URL and labels the result audio/wav", async () => {
    const fetchMock = stubDialogueFetch(syntheticWav(1000, 3000));
    const { ctx } = keyedCtx();

    const result = await createDialogueHandler(ctx).execute(
      { ...H1, outputFormat: "wav_44100" },
      {}
    );

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("output_format=wav_44100");
    expect(result.mimeType).toBe("audio/wav");
    expect(result.outputs.every(output => output.mimeType === "audio/wav")).toBe(true);
  });
});

describe("createDialogueHandler — result", () => {
  it("returns the mix first, then one output per line, named only when the line has an id", async () => {
    const mp3 = syntheticMp3(100);
    stubDialogueFetch(mp3.bytes);
    const { ctx } = keyedCtx();

    const result = await createDialogueHandler(ctx).execute(H1, {});

    expect(result.audio).toEqual(mp3.bytes);
    expect(result.outputs).toHaveLength(3);
    expect(result.outputs[0]).toEqual({ bytes: mp3.bytes, mimeType: "audio/mpeg" });
    expect(result.outputs[1]?.name).toBe("signAlice");
    expect(result.outputs[2] !== undefined && "name" in result.outputs[2]).toBe(false);
    expect(result.lines.map(line => line.index)).toEqual([0, 1]);
    expect(result.lines[0]?.id).toBe("signAlice");
    expect(result.lines[1] !== undefined && "id" in result.lines[1]).toBe(false);
    const characters = H1.lines.reduce((sum, line) => sum + line.text.length, 0);
    expect(result.costUsd).toBeCloseTo(characters * 0.000_08, 12);
    expect(result.meta).toEqual({ model: "eleven_v4", characters, voices: 2 });
  });

  it("omits a line with no voice segment, lists it in meta.missingLines and warns with its index", async () => {
    const body = dialogueBody(syntheticMp3(100).bytes, [
      { dialogue_input_index: 1, start_time_seconds: 1.2, end_time_seconds: 2 }
    ]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeJsonResponse(body)));
    const { ctx, log } = keyedCtx();

    const result = await createDialogueHandler(ctx).execute(H1, {});

    expect(result.outputs).toHaveLength(2);
    expect(result.meta?.missingLines).toEqual([0]);
    expect(log.warn).toHaveBeenCalledWith("elevenlabs:dialogue:lines-missing", { missing: [0] });
  });
});

describe("createDialogueHandler — refusals before any HTTP call", () => {
  it("prices 2000 characters and refuses 2001 from estimate, never calling fetch", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const handler = createDialogueHandler(createTestCtx());

    expect(handler.estimate({ lines: oneLineOf(2000) }).usd).toBeCloseTo(0.16, 12);
    const error = estimateError({ lines: oneLineOf(2001) });
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as TerminalProviderError).status).toBe(400);
    expect((error as Error).message).toBe(
      "[ai] The dialogue has 2001 characters; ElevenLabs takes at most 2000.\n  Split the scene into two items, or raise elevenlabs.dialogueMaxChars."
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("follows a configured dialogueMaxChars", () => {
    const error = estimateError(
      { lines: [{ text: "abcdef", voice: ELEN }] },
      { config: { dialogueMaxChars: 5 } }
    );

    expect((error as Error).message).toMatch(/has 6 characters; ElevenLabs takes at most 5\./);
  });

  it("accepts 10 voices and refuses 11", () => {
    const handler = createDialogueHandler(createTestCtx());

    expect(() => handler.estimate({ lines: linesWithVoices(10) })).not.toThrow();
    expect((estimateError({ lines: linesWithVoices(11) }) as Error).message).toMatch(
      /^\[ai\] The dialogue uses 11 voices; ElevenLabs takes at most 10\.\n {2}/
    );
  });

  it.each([
    ["a slash", "ep02/signAlice", /Invalid dialogue line id "ep02\/signAlice" \(line 1\)/],
    ["a backslash", String.raw`ep02\x`, /Invalid dialogue line id/],
    ["..", "..", /Invalid dialogue line id "\.\." \(line 1\)/],
    [".", ".", /Invalid dialogue line id "\." \(line 1\)/]
  ])("refuses a line id with %s", (_, id, message) => {
    const error = estimateError({ lines: [{ id, text: "a", voice: ELEN }] });

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toMatch(message);
  });

  it("refuses two lines with one id", () => {
    const lines = [
      { id: "same", text: "a", voice: ELEN },
      { id: "same", text: "b", voice: EGOR }
    ];

    expect((estimateError({ lines }) as Error).message).toBe(
      '[ai] Duplicate dialogue line id "same".\n  Give every line its own id.'
    );
  });

  it("refuses a null or non-object line with the terminal 400, not a TypeError", () => {
    // eslint-disable-next-line unicorn/no-null -- a YAML build file can hold null in lines; that is the case under test
    for (const line of [null, "text", 5]) {
      const lines = [line] as unknown as DialogueRequest["lines"];
      const error = estimateError({ lines });

      expect(error).toBeInstanceOf(TerminalProviderError);
      expect((error as Error).message).toMatch(/line 1 has no text or no voice/);
    }
  });

  it("refuses a scene with no lines, and a line with no text or no voice", () => {
    expect((estimateError({ lines: [] }) as Error).message).toMatch(/no lines\.\n {2}/);
    expect((estimateError({ lines: [{ text: "", voice: ELEN }] }) as Error).message).toMatch(
      /line 1 has no text or no voice/
    );
    expect((estimateError({ lines: [{ text: "a", voice: "" }] }) as Error).message).toMatch(
      /line 1 has no text or no voice/
    );
  });

  it("refuses a pcm or opus output format: those cannot be cut here", () => {
    const error = estimateError({ ...H1, outputFormat: "pcm_44100" });

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toBe(
      '[ai] ElevenLabs dialogue cannot cut "pcm_44100" audio.\n  Use an mp3_* or wav_* output format.'
    );
    expect((estimateError({ ...H1, outputFormat: "opus_48000_64" }) as Error).message).toMatch(
      /cannot cut "opus_48000_64"/
    );
  });

  it("refuses an unknown output format", () => {
    expect((estimateError({ ...H1, outputFormat: "flac_44100" }) as Error).message).toMatch(
      /^\[ai\] Unknown ElevenLabs output format "flac_44100"\.\n {2}Use one of: mp3_22050_32/
    );
  });

  it("refuses a model with no price row, from estimate and from execute", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = { ...H1, model: "eleven_v9" };
    const { ctx } = keyedCtx();

    expect((estimateError(request) as Error).message).toBe(
      '[ai] No price for ElevenLabs model "eleven_v9".\n  Add it to elevenlabs.priceOverrides.'
    );
    await expect(createDialogueHandler(ctx).execute(request, {})).rejects.toBeInstanceOf(
      TerminalProviderError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createDialogueHandler — unreadable response", () => {
  it.each([
    ["a body that is not JSON", undefined],
    ["no audio_base64", { voice_segments: [] }],
    ["no voice_segments array", { audio_base64: "AAAA" }],
    [
      "a segment without times",
      { audio_base64: "AAAA", voice_segments: [{ dialogue_input_index: 0 }] }
    ]
  ])("throws a retryable 502 for %s, and logs only the error class", async (_, body) => {
    const response =
      body === undefined
        ? ({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: () => Promise.reject(new SyntaxError("x"))
          } as unknown as Response)
        : fakeJsonResponse(body);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const { ctx, log } = keyedCtx();

    const error = await createDialogueHandler(ctx)
      .execute(H1, {})
      .catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(RetryableProviderError);
    expect((error as RetryableProviderError).status).toBe(502);
    expect((error as Error).message).toBe(
      "[ai] ElevenLabs returned an unreadable dialogue response."
    );
    expect(log.warn).toHaveBeenCalledWith("elevenlabs:dialogue:failed", {
      errorType: "retryable",
      status: 502,
      kind: undefined
    });
  });
});
