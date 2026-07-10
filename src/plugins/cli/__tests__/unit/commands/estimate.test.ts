import { describe, expect, it } from "vitest";
import { runEstimateCommand } from "../../../commands/estimate";
import { EXIT_CODES } from "../../../types";
import { createFakeCommandContext } from "../fixtures";

describe("runEstimateCommand", () => {
  it("renders a per-task/provider breakdown plus its total, then exits ok", async () => {
    const { context, lines } = createFakeCommandContext({
      runner: {
        estimate: () =>
          Promise.resolve({
            lines: [{ task: "voiceover", provider: "elevenlabs", items: 3, usd: 0.3 }],
            totalUsd: 0.3
          })
      }
    });

    const code = await runEstimateCommand(context, {}, ["**/*.moku.yaml"]);

    expect(code).toBe(EXIT_CODES.ok);
    expect(lines.some(line => line.includes("voiceover/elevenlabs"))).toBe(true);
    expect(lines.some(line => line.includes("total"))).toBe(true);
  });

  it("omits files from estimate's options when no glob is given", async () => {
    let receivedOptions: { files?: string } | undefined;
    const { context } = createFakeCommandContext({
      runner: {
        estimate: options => {
          receivedOptions = options;
          return Promise.resolve({ lines: [], totalUsd: 0 });
        }
      }
    });

    await runEstimateCommand(context, {}, []);

    expect(receivedOptions).toEqual({});
  });
});
