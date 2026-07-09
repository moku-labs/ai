import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { coreConfig, createCore, createPlugin } from "../../../../config";
import { buildfilePlugin } from "../../../buildfile";
import { registryPlugin } from "../../../registry";
import { runnerPlugin } from "../../index";
import type { ExecutableHandler, RunEvent, RunResult, RunResultStatus } from "../../types";

/**
 * Assembles a fresh framework wiring registry + buildfile + runner as
 * regular plugins, with `journal`/`store` (core plugins) pinned into
 * `tempDir` so no test ever writes `.moku/` into the repo root. Core-plugin
 * config (e.g. `limits`) can only be overridden here, at `createCore` —
 * `createApp`'s `pluginConfigs` is typed to regular plugins only.
 *
 * @param tempDir - The per-test mkdtemp directory.
 * @param extraPluginConfigs - Additional core-plugin config overrides (e.g. `{ limits: {...} }`).
 * @returns The framework's `createCore` result (`createApp`/`createPlugin`).
 * @example
 * ```ts
 * const { createApp } = buildFramework(tempDir);
 * ```
 */
function buildFramework(tempDir: string, extraPluginConfigs: Record<string, unknown> = {}) {
  return createCore(coreConfig, {
    plugins: [registryPlugin, buildfilePlugin, runnerPlugin],
    pluginConfigs: {
      journal: { path: path.join(tempDir, "journal.db") },
      store: { dir: path.join(tempDir, "store") },
      ...extraPluginConfigs
    }
  });
}

/**
 * Builds a deterministic, cost-stamped fake `ExecutableHandler`. Fails
 * `failuresBeforeSuccess` times (a 5xx) before succeeding; throws a
 * content-policy rejection when `flagged` is set; otherwise always
 * succeeds, reporting a fixed `costUsd`.
 *
 * @param options - Fixed cost, failure count, and flagged flag.
 * @param options.costUsd - The fixed cost `estimate`/successful `execute` reports.
 * @param options.failuresBeforeSuccess - Number of leading 5xx failures before succeeding. Default 0.
 * @param options.flagged - When true, every attempt throws a content-policy rejection. Default false.
 * @returns A fake `ExecutableHandler`.
 * @example
 * ```ts
 * const handler = createFakeHandler({ costUsd: 0.1, failuresBeforeSuccess: 1 });
 * ```
 */
function createFakeHandler(options: {
  costUsd: number;
  failuresBeforeSuccess?: number;
  flagged?: boolean;
}): ExecutableHandler {
  let attempts = 0;
  return {
    estimate: (): { usd: number } => ({ usd: options.costUsd }),
    execute: async (): Promise<{ body: Uint8Array; mimeType: string; costUsd: number }> => {
      attempts += 1;
      if (options.flagged) {
        throw Object.assign(new Error("flagged content"), { kind: "content-policy" });
      }
      if (options.failuresBeforeSuccess && attempts <= options.failuresBeforeSuccess) {
        throw Object.assign(new Error("server error"), { status: 500 });
      }
      return {
        body: new TextEncoder().encode(`artifact-${attempts}`),
        mimeType: "text/plain",
        costUsd: options.costUsd
      };
    }
  };
}

/**
 * Builds a fixture plugin that registers `handler` under `(task, provider)`
 * during `onInit` — an in-repo fake provider, the pattern the spec calls
 * for over mocking the registry directly.
 *
 * @param name - Unique plugin name for this fixture instance.
 * @param task - Task key to register under.
 * @param provider - Provider name to register under.
 * @param handler - The fake handler to register.
 * @returns A plugin instance that registers `handler` on init.
 * @example
 * ```ts
 * const fixture = createFakeProviderPlugin("fixture", "voiceover", "fake", handler);
 * ```
 */
function createFakeProviderPlugin(
  name: string,
  task: string,
  provider: string,
  handler: ExecutableHandler
) {
  return createPlugin(name, {
    depends: [registryPlugin],
    onInit: ctx => {
      ctx.require(registryPlugin).register(task, provider, handler);
    }
  });
}

