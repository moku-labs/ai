import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { registryPlugin } from "../../../registry";
import { PromptGenUnavailableError } from "../../contract";
import { promptGenPlugin } from "../../index";
import type { Config, PromptGenHandler, PromptGenRequest } from "../../types";

// ---------------------------------------------------------------------------
// Integration test (0.7.0): the fallback chain and the lane gate through the
// real createApp lifecycle, with the real limits and log core plugins.
// ---------------------------------------------------------------------------

/** Counts how many `execute` calls of a handler run at the same time. */
type Gauge = { active: number; peak: number; calls: number };

/**
 * A handler that answers after `delayMs`, recording its concurrency in `gauge`.
 *
 * @param name - Provider name prefixed to the answer.
 * @param gauge - Shared concurrency counter.
 * @param delayMs - How long each call takes.
 * @returns The slow handler.
 */
function createSlowHandler(name: string, gauge: Gauge, delayMs = 30): PromptGenHandler {
  return {
    estimate: () => ({ usd: 0 }),
    execute: async (request: PromptGenRequest) => {
      gauge.calls += 1;
      gauge.active += 1;
      gauge.peak = Math.max(gauge.peak, gauge.active);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      gauge.active -= 1;
      return { text: `${name}:${request.prompt}`, costUsd: 0 };
    }
  };
}

/**
 * A handler that always rejects with `error`.
 *
 * @param error - The rejection value.
 * @param gauge - Counts the calls.
 * @returns The failing handler.
 */
function createFailingHandler(error: unknown, gauge: Gauge): PromptGenHandler {
  return {
    estimate: () => ({ usd: 0 }),
    execute: async () => {
      gauge.calls += 1;
      throw error;
    }
  };
}

/**
 * A fake provider plugin that registers `handler` under ("prompt-gen", name).
 *
 * @param name - Provider and plugin name.
 * @param handler - The handler to register.
 * @returns The provider plugin.
 */
function createProviderPlugin(name: string, handler: PromptGenHandler) {
  return coreConfig.createPlugin(name, {
    depends: [registryPlugin],
    onInit: ctx => {
      ctx.require(registryPlugin).register("prompt-gen", name, handler);
    }
  });
}

/**
 * A fresh gauge.
 *
 * @returns A zeroed gauge.
 */
function createGauge(): Gauge {
  return { active: 0, peak: 0, calls: 0 };
}

describe("promptGen integration: fallback and lanes", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-prompt-gen-fallback-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Assembles the framework with two providers and an optional limits override.
   *
   * @param providers - The provider plugins, in registration order.
   * @param limits - Optional `limits` core-plugin config.
   * @param limits.lanes - Per-lane overrides, keyed by lane prefix.
   * @returns The `createCore` result.
   */
  function buildFramework(
    providers: ReturnType<typeof createProviderPlugin>[],
    limits?: { lanes: Record<string, { concurrency: number }> }
  ) {
    return createCore(coreConfig, {
      plugins: [registryPlugin, ...providers, promptGenPlugin],
      pluginConfigs: {
        journal: { path: path.join(tempDir, "journal.db") },
        ...(limits ? { limits } : {})
      }
    });
  }

  it("answers from the fallback when the default is unavailable and logs one prompt-gen:fallback", async () => {
    const claudeGauge = createGauge();
    const missing = new PromptGenUnavailableError(
      "[ai] Claude CLI not found: /nope.\n  Install Claude Code or set claude.bin.",
      "missing"
    );
    const { createApp } = buildFramework([
      createProviderPlugin("claude", createFailingHandler(missing, claudeGauge)),
      createProviderPlugin("codex", createSlowHandler("codex", createGauge(), 1))
    ]);
    const app = createApp({
      pluginConfigs: { promptGen: { defaultProvider: "claude", fallback: ["codex"] } }
    });
    app.log.clearSinks();
    await app.start();

    const result = await app.promptGen.generate({ prompt: "ok?" });

    expect(result).toEqual({ text: "codex:ok?", costUsd: 0, meta: { provider: "codex" } });
    expect(claudeGauge.calls).toBe(1);
    const switches = app.log.trace().filter(entry => entry.event === "prompt-gen:fallback");
    expect(switches).toHaveLength(1);
    expect(switches[0]?.level).toBe("warn");
    expect(switches[0]?.data).toEqual({ from: "claude", to: "codex", reason: "missing" });

    await app.stop();
  });

  it("runs two parallel generate calls one after the other on a lane with concurrency 1", async () => {
    const gauge = createGauge();
    const { createApp } = buildFramework(
      [createProviderPlugin("codex", createSlowHandler("codex", gauge))],
      {
        lanes: { "prompt-gen/codex": { concurrency: 1 } }
      }
    );
    const app = createApp({ pluginConfigs: { promptGen: { defaultProvider: "codex" } } });
    await app.start();

    const results = await Promise.all([
      app.promptGen.generate({ prompt: "a" }),
      app.promptGen.generate({ prompt: "b" })
    ]);

    expect(results.map(result => result.text)).toEqual(["codex:a", "codex:b"]);
    expect(gauge.peak).toBe(1);

    await app.stop();
  });

  it("runs them side by side under the default concurrency", async () => {
    const gauge = createGauge();
    const { createApp } = buildFramework([
      createProviderPlugin("codex", createSlowHandler("codex", gauge))
    ]);
    const app = createApp({ pluginConfigs: { promptGen: { defaultProvider: "codex" } } });
    await app.start();

    await Promise.all([
      app.promptGen.generate({ prompt: "a" }),
      app.promptGen.generate({ prompt: "b" })
    ]);

    expect(gauge.peak).toBe(2);

    await app.stop();
  });

  it("rethrows an abort while queued for a full lane, without switching provider", async () => {
    const codexGauge = createGauge();
    const backupGauge = createGauge();
    const { createApp } = buildFramework(
      [
        createProviderPlugin("codex", createSlowHandler("codex", codexGauge, 50)),
        createProviderPlugin("backup", createSlowHandler("backup", backupGauge, 1))
      ],
      { lanes: { "prompt-gen/codex": { concurrency: 1 } } }
    );
    const app = createApp({
      pluginConfigs: { promptGen: { defaultProvider: "codex", fallback: ["backup"] } }
    });
    app.log.clearSinks();
    await app.start();

    const first = app.promptGen.generate({ prompt: "a" });
    const controller = new AbortController();
    const queued = app.promptGen.generate({ prompt: "b" }, { signal: controller.signal });
    controller.abort();

    await expect(queued).rejects.toBe(controller.signal.reason);
    await expect(first).resolves.toMatchObject({ text: "codex:a" });
    expect(codexGauge.calls).toBe(1);
    expect(backupGauge.calls).toBe(0);
    expect(app.log.trace().some(entry => entry.event === "prompt-gen:fallback")).toBe(false);

    await app.stop();
  });

  it("types fallback as a list of provider names", () => {
    expectTypeOf<Config["fallback"]>().toEqualTypeOf<string[]>();
  });
});
