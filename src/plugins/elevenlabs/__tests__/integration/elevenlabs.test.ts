import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvProvider } from "@moku-labs/common";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { registryPlugin } from "../../../registry";
import { voiceoverPlugin } from "../../../voiceover";
import type { VoiceoverHandler } from "../../../voiceover/types";
import { elevenlabsPlugin } from "../../index";
import type { ElevenlabsContext } from "../../types";
import { RetryableProviderError } from "../../types";
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
    plugins: [registryPlugin, voiceoverPlugin, elevenlabsPlugin],
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

    it("createVoiceoverHandler accepts an ElevenlabsContext", () => {
      expectTypeOf(createVoiceoverHandler).parameter(0).toEqualTypeOf<ElevenlabsContext>();
    });
  });
});
