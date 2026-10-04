import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBrandConsole } from "@moku-labs/common/cli";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProjectConfig, renderLoadError } from "../../project-config";

const MISSING_PATH_MESSAGE =
  "[ai] --config needs a file path.\n  Pass --config <path> or --config=<path>.";

const ARK_CN = 'export default { pluginConfigs: { ark: { region: "cn" } } };\n';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "moku-project-config-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/**
 * Writes one fixture file into the test's tmp dir.
 *
 * @param name - File name relative to the tmp dir.
 * @param source - The module source.
 * @returns The absolute path of the written file.
 */
async function fixture(name: string, source: string): Promise<string> {
  const file = path.join(cwd, name);
  await writeFile(file, source);
  return file;
}

describe("loadProjectConfig: discovery", () => {
  it("returns empty options and the argv unchanged when no config file exists", async () => {
    const loaded = await loadProjectConfig(["run", "a.moku.yaml"], cwd);

    expect(loaded).toEqual({
      ok: true,
      options: {},
      argv: ["run", "a.moku.yaml"],
      path: undefined
    });
  });

  it.each([
    "moku.config.ts",
    "moku.config.mts",
    "moku.config.js",
    "moku.config.mjs"
  ])("loads %s from the cwd", async name => {
    const file = await fixture(name, ARK_CN);

    const loaded = await loadProjectConfig(["status"], cwd);

    expect(loaded).toEqual({
      ok: true,
      options: { pluginConfigs: { ark: { region: "cn" } } },
      argv: ["status"],
      path: file
    });
  });

  it("probes .ts before .mts, .js and .mjs", async () => {
    const tsFile = await fixture(
      "moku.config.ts",
      "export default { pluginConfigs: { from: 'ts' } };\n"
    );
    await fixture("moku.config.mts", "export default { pluginConfigs: { from: 'mts' } };\n");
    await fixture("moku.config.js", "export default { pluginConfigs: { from: 'js' } };\n");
    await fixture("moku.config.mjs", "export default { pluginConfigs: { from: 'mjs' } };\n");

    const loaded = await loadProjectConfig([], cwd);

    expect(loaded).toMatchObject({
      ok: true,
      path: tsFile,
      options: { pluginConfigs: { from: "ts" } }
    });
  });

  it("probes .mts before .js when no .ts config exists", async () => {
    const mtsFile = await fixture(
      "moku.config.mts",
      "export default { pluginConfigs: { from: 'mts' } };\n"
    );
    await fixture("moku.config.js", "export default { pluginConfigs: { from: 'js' } };\n");

    const loaded = await loadProjectConfig([], cwd);

    expect(loaded).toMatchObject({
      ok: true,
      path: mtsFile,
      options: { pluginConfigs: { from: "mts" } }
    });
  });

  it("probes .js before .mjs when no TypeScript config exists", async () => {
    const jsFile = await fixture(
      "moku.config.js",
      "export default { pluginConfigs: { from: 'js' } };\n"
    );
    await fixture("moku.config.mjs", "export default { pluginConfigs: { from: 'mjs' } };\n");

    const loaded = await loadProjectConfig([], cwd);

    expect(loaded).toMatchObject({
      ok: true,
      path: jsFile,
      options: { pluginConfigs: { from: "js" } }
    });
  });
});

describe("loadProjectConfig: --config", () => {
  it("loads the named file over a probed one and strips `--config <path>` from argv", async () => {
    await fixture("moku.config.ts", "export default { pluginConfigs: { from: 'probe' } };\n");
    const named = await fixture(
      "custom.mjs",
      "export default { pluginConfigs: { from: 'flag' } };\n"
    );

    const loaded = await loadProjectConfig(["run", "--config", "custom.mjs", "--flat"], cwd);

    expect(loaded).toEqual({
      ok: true,
      options: { pluginConfigs: { from: "flag" } },
      argv: ["run", "--flat"],
      path: named
    });
  });

  it("accepts `--config=<path>` and strips it from argv", async () => {
    const named = await fixture("custom.mjs", ARK_CN);

    const loaded = await loadProjectConfig(["--config=custom.mjs", "status"], cwd);

    expect(loaded).toMatchObject({ ok: true, argv: ["status"], path: named });
  });

  it("accepts an absolute path", async () => {
    const named = await fixture("custom.mjs", ARK_CN);

    const loaded = await loadProjectConfig(["status", "--config", named], cwd);

    expect(loaded).toMatchObject({ ok: true, argv: ["status"], path: named });
  });

  it("fails when --config is the last token", async () => {
    const loaded = await loadProjectConfig(["run", "--config"], cwd);

    expect(loaded).toEqual({ ok: false, message: MISSING_PATH_MESSAGE });
  });

  it("fails when --config= carries no value", async () => {
    const loaded = await loadProjectConfig(["--config=", "run"], cwd);

    expect(loaded).toEqual({ ok: false, message: MISSING_PATH_MESSAGE });
  });

  it("fails when --config is followed by another flag", async () => {
    const loaded = await loadProjectConfig(["run", "--config", "--flat"], cwd);

    expect(loaded).toEqual({ ok: false, message: MISSING_PATH_MESSAGE });
  });

  it("fails when --config names a missing file", async () => {
    const missing = path.join(cwd, "nope.ts");

    const loaded = await loadProjectConfig(["--config", "nope.ts"], cwd);

    expect(loaded).toEqual({
      ok: false,
      message: `[ai] Could not load ${missing}.\n  Check the path, or drop --config to use moku.config.ts in this directory.`
    });
  });
});

describe("loadProjectConfig: invalid modules", () => {
  it("fails with the thrown message when the module throws on import", async () => {
    const file = await fixture("moku.config.mjs", 'throw new Error("boom in config");\n');

    const loaded = await loadProjectConfig([], cwd);

    expect(loaded).toEqual({
      ok: false,
      message: `[ai] Could not load ${file}.\n  boom in config`
    });
  });

  it("fails when the module has no default export", async () => {
    const file = await fixture("moku.config.mjs", "export const plugins = [];\n");

    const loaded = await loadProjectConfig([], cwd);

    expect(loaded).toEqual({
      ok: false,
      message: `[ai] Could not load ${file}.\n  Its default export is not an object: use export default defineConfig({ ... }).`
    });
  });

  it.each([
    ["an array", "[]"],
    ["a string", '"ark"'],
    ["null", "null"],
    ["a function", "() => ({})"]
  ])("fails when the default export is %s", async (_label, value) => {
    const file = await fixture("moku.config.mjs", `export default ${value};\n`);

    const loaded = await loadProjectConfig([], cwd);

    expect(loaded).toEqual({
      ok: false,
      message: `[ai] Could not load ${file}.\n  Its default export is not an object: use export default defineConfig({ ... }).`
    });
  });

  it("does not create the app or touch argv when loading fails", async () => {
    await fixture("moku.config.mjs", "export default 1;\n");

    const loaded = await loadProjectConfig(["run"], cwd);

    expect(loaded.ok).toBe(false);
    expect(loaded).not.toHaveProperty("argv");
  });
});

describe("renderLoadError", () => {
  it("writes the message to the error sink through the branded console", () => {
    const errors: string[] = [];
    const lines: string[] = [];
    const ui = createBrandConsole({
      write: line => lines.push(line),
      writeError: line => errors.push(line),
      color: false
    });

    renderLoadError(MISSING_PATH_MESSAGE, ui);

    expect(lines).toEqual([]);
    expect(errors.join("\n")).toContain("[ai] --config needs a file path.");
  });
});
