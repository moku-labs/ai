import { describe, expect, it } from "vitest";
import { runValidateCommand } from "../../../commands/validate";
import { EXIT_CODES } from "../../../types";
import { createFakeCommandContext } from "../fixtures";

describe("runValidateCommand", () => {
  it("renders an OK row per compiled build file and exits ok", async () => {
    const { context, lines } = createFakeCommandContext({
      buildfile: {
        loadGlob: () =>
          Promise.resolve([
            { file: "a.moku.yaml", spec: { version: 1, name: "a", items: [] } },
            { file: "b.moku.yaml", spec: { version: 1, name: "b", items: [] } }
          ])
      }
    });

    const code = await runValidateCommand(context, {}, ["**/*.moku.yaml"]);

    expect(code).toBe(EXIT_CODES.ok);
    expect(lines.some(line => line.includes("a.moku.yaml"))).toBe(true);
    expect(lines.some(line => line.includes("b.moku.yaml"))).toBe(true);
  });

  it("renders a failing row and exits with the validation exit code on an invalid build file", async () => {
    const { context, lines } = createFakeCommandContext({
      buildfile: {
        loadGlob: () =>
          Promise.reject(
            new Error('[ai] Build file "bad.moku.yaml" is invalid.\n  name: Required.')
          )
      }
    });

    const code = await runValidateCommand(context, {}, ["**/*.moku.yaml"]);

    expect(code).toBe(EXIT_CODES.validation);
    expect(lines.some(line => line.includes("is invalid"))).toBe(true);
  });
});
