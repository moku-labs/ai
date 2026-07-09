import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { registryPlugin } from "../../../registry";
import { promptGenPlugin } from "../../index";
import type { PromptGenHandler, PromptGenRequest, PromptGenResult } from "../../types";

// ---------------------------------------------------------------------------
// Integration test: promptGen plugin through the real createApp lifecycle —
// a fake provider registers a PromptGenHandler for "prompt-gen" in onInit,
// and app.promptGen.generate()/estimate()/providers() round-trip through it.
// ---------------------------------------------------------------------------

/** A fake prompt-gen provider handler used across the integration scenarios. */
function createFakeHandler(name: string): PromptGenHandler {
  return {
    estimate: (request: PromptGenRequest) => ({ usd: request.prompt.length / 1000 }),
    execute: async (request: PromptGenRequest): Promise<PromptGenResult> => ({
      text: `${name}:${request.prompt}`,
      costUsd: request.prompt.length / 1000,
      meta: { provider: name }
    })
  };
}

/** A fake provider plugin: registers a "prompt-gen" handler for itself in onInit. */
function createFakeProviderPlugin(name: string) {
  return coreConfig.createPlugin(name, {
    depends: [registryPlugin],
    onInit: ctx => {
      ctx.require(registryPlugin).register("prompt-gen", name, createFakeHandler(name));
    }
  });
}

describe("promptGen integration", () => {
  // The framework coreConfig includes the journal core plugin, whose onStart
  // opens SQLite at its configured path — point it at a temp dir so tests
  // never write .moku/ into the repository root.
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-prompt-gen-integration-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /** Assembles a fresh framework with a fake "openai" prompt-gen provider registered. */
  function buildFramework() {
    return createCore(coreConfig, {
      plugins: [registryPlugin, createFakeProviderPlugin("openai"), promptGenPlugin],
      pluginConfigs: { journal: { path: path.join(tempDir, "journal.db") } }
    });
  }

  it("exercises the full lifecycle: createApp -> start -> generate() -> stop", async () => {
    const { createApp } = buildFramework();
    const app = createApp();

    await app.start();

    const result = await app.promptGen.generate({ prompt: "hello" });

    expect(result).toEqual({
      text: "openai:hello",
      costUsd: "hello".length / 1000,
      meta: { provider: "openai" }
    });

    await app.stop();
  });

  it("uses config.defaultProvider by default, and honors an explicit opts.provider override", async () => {
    const { createApp } = buildFramework();
    const app = createApp();
    await app.start();

    app.registry.register("prompt-gen", "anthropic", createFakeHandler("anthropic"));

    const withDefault = await app.promptGen.generate({ prompt: "x" });
    const withOverride = await app.promptGen.generate({ prompt: "x" }, { provider: "anthropic" });

    expect(withDefault.text).toBe("openai:x");
    expect(withOverride.text).toBe("anthropic:x");

    await app.stop();
  });

  it("estimate() returns a cost without executing the provider", async () => {
    const { createApp } = buildFramework();
    const app = createApp();
    await app.start();

    const estimateResult = app.promptGen.estimate({ prompt: "12345" });

    expect(estimateResult).toEqual({ usd: 0.005 });

    await app.stop();
  });

  it("providers() lists registered prompt-gen providers", async () => {
    const { createApp } = buildFramework();
    const app = createApp();
    await app.start();

    expect(app.promptGen.providers()).toEqual(["openai"]);

    await app.stop();
  });

  it("throws the exact two-line error for an unregistered provider name", async () => {
    const { createApp } = buildFramework();
    const app = createApp();
    await app.start();

    await expect(app.promptGen.generate({ prompt: "hi" }, { provider: "missing" })).rejects.toThrow(
      '[ai] No prompt-gen provider named "missing" is registered.\n  Available: openai.'
    );

    await app.stop();
  });

  describe("types: app.promptGen", () => {
    it("generate is typed to accept PromptGenRequest and resolve PromptGenResult", async () => {
      const { createApp } = buildFramework();
      const app = createApp();
      await app.start();

      expectTypeOf(app.promptGen.generate).parameter(0).toEqualTypeOf<PromptGenRequest>();
      expectTypeOf(app.promptGen.generate).returns.resolves.toEqualTypeOf<PromptGenResult>();

      await app.stop();
    });

    it("rejects a request missing the required prompt field at compile time", async () => {
      const { createApp } = buildFramework();
      const app = createApp();
      await app.start();

      // @ts-expect-error -- prompt is required on PromptGenRequest
      await expect(app.promptGen.generate({ system: "only-system" })).rejects.toBeDefined();

      await app.stop();
    });
  });
});
