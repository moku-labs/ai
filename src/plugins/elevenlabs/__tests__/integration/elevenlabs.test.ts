import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvProvider } from "@moku-labs/common";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { musicPlugin } from "../../../music";
import type { MusicHandler } from "../../../music/contract";
import { registryPlugin } from "../../../registry";
import type { SfxHandler } from "../../../sfx/contract";
import { voiceoverPlugin } from "../../../voiceover";
import type { VoiceoverHandler } from "../../../voiceover/types";
import { FlaggedProviderError, RetryableProviderError } from "../../errors";
import { elevenlabsPlugin } from "../../index";
import { createMusicHandler } from "../../music/handler";
import { createSfxHandler } from "../../sfx/handler";
import type { ElevenlabsContext } from "../../types";
import { createVoiceoverHandler } from "../../voiceover/handler";

// ---------------------------------------------------------------------------
// Integration test: elevenlabs provider through the real createApp lifecycle
// — registered in onInit via registry, consumed end-to-end through the
// voiceover task facade. Fetch is mocked at the boundary (vi.stubGlobal);
// NO real network calls anywhere in this suite.
// ---------------------------------------------------------------------------

/** A successful ElevenLabs TTS response carrying `bytes` as the audio body. */
function fakeAudioResponse(bytes: Uint8Array): Response {
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

/** A failed ElevenLabs response whose JSON body carries `detail.status`. */
function fakeRefusalResponse(status: string): Response {
  const fake = {
    ok: false,
    status: 400,
    headers: new Headers(),
    json: () => Promise.resolve({ detail: { status, data: { prompt_suggestion: "reworded" } } }),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0))
  };
  return fake as unknown as Response;
}

/** A fixture `EnvProvider` resolving `ELEVENLABS_API_KEY` without touching real `process.env`. */
const fixtureEnvProvider: EnvProvider = {
  name: "elevenlabs-integration-fixture",
  load: () => ({ ELEVENLABS_API_KEY: "test-key" })
};

/**
 * Assembles a fresh framework wiring registry + voiceover + elevenlabs.
 * `journal` (core plugin) is pinned to `dbPath` so `onStart` never writes
 * `.moku/journal.db` into the repo's real cwd; `env` (also core) is pinned
 * to the fixture provider above so `configured`/`execute()` see a resolved
 * API key without touching real `process.env`. Both can only be overridden
 * here, at `createCore` — `createApp`'s `pluginConfigs` is typed to regular
 * plugins only.
 */
function buildFramework(dbPath: string) {
  return createCore(coreConfig, {
    plugins: [registryPlugin, voiceoverPlugin, musicPlugin, elevenlabsPlugin],
    pluginConfigs: {
      journal: { path: dbPath },
      env: { providers: [fixtureEnvProvider] }
    }
  });
}

