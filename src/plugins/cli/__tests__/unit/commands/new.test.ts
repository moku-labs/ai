import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runNewCommand } from "../../../commands/new";
import { EXIT_CODES } from "../../../types";
import { createFakeCommandContext } from "../fixtures";

describe("runNewCommand", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-cli-new-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes the build file and its JSON Schema, then exits ok", async () => {
    const { context } = createFakeCommandContext();

    const code = await runNewCommand(context, {}, ["demo"]);

    expect(code).toBe(EXIT_CODES.ok);
    const buildText = await readFile(path.join(tempDir, "demo.moku.yaml"), "utf8");
    expect(buildText).toContain('name: "demo"');

    const schemaText = await readFile(path.join(tempDir, ".moku", "build.schema.json"), "utf8");
    expect(JSON.parse(schemaText)).toEqual({ type: "object" });
  });

  it('defaults the build name to "build" when no name is given', async () => {
    const { context } = createFakeCommandContext();

    await runNewCommand(context, {}, []);

    const buildText = await readFile(path.join(tempDir, "build.moku.yaml"), "utf8");
    expect(buildText).toContain('name: "build"');
  });

  it("refuses to overwrite an existing build file", async () => {
    await writeFile(path.join(tempDir, "demo.moku.yaml"), "existing content", "utf8");
    const { context, errorLines } = createFakeCommandContext();

    const code = await runNewCommand(context, {}, ["demo"]);

    expect(code).toBe(EXIT_CODES.failure);
    expect(errorLines.some(line => line.includes("refusing to overwrite"))).toBe(true);
    const preserved = await readFile(path.join(tempDir, "demo.moku.yaml"), "utf8");
    expect(preserved).toBe("existing content");
  });

  it("throws when buildfile.template()'s modeline is malformed", async () => {
    const { context } = createFakeCommandContext({
      buildfile: { template: () => "not a modeline\n" }
    });

    await expect(runNewCommand(context, {}, ["demo"])).rejects.toThrow(
      /could not derive a schema path/
    );
  });
});
