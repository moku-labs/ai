import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DoneOutput, ItemRow, RunRow } from "../../../journal/types";
import { exportRun } from "../../export";
import type { RunnerContext } from "../../types";
import { createFakeRunnerContext, fakeItemRow } from "./fixtures";

/** The run every test exports. */
const RUN: RunRow = {
  id: "run-1",
  createdAt: 0,
  status: "done",
  glob: "*",
  maxCostUsd: 0,
  finishedAt: 0
};

/** Temp root per test: the fake store lives in `store/`, exports go to `out/`. */
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "runner-export-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * A done item whose bytes are stored under `hash`.
 *
 * @param id - Item id.
 * @param label - Export label.
 * @param buildName - Build the item belongs to.
 * @returns The fake done row (`image/png`, cost 0.1).
 */
function doneItem(id: string, label: string, buildName: string): ItemRow {
  return fakeItemRow({
    id,
    label,
    buildName,
    status: "done",
    contentHash: `hash-${id}`,
    mimeType: "image/png",
    actualCostUsd: 0.1
  });
}

/**
 * A fake runner context whose newest run is {@link RUN} with `items` done,
 * and whose store holds each item's bytes (`bytes-<id>`) as a real file.
 *
 * @param items - The run's done items.
 * @returns The context.
 */
async function exportContext(items: ItemRow[]): Promise<RunnerContext> {
  for (const item of items) {
    await writeFile(path.join(tempDir, `${item.contentHash}`), `bytes-${item.id}`);
  }
  return createFakeRunnerContext([], {
    journal: { latestRun: () => RUN, listItems: () => items },
    store: { pathOf: (hash: string) => path.join(tempDir, hash) }
  });
}

describe("exportRun — nested (default)", () => {
  it("writes <outDir>/<build>/<label>.<ext>", async () => {
    const ctx = await exportContext([doneItem("a", "hero", "ep01")]);
    const outDir = path.join(tempDir, "out");

    const result = await exportRun(ctx, { outDir });

    expect(result.files.map(file => file.path)).toEqual([path.join(outDir, "ep01", "hero.png")]);
    expect(await readFile(path.join(outDir, "ep01", "hero.png"), "utf8")).toBe("bytes-a");
    expect(result.skipped).toEqual([]);
  });

  it("stays nested when flat is false", async () => {
    const ctx = await exportContext([doneItem("a", "hero", "ep01")]);
    const outDir = path.join(tempDir, "out");

    const result = await exportRun(ctx, { outDir, flat: false });

    expect(result.files.map(file => file.path)).toEqual([path.join(outDir, "ep01", "hero.png")]);
  });

  it("writes the same label of two builds into two build folders", async () => {
    const ctx = await exportContext([doneItem("a", "hero", "ep01"), doneItem("b", "hero", "ep02")]);
    const outDir = path.join(tempDir, "out");

    const result = await exportRun(ctx, { outDir });

    expect(result.files).toHaveLength(2);
    expect(result.skipped).toEqual([]);
  });
});

describe("exportRun — flat", () => {
  it("writes <outDir>/<label>.<ext> and no build folder", async () => {
    const ctx = await exportContext([doneItem("a", "hero", "ep01")]);
    const outDir = path.join(tempDir, "out");

    const result = await exportRun(ctx, { outDir, flat: true });

    expect(result.files.map(file => file.path)).toEqual([path.join(outDir, "hero.png")]);
    expect(await readdir(outDir)).toEqual(["hero.png"]);
    expect(await readFile(path.join(outDir, "hero.png"), "utf8")).toBe("bytes-a");
  });

  it("skips and lists the second item when two builds share a label", async () => {
    const ctx = await exportContext([doneItem("a", "hero", "ep01"), doneItem("b", "hero", "ep02")]);
    const outDir = path.join(tempDir, "out");

    const result = await exportRun(ctx, { outDir, flat: true });

    expect(result.files.map(file => file.path)).toEqual([path.join(outDir, "hero.png")]);
    expect(result.skipped).toEqual(["hero"]);
    expect(await readFile(path.join(outDir, "hero.png"), "utf8")).toBe("bytes-a");
  });

  it("writes <label>-N.<ext> for every output of a multi-output item", async () => {
    const group = fakeItemRow({
      id: "g",
      label: "keys",
      buildName: "ep01",
      status: "done",
      contentHash: "hash-g1",
      mimeType: "image/png",
      outputs: [
        { contentHash: "hash-g1", mimeType: "image/png" },
        { contentHash: "hash-g2", mimeType: "image/png" }
      ]
    });
    await writeFile(path.join(tempDir, "hash-g1"), "one");
    await writeFile(path.join(tempDir, "hash-g2"), "two");
    const ctx = await exportContext([group]);
    const outDir = path.join(tempDir, "out");

    const result = await exportRun(ctx, { outDir, flat: true });

    expect(result.files.map(file => file.path)).toEqual([
      path.join(outDir, "keys.png"),
      path.join(outDir, "keys-2.png")
    ]);
    expect(await readFile(path.join(outDir, "keys-2.png"), "utf8")).toBe("two");
  });

  it("still skips a label that would escape the output folder", async () => {
    const ctx = await exportContext([doneItem("a", "../escape", "ep01")]);
    const outDir = path.join(tempDir, "out");

    const result = await exportRun(ctx, { outDir, flat: true });

    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual(["../escape"]);
  });
});

