import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  it("uses the build item's own provider when set", async () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    const build = fakeCompiledBuild([fakeBuildItem({ provider: "explicit-provider" })]);

    const [planned] = await planItems(ctx, [build]);

    expect(planned?.intent.provider).toBe("explicit-provider");
  });

  it("falls back to the build file's defaults.provider", async () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    const build = fakeCompiledBuild([fakeBuildItem()], {
      defaults: { provider: "default-provider" }
    });

    const [planned] = await planItems(ctx, [build]);

    expect(planned?.intent.provider).toBe("default-provider");
  });

  it("falls back to the task's first-registered provider when neither is set", async () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log, {
      registry: { providers: (): string[] => ["registered-first", "registered-second"] }
    });
    const build = fakeCompiledBuild([fakeBuildItem()]);

    const [planned] = await planItems(ctx, [build]);

    expect(planned?.intent.provider).toBe("registered-first");
  });

  it("throws a two-line error when no provider is set and none is registered", async () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log, { registry: { providers: (): string[] => [] } });
    const build = fakeCompiledBuild([fakeBuildItem()]);

    await expect(planItems(ctx, [build])).rejects.toThrow(/^\[ai\] No provider registered/);
  });

  it("resolves the build file's defaults.maxAttempts over config.maxAttempts", async () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log, { config: { maxAttempts: 3 } });
    const build = fakeCompiledBuild([fakeBuildItem()], { defaults: { maxAttempts: 7 } });

    const [planned] = await planItems(ctx, [build]);

    expect(planned?.maxAttempts).toBe(7);
  });

  it("falls back to config.maxAttempts when the build file sets no default", async () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log, { config: { maxAttempts: 5 } });
    const build = fakeCompiledBuild([fakeBuildItem()]);

    const [planned] = await planItems(ctx, [build]);

    expect(planned?.maxAttempts).toBe(5);
  });

  it("uses the resolved handler's estimate() for estimatedCostUsd", async () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log, {
      registry: { resolve: (): unknown => fakeHandler(log, { costUsd: 0.42 }) }
    });
    const build = fakeCompiledBuild([fakeBuildItem()]);

    const [planned] = await planItems(ctx, [build]);

    expect(planned?.intent.estimatedCostUsd).toBe(0.42);
    expect(log).toContain("handler.estimate");
  });

  it("pairs the intent with the flat task request (input spread + params)", async () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    const build = fakeCompiledBuild([
      fakeBuildItem({ input: { text: "hi" }, params: { speed: 2 } })
    ]);

    const [planned] = await planItems(ctx, [build]);

    expect(planned?.request).toEqual({ text: "hi", params: { speed: 2 } });
  });

  it("defaults packVersion to null when the item has no pack", async () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    const build = fakeCompiledBuild([fakeBuildItem()]);

    const [planned] = await planItems(ctx, [build]);

    expect(planned?.intent.packVersion).toBeNull();
  });

  it("carries the item's pack version through when set", async () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    const build = fakeCompiledBuild([
      fakeBuildItem({ pack: { name: "pack-a", version: "1.2.3" } })
    ]);

    const [planned] = await planItems(ctx, [build]);

    expect(planned?.intent.packVersion).toBe("1.2.3");
  });

  it("expands multiple build files in file then item order", async () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    const buildA = fakeCompiledBuild([fakeBuildItem({ input: { text: "a1" } })], {
      name: "a"
    });
    const buildB = fakeCompiledBuild([fakeBuildItem({ input: { text: "b1" } })], {
      name: "b"
    });

    const planned = await planItems(ctx, [buildA, buildB]);

    expect(planned.map(p => p.request.text)).toEqual(["a1", "b1"]);
  });
});

// ---------------------------------------------------------------------------
// planItems — a $file image gets its MIME from its first bytes
// ---------------------------------------------------------------------------

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50
]);

describe("planItems — $file MIME from its first bytes", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "runner-plan-mime-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /**
   * Writes `name` into the temp directory and plans one item per entry of
   * `ids`, each reading that file as its `image`.
   *
   * @param name - File name next to the build file.
   * @param bytes - The file's content.
   * @param ids - Item ids; each item references the file.
   * @returns The fake context and the planned items.
   * @example
   * ```ts
   * const { planned } = await planWithFile("akari.png", JPEG_BYTES, ["a"]);
   * ```
   */
  async function planWithFile(
    name: string,
    bytes: Uint8Array,
    ids: string[]
  ): Promise<{
    ctx: ReturnType<typeof createFakeRunnerContext>;
    planned: Awaited<ReturnType<typeof planItems>>;
  }> {
    await writeFile(path.join(directory, name), bytes);
    const ctx = createFakeRunnerContext([]);
    const items = ids.map(id => fakeBuildItem({ id, input: { text: id, image: { $file: name } } }));
    const build: CompiledBuild = {
      file: path.join(directory, "e01.moku.yaml"),
      spec: { version: 1, name: "e01", items }
    };
    return { ctx, planned: await planItems(ctx, [build]) };
  }

  it("a .png file with JPEG bytes resolves to image/jpeg and logs the mismatch once", async () => {
    const { ctx, planned } = await planWithFile("akari.png", JPEG_BYTES, ["a", "b"]);

    expect(planned.map(item => item.files.get("akari.png")?.mimeType)).toEqual([
      "image/jpeg",
      "image/jpeg"
    ]);
    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
    expect(ctx.log.warn).toHaveBeenCalledWith("runner:mime:mismatch", {
      path: path.join(directory, "akari.png"),
      extension: "png",
      detected: "image/jpeg"
    });
  });

  it("a .jpg file with WEBP bytes resolves to image/webp", async () => {
    const { planned } = await planWithFile("sheet.jpg", WEBP_BYTES, ["a"]);

    expect(planned[0]?.files.get("sheet.jpg")?.mimeType).toBe("image/webp");
  });

  it("a signature that matches the extension logs nothing", async () => {
    const { ctx, planned } = await planWithFile("akari.png", PNG_BYTES, ["a"]);

    expect(planned[0]?.files.get("akari.png")?.mimeType).toBe("image/png");
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it("a file without an image signature keeps the extension map", async () => {
    const { ctx, planned } = await planWithFile("line.wav", new Uint8Array([1, 2, 3]), ["a"]);

    expect(planned[0]?.files.get("line.wav")?.mimeType).toBe("audio/wav");
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });
});
