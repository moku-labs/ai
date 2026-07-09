import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { registryPlugin } from "../../../registry";
import { voiceoverPlugin } from "../../index";
import type { VoiceoverHandler, VoiceoverRequest } from "../../types";

// ---------------------------------------------------------------------------
// Integration test: voiceover plugin through the real createApp lifecycle —
// a fake provider registers in onInit, and app.voiceover.* resolves,
// audits, and dispatches to it end to end.
// ---------------------------------------------------------------------------

/** Fake voiceover handler that echoes the request's text into the audio bytes' length. */
function createFakeVoiceoverHandler(providerName: string): VoiceoverHandler {
  return {
    estimate: (request: VoiceoverRequest) => ({ usd: request.text.length * 0.0001 }),
    execute: async (request: VoiceoverRequest) => ({
      audio: new Uint8Array(request.text.length),
      mimeType: "audio/mpeg",
      costUsd: request.text.length * 0.0001,
      meta: { provider: providerName, characters: request.text.length }
    })
  };
}

/** A fake provider plugin: registers a "voiceover" handler for itself in onInit. */
function createFakeProviderPlugin(name: string) {
  return coreConfig.createPlugin(name, {
    depends: [registryPlugin],
    onInit: ctx => {
      ctx.require(registryPlugin).register("voiceover", name, createFakeVoiceoverHandler(name));
    }
  });
}

/**
 * Assembles a fresh framework wiring registry + voiceover + the given extra
 * (fake provider) plugins. `journal` is a core plugin baked into the real
 * `coreConfig`, so its `path` is pinned at `dbPath` so its `onStart` never
 * writes `.moku/journal.db` into the repo's real cwd.
 */
function buildFramework(
  dbPath: string,
  extraPlugins: ReturnType<typeof createFakeProviderPlugin>[]
) {
  return createCore(coreConfig, {
    plugins: [registryPlugin, voiceoverPlugin, ...extraPlugins],
    pluginConfigs: { journal: { path: dbPath } }
  });
}

describe("voiceover integration", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "moku-voiceover-integration-"));
    dbPath = path.join(tempDir, "journal.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("exercises the full lifecycle: createApp -> start -> generate -> stop", async () => {
    const fakeProviderPlugin = createFakeProviderPlugin("elevenlabs");
    const { createApp } = buildFramework(dbPath, [fakeProviderPlugin]);
    const app = createApp();

    await app.start();

    const result = await app.voiceover.generate({ text: "Hello, world!", voice: "en-US-1" });

    expect(result.mimeType).toBe("audio/mpeg");
    expect(result.audio).toHaveLength("Hello, world!".length);

    await app.stop();
  });

  it("providers() reflects registration, in registration order", async () => {
    const providerA = createFakeProviderPlugin("elevenlabs");
    const providerB = createFakeProviderPlugin("openai");
    const { createApp } = buildFramework(dbPath, [providerA, providerB]);
    const app = createApp();

    await app.start();

    expect(app.voiceover.providers()).toEqual(["elevenlabs", "openai"]);

    await app.stop();
  });

  it("uses the configured defaultProvider when a request omits opts.provider", async () => {
    const fakeProviderPlugin = createFakeProviderPlugin("elevenlabs");
    const { createApp } = buildFramework(dbPath, [fakeProviderPlugin]);
    const app = createApp({ pluginConfigs: { voiceover: { defaultProvider: "elevenlabs" } } });

    await app.start();

    const { usd } = app.voiceover.estimate({ text: "hi", voice: "en-US-1" });

    expect(usd).toBeCloseTo(0.0002, 6);

    await app.stop();
  });

  it("throws the pinned two-line error for a provider that was never registered", async () => {
    const { createApp } = buildFramework(dbPath, []);
    const app = createApp();

    await app.start();

    await expect(
      app.voiceover.generate({ text: "hi", voice: "v1" }, { provider: "acme" })
    ).rejects.toThrow('[ai] No voiceover provider named "acme" is registered.\n  Available: none.');

    await app.stop();
  });

  // -------------------------------------------------------------------------
  // types: app.voiceover.generate is fully typed
  // -------------------------------------------------------------------------

  it("app.voiceover.generate's request parameter rejects a literal missing text", async () => {
    const { createApp } = buildFramework(dbPath, [createFakeProviderPlugin("elevenlabs")]);
    const app = createApp();
    await app.start();

    expectTypeOf(app.voiceover.generate).parameter(0).toEqualTypeOf<VoiceoverRequest>();
    // @ts-expect-error -- missing required "text" field
    const badRequest: VoiceoverRequest = { voice: "en-US-1" };
    expect(badRequest).toBeDefined();

    await app.stop();
  });
});
