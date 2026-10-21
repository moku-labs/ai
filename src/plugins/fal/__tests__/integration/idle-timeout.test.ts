import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Integration: a real Bun fetch against a real Bun.serve that sends no byte
// for 10 s. The child runs with a 1 s socket idle timeout, which Bun's sweep
// fires at about 8 s. The plain fetch is the control: it proves the idle timer
// is armed. falFetch passes `timeout: false` and must get its 200.
// ---------------------------------------------------------------------------

const run = promisify(execFile);
const SCRIPT = path.join(import.meta.dirname, "fixtures", "idle-server.ts");

describe("falFetch under Bun's socket idle timeout", () => {
  it("survives a silent wait longer than the idle timeout", { timeout: 30_000 }, async () => {
    const { stdout } = await run("bun", [SCRIPT], {
      env: { ...process.env, BUN_CONFIG_HTTP_IDLE_TIMEOUT: "1" },
      timeout: 25_000
    });

    expect(JSON.parse(stdout)).toEqual({ plain: "TimeoutError", fal: 200 });
  });
});
