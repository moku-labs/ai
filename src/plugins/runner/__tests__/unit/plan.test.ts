import { describe, expect, it } from "vitest";
import type { BuildItem, CompiledBuild } from "../../../buildfile/types";
import { planItems, planningKeyOf } from "../../plan";
import { type CallLog, createFakeRunnerContext, fakeHandler } from "./fixtures";

/**
 * Builds a minimal `BuildItem` fixture.
 *
 * @param overrides - Fields to override on the default fake item.
 * @returns A fake build item.
 * @example
 * ```ts
 * const item = fakeBuildItem({ task: "voiceover" });
 * ```
 */
function fakeBuildItem(overrides: Partial<BuildItem> = {}): BuildItem {
  return { task: "fakeTask", input: { text: "hello" }, ...overrides };
}

/**
 * Builds a minimal `CompiledBuild` fixture wrapping the given items.
 *
 * @param items - The build's items.
 * @param overrides - Fields to override on the default fake build (file label, defaults).
 * @returns A fake compiled build.
 * @example
 * ```ts
 * const build = fakeCompiledBuild([fakeBuildItem()]);
 * ```
 */
function fakeCompiledBuild(
  items: BuildItem[],
  overrides: Partial<CompiledBuild["spec"]> = {}
): CompiledBuild {
  return {
    file: "build.moku.yaml",
    spec: { version: 1, name: "fixture", items, ...overrides }
  };
}

// ---------------------------------------------------------------------------
// planningKeyOf — canonicalization: key-order independence, param sensitivity
// ---------------------------------------------------------------------------

describe("planningKeyOf", () => {
  it("is independent of input key insertion order", () => {
    const itemA = fakeBuildItem({ input: { text: "hi", voice: "v1" } });
    const itemB = fakeBuildItem({ input: { voice: "v1", text: "hi" } });

    expect(planningKeyOf(itemA)).toBe(planningKeyOf(itemB));
  });

  it("is independent of nested object key insertion order", () => {
    const itemA = fakeBuildItem({ input: { opts: { a: 1, b: 2 } } });
    const itemB = fakeBuildItem({ input: { opts: { b: 2, a: 1 } } });

    expect(planningKeyOf(itemA)).toBe(planningKeyOf(itemB));
  });

  it("is sensitive to input value differences", () => {
    const itemA = fakeBuildItem({ input: { text: "hi" } });
    const itemB = fakeBuildItem({ input: { text: "bye" } });

    expect(planningKeyOf(itemA)).not.toBe(planningKeyOf(itemB));
  });

  it("is sensitive to params differences", () => {
    const itemA = fakeBuildItem({ params: { speed: 1 } });
    const itemB = fakeBuildItem({ params: { speed: 2 } });

    expect(planningKeyOf(itemA)).not.toBe(planningKeyOf(itemB));
  });

  it("treats omitted params the same as an explicit empty params object", () => {
    const itemA = fakeBuildItem({});
    const itemB = fakeBuildItem({ params: {} });

    expect(planningKeyOf(itemA)).toBe(planningKeyOf(itemB));
  });

  it("is sensitive to the task name", () => {
    const itemA = fakeBuildItem({ task: "voiceover" });
    const itemB = fakeBuildItem({ task: "translate" });

    expect(planningKeyOf(itemA)).not.toBe(planningKeyOf(itemB));
  });

  it("is independent of the resolved provider (identity is task+input+params only)", () => {
    const itemA = fakeBuildItem({ provider: "elevenlabs" });
    const itemB = fakeBuildItem({ provider: "openai" });

    expect(planningKeyOf(itemA)).toBe(planningKeyOf(itemB));
  });
});

// ---------------------------------------------------------------------------
// planItems — provider/maxAttempts resolution, cost estimation, request pairing
// ---------------------------------------------------------------------------

describe("planItems", () => {
  it("uses the build item's own provider when set", () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    const build = fakeCompiledBuild([fakeBuildItem({ provider: "explicit-provider" })]);

    const [planned] = planItems(ctx, [build]);

    expect(planned?.intent.provider).toBe("explicit-provider");
  });

  it("falls back to the build file's defaults.provider", () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    const build = fakeCompiledBuild([fakeBuildItem()], {
      defaults: { provider: "default-provider" }
    });

    const [planned] = planItems(ctx, [build]);

    expect(planned?.intent.provider).toBe("default-provider");
  });

  it("falls back to the task's first-registered provider when neither is set", () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log, {
      registry: { providers: (): string[] => ["registered-first", "registered-second"] }
    });
    const build = fakeCompiledBuild([fakeBuildItem()]);

    const [planned] = planItems(ctx, [build]);

    expect(planned?.intent.provider).toBe("registered-first");
  });

  it("throws a two-line error when no provider is set and none is registered", () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log, { registry: { providers: (): string[] => [] } });
    const build = fakeCompiledBuild([fakeBuildItem()]);

    expect(() => planItems(ctx, [build])).toThrow(/^\[ai\] No provider registered/);
  });

  it("resolves the build file's defaults.maxAttempts over config.maxAttempts", () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log, { config: { maxAttempts: 3 } });
    const build = fakeCompiledBuild([fakeBuildItem()], { defaults: { maxAttempts: 7 } });

    const [planned] = planItems(ctx, [build]);

    expect(planned?.maxAttempts).toBe(7);
  });

  it("falls back to config.maxAttempts when the build file sets no default", () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log, { config: { maxAttempts: 5 } });
    const build = fakeCompiledBuild([fakeBuildItem()]);

    const [planned] = planItems(ctx, [build]);

    expect(planned?.maxAttempts).toBe(5);
  });

  it("uses the resolved handler's estimate() for estimatedCostUsd", () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log, {
      registry: { resolve: (): unknown => fakeHandler(log, { costUsd: 0.42 }) }
    });
    const build = fakeCompiledBuild([fakeBuildItem()]);

    const [planned] = planItems(ctx, [build]);

    expect(planned?.intent.estimatedCostUsd).toBe(0.42);
    expect(log).toContain("handler.estimate");
  });

  it("pairs the intent with the item's input/params as the in-memory request", () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    const build = fakeCompiledBuild([
      fakeBuildItem({ input: { text: "hi" }, params: { speed: 2 } })
    ]);

    const [planned] = planItems(ctx, [build]);

    expect(planned?.request).toEqual({ input: { text: "hi" }, params: { speed: 2 } });
  });

  it("defaults packVersion to null when the item has no pack", () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    const build = fakeCompiledBuild([fakeBuildItem()]);

    const [planned] = planItems(ctx, [build]);

    expect(planned?.intent.packVersion).toBeNull();
  });

  it("carries the item's pack version through when set", () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    const build = fakeCompiledBuild([
      fakeBuildItem({ pack: { name: "pack-a", version: "1.2.3" } })
    ]);

    const [planned] = planItems(ctx, [build]);

    expect(planned?.intent.packVersion).toBe("1.2.3");
  });

  it("expands multiple build files in file then item order", () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    const buildA = fakeCompiledBuild([fakeBuildItem({ input: { text: "a1" } })], {
      name: "a"
    });
    const buildB = fakeCompiledBuild([fakeBuildItem({ input: { text: "b1" } })], {
      name: "b"
    });

    const planned = planItems(ctx, [buildA, buildB]);

    expect(planned.map(p => p.request.input.text)).toEqual(["a1", "b1"]);
  });
});
