/**
 * @file Framework-level: the `moku` bin end to end.
 *
 * Spawns `bun src/bin.ts` as a child process with a per-test tmp dir as its cwd, so the real
 * project-config loader, `createApp`, `start`, `cli.dispatch`, `stop` and `process.exit` all run.
 * Covers a `--config` that does not load (exit 3, before any app exists) and a `moku.config.ts`
 * whose custom plugin and `pluginConfigs` reach the started app.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT_CODES } from "../../src/plugins/cli/types";

const execFileAsync = promisify(execFile);

/** Absolute path of the bin source the tests spawn. */
const BIN = path.resolve(import.meta.dirname, "../../src/bin.ts");

/** Absolute path of the framework's public entry, imported by the fixture config. */
const FRAMEWORK_ENTRY = path.resolve(import.meta.dirname, "../../src/index.ts");

/** A spawn of the bin can take a few seconds on a cold cache. */
const SPAWN_TIMEOUT_MS = 30_000;

/** The outcome of one bin run. */
interface BinResult {
  /** The process exit code. */
  code: number;
  /** Everything written to stdout and stderr. */
  output: string;
}

/** The fields `execFile` attaches to the error of a non-zero exit. */
interface ExecFailure {
  /** The exit code. */
  code?: number;
  /** Captured stdout. */
  stdout?: string;
  /** Captured stderr. */
  stderr?: string;
}

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "moku-bin-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/**
 * Runs `bun src/bin.ts <args>` in the test's tmp dir.
 *
 * @param args - The CLI tokens after the bin name.
 * @returns The exit code and the combined output.
 */
async function runBin(args: string[]): Promise<BinResult> {
  try {
    const { stdout, stderr } = await execFileAsync("bun", [BIN, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" }
    });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as ExecFailure;
    return { code: failure.code ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

describe("moku bin", () => {
  it(
    "exits 3 with the load error when --config names a missing file",
    async () => {
      const result = await runBin(["--config", "missing.ts", "validate"]);

      expect(result.code).toBe(EXIT_CODES.usage);
      expect(result.output).toContain("[ai] Could not load");
      expect(result.output).toContain("missing.ts");
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    "starts the app with the plugins and pluginConfigs of moku.config.ts",
    async () => {
      await writeFile(
        path.join(cwd, "moku.config.ts"),
        [
          'import { writeFileSync } from "node:fs";',
          `import { createPlugin, defineConfig } from ${JSON.stringify(FRAMEWORK_ENTRY)};`,
          "",
          'const markerPlugin = createPlugin("marker", {',
          '  config: { text: "default" },',
          '  onStart: ctx => { writeFileSync("marker.txt", ctx.config.text); }',
          "});",
          "",
          "export default defineConfig({",
          "  plugins: [markerPlugin],",
          '  pluginConfigs: { marker: { text: "from-config" }, cli: { plain: true } }',
          "});",
          ""
        ].join("\n")
      );

      // `validate` on a glob that matches nothing: the app starts, the command fails cheaply.
      const result = await runBin(["validate", "*.nothing.moku.yaml"]);

      expect(result.code).toBe(EXIT_CODES.validation);
      expect(result.output).toContain("No build files matched");
      const marker = path.join(cwd, "marker.txt");
      expect(existsSync(marker)).toBe(true);
      expect(await readFile(marker, "utf8")).toBe("from-config");
    },
    SPAWN_TIMEOUT_MS
  );
});