/**
 * A promise plus its external `resolve`, for coordinating a handler's
 * `execute()` with the test body (simulating an in-flight item that hasn't
 * finished yet).
 *
 * @returns A deferred promise pair.
 * @example
 * ```ts
 * const gate = createDeferred<void>();
 * gate.resolve();
 * ```
 */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  const box: { resolve?: (value: T) => void } = {};
  const promise = new Promise<T>(resolve => {
    box.resolve = resolve;
  });
  return { promise, resolve: (value: T): void => box.resolve?.(value) };
}

/**
 * Renders minimal YAML build-file text for one `fakeTask`/`fakeProvider` item.
 *
 * @param name - The build file's `name:` field.
 * @param itemInput - Flat string fields for the item's `input:` block.
 * @returns The build-file YAML text.
 * @example
 * ```ts
 * buildFileYaml("build-a", { text: "a" });
 * ```
 */
function buildFileYaml(name: string, itemInput: Record<string, string>): string {
  const inputLines = Object.entries(itemInput)
    .map(([key, value]) => `      ${key}: ${value}`)
    .join("\n");
  return `version: 1\nname: ${name}\nitems:\n  - task: fakeTask\n    provider: fakeProvider\n    input:\n${inputLines}\n`;
}

describe("runner plugin integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-runner-integration-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Runtime: dependency + lifecycle
  // -------------------------------------------------------------------------

  it("initializes with registry + buildfile dependencies", async () => {
    const handler = createFakeHandler({ costUsd: 0.1 });
    const fixture = createFakeProviderPlugin("fixtureA", "fakeTask", "fakeProvider", handler);
    const { createApp } = buildFramework(tempDir);
    const app = createApp({ plugins: [fixture] });

    await app.start();
    expect(app.runner).toBeDefined();
    expect(app.registry).toBeDefined();
    expect(app.buildfile).toBeDefined();
    await app.stop();
  });

  // -------------------------------------------------------------------------
  // Runtime: one runs row spans every matched build file
  // -------------------------------------------------------------------------

  it("runs a 2-build-file glob as ONE runs row", async () => {
    const handler = createFakeHandler({ costUsd: 0.1 });
    const fixture = createFakeProviderPlugin("fixtureB", "fakeTask", "fakeProvider", handler);
    const { createApp } = buildFramework(tempDir);
    const app = createApp({ plugins: [fixture] });
    await app.start();

    await writeFile(path.join(tempDir, "a.moku.yaml"), buildFileYaml("build-a", { text: "a" }));
    await writeFile(path.join(tempDir, "b.moku.yaml"), buildFileYaml("build-b", { text: "b" }));

    const result = await app.runner.run({ files: path.join(tempDir, "*.moku.yaml") });

    expect(result.status).toBe("done");
    expect(result.totals.total).toBe(2);
    expect(result.totals.done).toBe(2);
    // Reading the SAME runId back and seeing both items confirms one runs
    // row spans both build files (two separate runs could never share a
    // status() snapshot).
    expect(app.runner.status(result.runId).totals.total).toBe(2);

    await app.stop();
  });

  // -------------------------------------------------------------------------
  // Runtime: resume never re-bills done items
  // -------------------------------------------------------------------------

  it("resume() after a simulated interrupt never re-bills already-done items", async () => {
    const slowGate = createDeferred<void>();
    const slowAttempts = { count: 0 };
    const handler: ExecutableHandler = {
      estimate: (): { usd: number } => ({ usd: 0.1 }),
      execute: async (
        request
      ): Promise<{ body: Uint8Array; mimeType: string; costUsd: number }> => {
        const input = (request as { input: { id: string } }).input;
        if (input.id === "slow") {
          slowAttempts.count += 1;
          await slowGate.promise;
        }
        return {
          body: new TextEncoder().encode(`artifact-${input.id}`),
          mimeType: "text/plain",
          costUsd: 0.1
        };
      }
    };
    const fixture = createFakeProviderPlugin("fixtureC", "raceTask", "raceProvider", handler);
    const { createApp } = buildFramework(tempDir, {
      limits: {
        defaults: { rpm: 6000, concurrency: 1, breakerThreshold: 100, breakerCooldownMs: 1 }
      }
    });
    const app = createApp({ plugins: [fixture] });
    await app.start();

    await writeFile(
      path.join(tempDir, "race.moku.yaml"),
      "version: 1\nname: race\nitems:\n  - task: raceTask\n    provider: raceProvider\n    input:\n      id: slow\n  - task: raceTask\n    provider: raceProvider\n    input:\n      id: fast\n"
    );

    const controller = new AbortController();
    const runPromise = app.runner.run(
      { files: path.join(tempDir, "*.moku.yaml") },
      { signal: controller.signal }
    );

    await vi.waitFor(() => expect(slowAttempts.count).toBe(1));
    controller.abort();
    slowGate.resolve();

    const firstResult = await runPromise;
    expect(firstResult.status).toBe("paused");
    expect(firstResult.totals.done).toBe(1);
    expect(firstResult.totals.total).toBe(2);

    const secondResult = await app.runner.resume();
    expect(secondResult.status).toBe("done");
    expect(secondResult.totals.done).toBe(2);
    // The "slow" item's handler was never invoked a second time — its
    // already-`done` row was never re-billed by the resumed run.
    expect(slowAttempts.count).toBe(1);

    await app.stop();
  });

  // -------------------------------------------------------------------------
  // Runtime: estimate() equals the budget gate's arithmetic
  // -------------------------------------------------------------------------

  it("estimate() equals the budget gate's arithmetic (matches the run's actual spend)", async () => {
    const handler = createFakeHandler({ costUsd: 0.25 });
    const fixture = createFakeProviderPlugin("fixtureD", "fakeTask", "fakeProvider", handler);
    const { createApp } = buildFramework(tempDir);
    const app = createApp({ plugins: [fixture] });
    await app.start();

    await writeFile(path.join(tempDir, "a.moku.yaml"), buildFileYaml("build-a", { text: "a" }));
    await writeFile(path.join(tempDir, "b.moku.yaml"), buildFileYaml("build-b", { text: "b" }));

    const pattern = path.join(tempDir, "*.moku.yaml");
    const estimate = await app.runner.estimate({ files: pattern });
    const result = await app.runner.run({ files: pattern });

    expect(estimate.totalUsd).toBeCloseTo(0.5, 10);
    expect(estimate.totalUsd).toBeCloseTo(result.totals.spendUsd, 10);

    await app.stop();
  });

  // -------------------------------------------------------------------------
  // Runtime: budget-stop drain
  // -------------------------------------------------------------------------

  it("stops draining at the budget cap, admitting only what fits, and emits run:budget-stop", async () => {
    const handler = createFakeHandler({ costUsd: 0.6 });
    const fixture = createFakeProviderPlugin("fixtureE", "fakeTask", "fakeProvider", handler);
    const { createApp, createPlugin: boundCreatePlugin } = buildFramework(tempDir);

    const budgetStopEvents: Array<{ runId: string; spendUsd: number; maxCostUsd: number }> = [];
    const listener = boundCreatePlugin("budgetListener", {
      depends: [runnerPlugin],
      hooks: _ctx => ({
        "run:budget-stop": payload => {
          budgetStopEvents.push(payload);
        }
      })
    });

    const app = createApp({ plugins: [fixture, listener] });
    await app.start();

    await writeFile(path.join(tempDir, "a.moku.yaml"), buildFileYaml("build-a", { text: "a" }));
    await writeFile(path.join(tempDir, "b.moku.yaml"), buildFileYaml("build-b", { text: "b" }));

    const result = await app.runner.run({
      files: path.join(tempDir, "*.moku.yaml"),
      maxCostUsd: 1
    });

    expect(result.status).toBe("budget-stopped");
    expect(result.totals.done).toBe(1);
    expect(budgetStopEvents).toHaveLength(1);
    expect(budgetStopEvents[0]?.maxCostUsd).toBe(1);

    await app.stop();
  });

  // -------------------------------------------------------------------------
  // Runtime: events() terminal guarantee
  // -------------------------------------------------------------------------

  it("events() always delivers a terminal record before the stream completes", async () => {
    const handler = createFakeHandler({ costUsd: 0.1 });
    const fixture = createFakeProviderPlugin("fixtureF", "fakeTask", "fakeProvider", handler);
    const { createApp } = buildFramework(tempDir);
    const app = createApp({ plugins: [fixture] });
    await app.start();

    await writeFile(path.join(tempDir, "a.moku.yaml"), buildFileYaml("build-a", { text: "a" }));

    const runPromise = app.runner.run({ files: path.join(tempDir, "*.moku.yaml") });
    const received: RunEvent[] = [];
    for await (const event of app.runner.events()) {
      received.push(event);
    }
    await runPromise;

    expect(received.at(-1)?.type).toBe("terminal");

    await app.stop();
  });

  // -------------------------------------------------------------------------
  // Runtime: retry taxonomy end-to-end (5xx retries, then succeeds)
  // -------------------------------------------------------------------------

  it("retries a 5xx failure through the real limits/journal pipeline, then succeeds", async () => {
    const handler = createFakeHandler({ costUsd: 0.1, failuresBeforeSuccess: 1 });
    const fixture = createFakeProviderPlugin("fixtureG", "fakeTask", "fakeProvider", handler);
    const { createApp } = buildFramework(tempDir);
    const app = createApp({
      plugins: [fixture],
      pluginConfigs: { runner: { retryBaseMs: 1 } }
    });
    await app.start();

    await writeFile(path.join(tempDir, "a.moku.yaml"), buildFileYaml("build-a", { text: "a" }));

    const result = await app.runner.run({ files: path.join(tempDir, "*.moku.yaml") });

    expect(result.status).toBe("done");
    expect(result.totals.done).toBe(1);
    expect(result.totals.failed).toBe(0);

    await app.stop();
  });

  // -------------------------------------------------------------------------
  // Runtime: content-policy is terminal flagged
  // -------------------------------------------------------------------------

  it("flags a content-policy rejection as terminal, never re-queued", async () => {
    const handler = createFakeHandler({ costUsd: 0.1, flagged: true });
    const fixture = createFakeProviderPlugin("fixtureH", "fakeTask", "fakeProvider", handler);
    const { createApp } = buildFramework(tempDir);
    const app = createApp({ plugins: [fixture] });
    await app.start();

    await writeFile(path.join(tempDir, "a.moku.yaml"), buildFileYaml("build-a", { text: "a" }));

    const result = await app.runner.run({ files: path.join(tempDir, "*.moku.yaml") });

    expect(result.status).toBe("done");
    expect(result.totals.flagged).toBe(1);
    expect(result.totals.done).toBe(0);

    await app.stop();
  });

  // -------------------------------------------------------------------------
  // Types: RunResult status literal union, RunEvent narrowing, event payloads
  // -------------------------------------------------------------------------

  describe("types", () => {
    it("RunResult.status is the documented literal union", () => {
      expectTypeOf<RunResult["status"]>().toEqualTypeOf<RunResultStatus>();
      expectTypeOf<RunResultStatus>().toEqualTypeOf<
        "done" | "failed" | "paused" | "budget-stopped"
      >();
    });

    it("RunEvent narrows on its discriminant `type`", () => {
      const event = {
        type: "item:done",
        itemId: "i1",
        costUsd: 0.1,
        contentHash: "h1"
      } as RunEvent;
      if (event.type === "item:done") {
        expectTypeOf(event.costUsd).toBeNumber();
        expectTypeOf(event.contentHash).toBeString();
      }
    });

    it("run:done payload is typed on the plugin bus", () => {
      const { createPlugin: boundCreatePlugin } = buildFramework(tempDir);
      boundCreatePlugin("typeCheckListener", {
        depends: [runnerPlugin],
        hooks: _ctx => ({
          "run:done": payload => {
            expectTypeOf(payload).toEqualTypeOf<{
              runId: string;
              totals: {
                total: number;
                queued: number;
                dispatching: number;
                done: number;
                failed: number;
                flagged: number;
                spendUsd: number;
                estimatedRemainingUsd: number;
              };
            }>();
          }
        })
      });
    });
  });
});
