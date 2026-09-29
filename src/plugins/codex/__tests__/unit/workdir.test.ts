import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCallDirectory } from "../../workdir";

describe("createCallDirectory", () => {
  let root: string;
  let created: string[];

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "moku-codex-workdir-"));
    created = [];
  });

  afterEach(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("creates the dir under os.tmpdir() when workDir is empty", async () => {
    const dir = await createCallDirectory("");
    created.push(dir);

    expect(path.dirname(dir)).toBe(path.resolve(tmpdir()));
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it("resolves a relative root against the cwd and creates it when missing", async () => {
    const relativeRoot = path.relative(process.cwd(), path.join(root, "missing", "work"));
    expect(existsSync(path.resolve(relativeRoot))).toBe(false);

    const dir = await createCallDirectory(relativeRoot);

    expect(path.isAbsolute(dir)).toBe(true);
    expect(path.dirname(dir)).toBe(path.resolve(relativeRoot));
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it("names the dir with the codex- prefix", async () => {
    const dir = await createCallDirectory(root);

    expect(path.basename(dir)).toMatch(/^codex-/);
  });

  it("gives each call a distinct dir", async () => {
    const first = await createCallDirectory(root);
    const second = await createCallDirectory(root);

    expect(first).not.toBe(second);
    expect(statSync(first).isDirectory()).toBe(true);
    expect(statSync(second).isDirectory()).toBe(true);
  });
});