/**
 * A done dialogue-like item: the mix plus the given extra outputs, all
 * `audio/mpeg`, with each output's bytes stored as a real file (`bytes-<hash>`).
 *
 * @param id - Item id.
 * @param label - Export label.
 * @param extra - The outputs after the mix.
 * @returns The fake done row (cost 0.2).
 */
async function namedItem(id: string, label: string, extra: DoneOutput[]): Promise<ItemRow> {
  const outputs: DoneOutput[] = [{ contentHash: `hash-${id}`, mimeType: "audio/mpeg" }, ...extra];
  for (const output of outputs) {
    await writeFile(path.join(tempDir, output.contentHash), `bytes-${output.contentHash}`);
  }
  return fakeItemRow({
    id,
    label,
    buildName: "ep02",
    status: "done",
    contentHash: `hash-${id}`,
    mimeType: "audio/mpeg",
    actualCostUsd: 0.2,
    outputs
  });
}

/**
 * An `audio/mpeg` output named `name`, stored under `contentHash`.
 *
 * @param name - The output's file name.
 * @param contentHash - Its stored hash; default `hash-<name>`.
 * @returns The output.
 */
function line(name: string, contentHash = `hash-${name}`): DoneOutput {
  return { contentHash, mimeType: "audio/mpeg", name };
}

describe("exportRun — named outputs", () => {
  it("writes the mix at the label and each named line beside it, the cost on the mix", async () => {
    const item = await namedItem("q", "voices/ep02-quarrel-ru", [
      line("ep02-signAlice-ru"),
      line("ep02-signBob-ru")
    ]);
    const ctx = await exportContext([item]);
    const outDir = path.join(tempDir, "out");

    const result = await exportRun(ctx, { outDir });

    const voices = path.join(outDir, "ep02", "voices");
    expect(result.files.map(file => [file.label, file.path, file.costUsd])).toEqual([
      ["voices/ep02-quarrel-ru", path.join(voices, "ep02-quarrel-ru.mp3"), 0.2],
      [path.join("voices", "ep02-signAlice-ru"), path.join(voices, "ep02-signAlice-ru.mp3"), 0],
      [path.join("voices", "ep02-signBob-ru"), path.join(voices, "ep02-signBob-ru.mp3"), 0]
    ]);
    expect(await readFile(path.join(voices, "ep02-signBob-ru.mp3"), "utf8")).toBe(
      "bytes-hash-ep02-signBob-ru"
    );
    expect(result.skipped).toEqual([]);
  });

  it("writes output 0 at the label even when it has a name", async () => {
    const item = await namedItem("q", "scene", []);
    const named = { ...item, outputs: [{ ...line("mix"), contentHash: "hash-q" }] };
    const ctx = await exportContext([named]);
    const outDir = path.join(tempDir, "out");

    const result = await exportRun(ctx, { outDir, flat: true });

    expect(result.files.map(file => file.path)).toEqual([path.join(outDir, "scene.mp3")]);
  });

  it("keeps <label>-<k+1> for an unnamed output among named ones", async () => {
    const unnamed: DoneOutput = { contentHash: "hash-plain", mimeType: "audio/mpeg" };
    const item = await namedItem("q", "scene", [line("alice"), unnamed]);
    const ctx = await exportContext([item]);
    const outDir = path.join(tempDir, "out");

    const result = await exportRun(ctx, { outDir, flat: true });

    expect(result.files.map(file => path.basename(file.path))).toEqual([
      "scene.mp3",
      "alice.mp3",
      "scene-3.mp3"
    ]);
  });

  it.each([
    "",
    "../x",
    "a/b",
    String.raw`a\b`,
    ".",
    ".."
  ])("skips the item when a name is unsafe (%j), and writes nothing", async name => {
    const item = await namedItem("q", "voices/scene", [line(name, "hash-unsafe")]);
    const ctx = await exportContext([item]);
    const outDir = path.join(tempDir, "out");

    const result = await exportRun(ctx, { outDir });

    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual(["voices/scene"]);
    expect(await readdir(tempDir)).not.toContain("out");
  });

  it("skips the second item when its named file lands on another item's label", async () => {
    const first = await namedItem("a", "alice", []);
    const second = await namedItem("b", "scene", [line("alice")]);
    const ctx = await exportContext([first, second]);
    const outDir = path.join(tempDir, "out");

    const result = await exportRun(ctx, { outDir, flat: true });

    expect(result.files.map(file => path.basename(file.path))).toEqual(["alice.mp3"]);
    expect(result.skipped).toEqual(["scene"]);
    expect(await readFile(path.join(outDir, "alice.mp3"), "utf8")).toBe("bytes-a");
  });

  it("skips an item two of whose own files map to one path", async () => {
    const item = await namedItem("q", "voices/scene", [line("scene")]);
    const ctx = await exportContext([item]);
    const outDir = path.join(tempDir, "out");

    const result = await exportRun(ctx, { outDir });

    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual(["voices/scene"]);
  });
});
