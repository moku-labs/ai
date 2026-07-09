import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { registryPlugin } from "../../../registry";
import { translatePlugin } from "../../index";
import type { TranslateHandler, TranslateRequest } from "../../types";

// ---------------------------------------------------------------------------
// Integration test: translate plugin through the real createApp lifecycle —
// a fake provider registers a TranslateHandler in onInit (mirroring how a
// real provider plugin like elevenlabs/openai wires into the registry), and
// translate resolves + performs its one audited cast to reach it.
// ---------------------------------------------------------------------------

/** A fake translate provider plugin: registers a TranslateHandler for itself in onInit. */
function createFakeTranslateProviderPlugin(name: string, prefix: string) {
  const handler: TranslateHandler = {
    estimate: request => ({ usd: request.text.length * 0.000_02 }),
    execute: async (request: TranslateRequest) => ({
      text: `${prefix}:${request.text}`,
      costUsd: 0.0002
    })
  };
  return coreConfig.createPlugin(name, {
    depends: [registryPlugin],
    onInit: ctx => {
      ctx.require(registryPlugin).register("translate", name, handler);
    }
  });
}

describe("translate integration", () => {
  // The framework coreConfig includes the journal core plugin, whose
  // onStart opens SQLite at its configured path — point it at a temp dir so
  // tests never write .moku/ into the repository root.
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-translate-integration-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function buildFramework() {
    const openaiProviderPlugin = createFakeTranslateProviderPlugin("openai", "es");
    return createCore(coreConfig, {
      plugins: [registryPlugin, openaiProviderPlugin, translatePlugin],
      pluginConfigs: { journal: { path: path.join(tempDir, "journal.db") } }
    });
  }

  it("exercises the full lifecycle: createApp -> start -> generate -> stop", async () => {
    const { createApp } = buildFramework();
    const app = createApp();
    await app.start();

    const result = await app.translate.generate({ text: "Hello", targetLang: "es" });

    expect(result.text).toBe("es:Hello");
    await app.stop();
  });

  it("estimates cost without executing", async () => {
    const { createApp } = buildFramework();
    const app = createApp();
    await app.start();

    const estimate = app.translate.estimate({ text: "Hello", targetLang: "es" });

    expect(estimate).toEqual({ usd: "Hello".length * 0.000_02 });
    await app.stop();
  });

  it("lists providers registered for the translate task", async () => {
    const { createApp } = buildFramework();
    const app = createApp();
    await app.start();

    expect(app.translate.providers()).toEqual(["openai"]);
    await app.stop();
  });

  it("throws the exact two-line error for an unregistered provider", async () => {
    const { createApp } = buildFramework();
    const app = createApp();
    await app.start();

    await expect(
      app.translate.generate({ text: "Hi", targetLang: "es" }, { provider: "unknown-provider" })
    ).rejects.toThrow(
      '[ai] No translate provider named "unknown-provider" is registered.\n  Available: openai.'
    );

    await app.stop();
  });

  describe("types: API signatures", () => {
    it("app.translate methods are typed functions with the spec'd signature", async () => {
      const { createApp } = buildFramework();
      const app = createApp();
      await app.start();

      expectTypeOf(app.translate.generate).toBeFunction();
      expectTypeOf(app.translate.estimate).toBeFunction();
      expectTypeOf(app.translate.providers).toBeFunction();
      expectTypeOf(app.translate.generate).parameter(0).toEqualTypeOf<TranslateRequest>();
      expectTypeOf(app.translate.providers).returns.toEqualTypeOf<string[]>();

      expect(app.translate).toBeDefined();
      await app.stop();
    });

    it("rejects a request missing targetLang", async () => {
      const { createApp } = buildFramework();
      const app = createApp();
      await app.start();

      // @ts-expect-error -- targetLang is required on TranslateRequest
      app.translate.generate({ text: "Hi" });

      expect(app.translate).toBeDefined();
      await app.stop();
    });
  });
});
