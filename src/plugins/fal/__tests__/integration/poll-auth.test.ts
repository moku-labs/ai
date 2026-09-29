import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvProvider } from "@moku-labs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { buildfilePlugin } from "../../../buildfile";
import { registryPlugin } from "../../../registry";
import { runnerPlugin } from "../../../runner";
import { falPlugin } from "../../index";
import { callsOf } from "../unit/fixtures";

// ---------------------------------------------------------------------------
// Integration: fal refuses the key while the runner polls a paid job. The job
// must end `expired`, not `failed`, so the next run adopts the same request id
// instead of submitting (and paying) again. fetch is stubbed by URL.
// ---------------------------------------------------------------------------

const SUBMIT_URL = "https://queue.fal.run/minimax/h3/image-to-video";
const STATUS_URL = "https://queue.fal.run/x/requests/req-1/status";
const RESULT_URL = "https://queue.fal.run/x/requests/req-1";
const VIDEO_URL = "https://v3.fal.media/clip.mp4";
const CLIP = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);

/** Build file: one fal clip from a keyframe on disk. */
const SHOT_YAML = `version: 1
name: shots
items:
  - id: shot.clip
    task: video
    provider: fal
    input:
      model: minimax-h3
      prompt: "she opens the door"
      image: { $file: key.png }
      seconds: 5
`;

/** A fixture env provider resolving FAL_KEY without touching process.env. */
const fixtureEnvProvider: EnvProvider = {
  name: "fal-poll-auth-fixture",
  load: () => ({ FAL_KEY: "integration-key" })
};

/** Stubs fetch by URL for one fal job; the status GET answers 401 until the key is valid. */
function stubFalQueue(isKeyValid: () => boolean): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === SUBMIT_URL) {
      return Response.json({
        request_id: "req-1",
        status_url: STATUS_URL,
        response_url: RESULT_URL
      });
    }
    if (url === STATUS_URL) {
      if (!isKeyValid()) return Response.json({ detail: "Unauthorized" }, { status: 401 });
      return Response.json({ status: "COMPLETED" });
    }
    if (url === RESULT_URL) {
      return Response.json({ video: { url: VIDEO_URL, content_type: "video/mp4" } });
    }
    if (url === VIDEO_URL) return new Response(CLIP, { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Assembles registry + buildfile + runner + fal, with a probe exposing the journal. */
function buildFramework(dir: string) {
  const probePlugin = coreConfig.createPlugin("probe", {
    api: ctx => ({ journal: ctx.journal })
  });
  return createCore(coreConfig, {
    plugins: [registryPlugin, buildfilePlugin, runnerPlugin, falPlugin, probePlugin],
    pluginConfigs: {
      journal: { path: path.join(dir, "journal.db") },
      store: { dir: path.join(dir, "store") },
      env: { providers: [fixtureEnvProvider] },
      runner: { retryBaseMs: 1, pollIntervalMs: 1 },
      fal: { upload: "data-uri" }
    }
  });
}

describe("fal poll with a refused key through the runner", () => {
  let dir: string;
  const stops: Array<() => Promise<void>> = [];

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "moku-fal-poll-auth-"));
    writeFileSync(path.join(dir, "key.png"), new Uint8Array([1, 2, 3]));
    writeFileSync(path.join(dir, "shots.moku.yaml"), SHOT_YAML);
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("a 401 on the status GET leaves the job expired: the next run adopts the same request id", async () => {
    let isKeyValid = false;
    const fetchMock = stubFalQueue(() => isKeyValid);
    const app = buildFramework(dir).createApp();
    await app.start();
    stops.push(() => app.stop());
    const files = path.join(dir, "*.moku.yaml");

    const first = await app.runner.run({ files });
    const [item] = app.probe.journal.listItems(first.runId);
    const live = app.probe.journal.findLiveJob(item?.artifactKey ?? "");

    expect(first.totals).toMatchObject({ done: 0, failed: 1 });
    expect(live?.jobState).toBe("expired");
    expect(JSON.parse(live?.externalId ?? "{}")).toMatchObject({ requestId: "req-1" });

    isKeyValid = true;
    const second = await app.runner.run({ files });

    expect(second.totals).toMatchObject({ done: 1, failed: 0 });
    const urls = callsOf(fetchMock).map(call => call.url);
    expect(urls.filter(url => url === SUBMIT_URL)).toHaveLength(1);
    expect(urls.filter(url => url === STATUS_URL)).toHaveLength(2);
  });
});
