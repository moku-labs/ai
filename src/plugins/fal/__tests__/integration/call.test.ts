import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvProvider } from "@moku-labs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { buildfilePlugin } from "../../../buildfile";
import { registryPlugin } from "../../../registry";
import { runnerPlugin } from "../../../runner";
import { falPlugin } from "../../index";

// ---------------------------------------------------------------------------
// Integration: a one-item build file with task `call` goes through app.runner.run
// into the fal call handler, over a fake fal queue (fetch stubbed at the boundary,
// no network, a fixture key). Real journal and store in a temp directory.
// ---------------------------------------------------------------------------

const ENDPOINT = "fal-ai/sam-3/image";
const QUEUE = "https://queue.fal.run";
const UPLOAD_URL = "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3";
const ANSWER = { masks: [{ url: "https://v3.fal.media/files/mask-0.png" }], scores: [0.97, 0.5] };

/** A fixture env provider resolving FAL_KEY without touching process.env. */
const fixtureEnvProvider: EnvProvider = {
  name: "fal-call-fixture",
  load: () => ({ FAL_KEY: "integration-key" })
};

/** One fetch the fake fal saw. */
type Seen = { method: string; url: string };

/**
 * Stubs fetch as a fake fal: storage upload, queue POST, status, and a result
 * GET that answers 503 on its first call and `ANSWER` after.
 *
 * @returns Every request seen, in order.
 */
function stubFal(): Seen[] {
  const seen: Seen[] = [];
  let resultReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      seen.push({ method, url });

      if (url === UPLOAD_URL) {
        return Response.json({
          upload_url: "https://upload.fal.test/put/1",
          file_url: "https://cdn.fal.test/file/plate.png"
        });
      }
      if (url.startsWith("https://upload.fal.test/")) return new Response("", { status: 200 });
      if (method === "POST" && url === `${QUEUE}/${ENDPOINT}`) {
        return Response.json({
          request_id: "req-1",
          status_url: `${QUEUE}/${ENDPOINT}/requests/req-1/status`,
          response_url: `${QUEUE}/${ENDPOINT}/requests/req-1`
        });
      }
      if (url === `${QUEUE}/${ENDPOINT}/requests/req-1/status`) {
        return Response.json({ status: "COMPLETED" });
      }
      if (url === `${QUEUE}/${ENDPOINT}/requests/req-1`) {
        resultReads += 1;
        return resultReads === 1
          ? Response.json({ detail: "busy" }, { status: 503 })
          : Response.json(ANSWER);
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    })
  );
  return seen;
}

/** The one-item build file: a `call` item with a local plate marked `$file`. */
const BUILD_FILE = `version: 1
name: calls
items:
  - id: mask
    task: call
    provider: fal
    input:
      endpoint: ${ENDPOINT}
      input:
        prompt: wall
        image_url:
          $file: plate.png
`;

describe("fal call through the runner", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "moku-fal-call-"));
    writeFileSync(path.join(tempDir, "plate.png"), new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
    writeFileSync(path.join(tempDir, "calls.moku.yaml"), BUILD_FILE);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("ends done at 0.005 with fal's answer stored, and a 503 on the result never submits again", async () => {
    // Bug: a retry submits a paid job again, or the store holds something other than fal's answer.
    const seen = stubFal();
    const probe = coreConfig.createPlugin("probe", {
      api: ctx => ({ journal: ctx.journal })
    });
    const app = createCore(coreConfig, {
      plugins: [registryPlugin, buildfilePlugin, runnerPlugin, falPlugin, probe],
      pluginConfigs: {
        journal: { path: path.join(tempDir, "journal.db") },
        store: { dir: path.join(tempDir, "store") },
        env: { providers: [fixtureEnvProvider] },
        runner: { retryBaseMs: 1, pollIntervalMs: 1 },
        fal: { pollIntervalMs: 0 }
      }
    }).createApp();
    await app.start();

    // Bug: the handler is registered under another provider name and `moku call` finds no provider.
    expect(app.registry.providers("call")).toEqual(["fal"]);

    const result = await app.runner.run({ files: path.join(tempDir, "*.moku.yaml") });

    expect(result).toMatchObject({ status: "done", totals: { total: 1, done: 1 } });
    const [item] = app.probe.journal.listItems(result.runId, { status: "done" });
    expect(item?.actualCostUsd).toBe(0.005);
    expect(item?.mimeType).toBe("application/json");

    const exported = await app.runner.export({ outDir: path.join(tempDir, "out") });
    const stored = readFileSync(exported.files[0]?.path ?? "", "utf8");
    expect(stored).toBe(JSON.stringify(ANSWER));

    // One upload, one queue POST; the result GET ran twice (503, then the answer).
    const posts = seen.filter(
      call => call.method === "POST" && call.url === `${QUEUE}/${ENDPOINT}`
    );
    const resultReads = seen.filter(call => call.url === `${QUEUE}/${ENDPOINT}/requests/req-1`);
    expect(posts).toHaveLength(1);
    expect(resultReads).toHaveLength(2);
    expect(seen.filter(call => call.url === UPLOAD_URL)).toHaveLength(1);

    await app.stop();
  });
});
