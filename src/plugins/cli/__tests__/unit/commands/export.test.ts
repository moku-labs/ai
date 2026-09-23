import { describe, expect, it } from "vitest";
import type { ExportResult } from "../../../../runner/types";
import { runExportCommand } from "../../../commands/export";
import { EXIT_CODES } from "../../../types";
import { createFakeCommandContext } from "../fixtures";

const RESULT: ExportResult = {
  runId: "run-7",
  outDir: "/repo/out",
  files: [
    {
      label: "e01.s01.h3",
      path: "/repo/out/ep01/e01.s01.h3.mp4",
      bytes: 10,
      costUsd: 0.3,
      mimeType: "video/mp4"
    }
  ],
  skipped: ["../escape"]
};

describe("runExportCommand", () => {
  it("exports the given run to --out and prints one line per file plus skipped labels", async () => {
    const calls: unknown[] = [];
    const { context, lines } = createFakeCommandContext({
      runner: {
        export: opts => {
          calls.push(opts);
          return Promise.resolve(RESULT);
        }
      }
    });

    const code = await runExportCommand(context, { out: "renders" }, ["run-7"]);

    expect(code).toBe(EXIT_CODES.ok);
    expect(calls).toEqual([{ runId: "run-7", outDir: "renders" }]);
    const output = lines.join("\n");
    expect(output).toContain("e01.s01.h3");
    expect(output).toContain("$0.3000");
    expect(output).toContain("skipped: unsafe name");
  });

  it("defaults to the newest run and out/", async () => {
    const calls: unknown[] = [];
    const { context, lines } = createFakeCommandContext({
      runner: {
        export: opts => {
          calls.push(opts);
          return Promise.resolve({ ...RESULT, files: [], skipped: [] });
        }
      }
    });

    const code = await runExportCommand(context, {}, []);

    expect(code).toBe(EXIT_CODES.ok);
    expect(calls).toEqual([{ outDir: "out" }]);
    expect(lines.join("\n")).toContain("no done artifacts to export");
  });

  it("returns the failure exit code when the run does not exist", async () => {
    const { context, errorLines } = createFakeCommandContext({
      runner: { export: () => Promise.reject(new Error("[ai] Run not found: nope.")) }
    });

    const code = await runExportCommand(context, {}, ["nope"]);

    expect(code).toBe(EXIT_CODES.failure);
    expect(errorLines.some(line => line.includes("export failed"))).toBe(true);
  });
});
