import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ItemRow, RunRow } from "../../../journal/types";
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