describe("elevenlabs integration", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "moku-elevenlabs-integration-"));
    dbPath = path.join(tempDir, "journal.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Runtime: onInit registration
  // -------------------------------------------------------------------------

  it("registers under the voiceover task in onInit, visible in app.voiceover.providers()", async () => {
    const { createApp } = buildFramework(dbPath);
    const app = createApp();

    await app.start();

    expect(app.voiceover.providers()).toEqual(["elevenlabs"]);

    await app.stop();
  });

  it("registers under the sfx task after voiceover in onInit", async () => {
    const { createApp } = buildFramework(dbPath);
    const app = createApp();

    await app.start();

    expect(app.registry.tasks()).toEqual(["voiceover", "sfx", "music"]);
    expect(app.registry.providers("sfx")).toEqual(["elevenlabs"]);
    expect(app.registry.providers("music")).toEqual(["elevenlabs"]);

    await app.stop();
  });

  // -------------------------------------------------------------------------
  // Runtime: end-to-end generation through the voiceover facade
  // -------------------------------------------------------------------------

  it("generates audio end-to-end through app.voiceover.generate()", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeAudioResponse(new Uint8Array([1, 2, 3]))));
    const { createApp } = buildFramework(dbPath);
    const app = createApp({
      pluginConfigs: { elevenlabs: { priceOverrides: { eleven_multilingual_v2: 0.001 } } }
    });
    await app.start();

    const result = await app.voiceover.generate(
      { text: "Hello, world!", voice: "voice-1" },
      { provider: "elevenlabs" }
    );

    expect(result.audio).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.mimeType).toBe("audio/mpeg");
    expect(result.costUsd).toBeCloseTo("Hello, world!".length * 0.001, 10);

    await app.stop();
  });

  // -------------------------------------------------------------------------
  // Runtime: music through the music facade, with a stubbed HTTP client
  // -------------------------------------------------------------------------

  it("generates a track end-to-end through app.music.generate()", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeAudioResponse(new Uint8Array([4, 5, 6])));
    vi.stubGlobal("fetch", fetchMock);
    const { createApp } = buildFramework(dbPath);
    const app = createApp();
    await app.start();

    const result = await app.music.generate(
      { prompt: "tense synth pulse", model: "music_v2_5", lengthMs: 65_000 },
      { provider: "elevenlabs" }
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/music");
    expect(new Headers(init.headers).get("xi-api-key")).toBe("test-key");
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: "tense synth pulse",
      music_length_ms: 65_000,
      model_id: "music_v2_5",
      force_instrumental: true
    });
    expect(result.audio).toEqual(new Uint8Array([4, 5, 6]));
    expect(result.mimeType).toBe("audio/mpeg");
    expect(result.costUsd).toBeCloseTo(0.3, 10);

    await app.stop();
  });

  it("app.music.estimate() reads elevenlabs's own price table, without a network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { createApp } = buildFramework(dbPath);
    const app = createApp({
      pluginConfigs: { elevenlabs: { priceOverrides: { "music:music_v2": 0.2 } } }
    });
    await app.start();

    const { usd } = app.music.estimate(
      { prompt: "calm piano", model: "music_v2", lengthMs: 120_000 },
      { provider: "elevenlabs" }
    );

    expect(usd).toBeCloseTo(0.4, 10);
    expect(fetchMock).not.toHaveBeenCalled();

    await app.stop();
  });

  it("propagates a bad_prompt refusal as FlaggedProviderError through app.music.generate()", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeRefusalResponse("bad_prompt")));
    const { createApp } = buildFramework(dbPath);
    const app = createApp();
    await app.start();

    await expect(
      app.music.generate(
        { prompt: "a song in the style of a famous band", model: "music_v1", lengthMs: 30_000 },
        { provider: "elevenlabs" }
      )
    ).rejects.toBeInstanceOf(FlaggedProviderError);

    await app.stop();
  });

  // -------------------------------------------------------------------------
  // Runtime: estimate() through the voiceover facade matches the handler's own math
  // -------------------------------------------------------------------------

  it("app.voiceover.estimate() delegates to elevenlabs's own price table", async () => {
    const { createApp } = buildFramework(dbPath);
    const app = createApp({
      pluginConfigs: { elevenlabs: { priceOverrides: { eleven_multilingual_v2: 0.002 } } }
    });
    await app.start();

    const { usd } = app.voiceover.estimate(
      { text: "hi", voice: "voice-1" },
      { provider: "elevenlabs" }
    );

    expect(usd).toBeCloseTo(2 * 0.002, 10);

    await app.stop();
  });

  // -------------------------------------------------------------------------
  // Runtime: app.elevenlabs.info()
  // -------------------------------------------------------------------------

  it("exposes app.elevenlabs.info() reflecting the configured API key + price table", async () => {
    const { createApp } = buildFramework(dbPath);
    const app = createApp();
    await app.start();

    const info = app.elevenlabs.info();

    expect(info.provider).toBe("elevenlabs");
    expect(info.configured).toBe(true);
    expect(info.models.length).toBeGreaterThan(0);

    await app.stop();
  });

  // -------------------------------------------------------------------------
  // Runtime: classified provider errors propagate through the facade
  // -------------------------------------------------------------------------

  it("propagates a classified RetryableProviderError through app.voiceover.generate()", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeFailureResponse(500)));
    const { createApp } = buildFramework(dbPath);
    const app = createApp();
    await app.start();

    await expect(
      app.voiceover.generate({ text: "hi", voice: "voice-1" }, { provider: "elevenlabs" })
    ).rejects.toBeInstanceOf(RetryableProviderError);

    await app.stop();
  });

  // -------------------------------------------------------------------------
  // Types: the registered handler satisfies VoiceoverHandler structurally
  // -------------------------------------------------------------------------

  describe("types", () => {
    it("createVoiceoverHandler's return value satisfies VoiceoverHandler structurally", () => {
      expectTypeOf(createVoiceoverHandler).returns.toEqualTypeOf<VoiceoverHandler>();
    });

    it("createSfxHandler's return value satisfies SfxHandler structurally", () => {
      expectTypeOf(createSfxHandler).returns.toEqualTypeOf<SfxHandler>();
      expectTypeOf(createSfxHandler).parameter(0).toEqualTypeOf<ElevenlabsContext>();
    });

    it("createMusicHandler's return value satisfies MusicHandler structurally", () => {
      expectTypeOf(createMusicHandler).returns.toEqualTypeOf<MusicHandler>();
      expectTypeOf(createMusicHandler).parameter(0).toEqualTypeOf<ElevenlabsContext>();
    });

    it("createVoiceoverHandler accepts an ElevenlabsContext", () => {
      expectTypeOf(createVoiceoverHandler).parameter(0).toEqualTypeOf<ElevenlabsContext>();
    });
  });
});
