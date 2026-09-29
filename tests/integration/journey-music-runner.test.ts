/**
 * @file Journey: music build items through the runner with the REAL fal provider.
 *
 * The assembled framework (`createApp` from `src/index.ts`) runs a
 * `task: music` build item end to end: fal queue submit → status poll →
 * result → CDN download → CAS artifact (audio/mpeg, exported as `.mp3`) with
 * the price the fal music table computes. A second run reuses the artifact
 * without calling fal, and the `app.music.generate` facade drives the same
 * provider in the same app. Global fetch is stubbed at the HTTP boundary; no
 * network. Per-test tmp dirs keep `.moku/` out of the repo.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/index";
import type { RunEvent } from "../../src/plugins/runner/types";
import {
  buildFileYaml,
  collectStream,
  createRunEventListenerPlugin,
  fixtureEnvProvider
} from "./helpers";

/** ID3-tagged bytes standing in for an MP3 track. */
const MP3 = new Uint8Array([73, 68, 51, 4, 0, 0]);

/** fal queue base URL (the fal plugin default). */
const QUEUE_URL = "https://queue.fal.run";

/** The ElevenLabs Music endpoint of `elevenlabs-music-v2.5`. */
const ELEVENLABS_ENDPOINT = "fal-ai/elevenlabs/music/v2.5";

/** The Stable Audio endpoint of `stable-audio-2.5`. */
const STABLE_AUDIO_ENDPOINT = "fal-ai/stable-audio-25/text-to-audio";

/** Counts of each kind of fal call the fake queue answered. */
type FalCalls = {
  submit: string[];
  status: number;
  result: number;
  download: number;
  bodies: unknown[];
};

/**
 * Fakes the fal queue by URL: a submit POST returns queue URLs for a new
 * request id, the first status read of a job is `IN_QUEUE` and the next
 * `COMPLETED`, the result names a CDN `.mp3`, and the CDN serves {@link MP3}.
 * Any other URL fails the test.
 */
function createFakeFalQueue(): { fetch: typeof fetch; calls: FalCalls } {
  const calls: FalCalls = { submit: [], status: 0, result: 0, download: 0, bodies: [] };
  const statusReads = new Map<string, number>();

  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();

    // CDN download (no key).
    if (url.startsWith("https://v3.fal.media/")) {
      calls.download += 1;
      return new Response(MP3, { status: 200, headers: { "content-type": "audio/mpeg" } });
    }

    // Status read: pending once, then completed.
    const statusMatch = /\/requests\/([^/]+)\/status$/.exec(url);
    if (statusMatch?.[1] !== undefined) {
      calls.status += 1;
      const reads = (statusReads.get(statusMatch[1]) ?? 0) + 1;
      statusReads.set(statusMatch[1], reads);
      return Response.json({ status: reads === 1 ? "IN_QUEUE" : "COMPLETED" });
    }

    // Result body: the CDN URL of the track.
    if (/\/requests\/[^/]+$/.test(url)) {
      calls.result += 1;
      return Response.json({ audio: { url: "https://v3.fal.media/files/track.mp3" } });
    }

    // Submit: a new queue job on the posted endpoint.
    if (init?.method === "POST" && url.startsWith(`${QUEUE_URL}/`)) {
      const requestId = `mus-${calls.submit.length + 1}`;
      calls.submit.push(url);
      calls.bodies.push(JSON.parse(String(init.body ?? "{}")));
      return Response.json({
        request_id: requestId,
        status_url: `${QUEUE_URL}/x/requests/${requestId}/status`,
        response_url: `${QUEUE_URL}/x/requests/${requestId}`
      });
    }

    throw new Error(`createFakeFalQueue: unexpected request to ${url}`);
  };

  return { fetch: fake as typeof fetch, calls };
}

/** The `pluginConfigs` type `createApp` declares (regular plugins only). */
type AppPluginConfigs = NonNullable<NonNullable<Parameters<typeof createApp>[0]>["pluginConfigs"]>;

/**
 * Assembles the real framework app with journal/store under `tempDir`, a
 * fixture FAL_KEY and a listener capturing runner bus events into `sink`.
 */
function buildApp(tempDir: string, sink: Record<string, unknown[]> = {}) {
  // Audited cast: createApp's type lists only regular plugins, but the kernel
  // also applies the core plugins' (journal, store, env) overrides at runtime.
  const pluginConfigs = {
    journal: { path: path.join(tempDir, "journal.db") },
    store: { dir: path.join(tempDir, "store") },
    env: { providers: [fixtureEnvProvider({ FAL_KEY: "test-key" })] },
    runner: { pollIntervalMs: 1 },
    fal: { pollIntervalMs: 0 }
  } as unknown as AppPluginConfigs;

  return createApp({ plugins: [createRunEventListenerPlugin(sink)], pluginConfigs });
}

/** The single `item:done` record of a run stream. */
function doneRecord(records: RunEvent[]) {
  const done = records.flatMap(record => (record.type === "item:done" ? [record] : []));
  expect(done).toHaveLength(1);
  const [record] = done;
  if (!record) {
    throw new Error("expected one item:done record");
  }
  return record;
}

describe("journey: music build items through the runner and fal", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-root-int-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("runs a music item end to end, reuses it on the next run, and serves app.music.generate", async () => {
    const falQueue = createFakeFalQueue();
    vi.stubGlobal("fetch", vi.fn(falQueue.fetch));
    const app = buildApp(tempDir);
    await app.start();

    // Author: one ElevenLabs Music item, 65 s → two started minutes at $0.80.
    await writeFile(
      path.join(tempDir, "score.moku.yaml"),
      buildFileYaml("score", [
        {
          task: "music",
          provider: "fal",
          input: { prompt: "tense synth pulse", model: "elevenlabs-music-v2.5", lengthMs: "65000" }
        }
      ])
    );
    const glob = path.join(tempDir, "*.moku.yaml");
    const expectedUsd = 1.6;

    // Estimate: the fal music price table, no network.
    const estimate = await app.runner.estimate({ files: glob });
    expect(estimate.totalUsd).toBeCloseTo(expectedUsd, 10);
    expect(estimate.lines).toEqual([
      { task: "music", provider: "fal", items: 1, usd: expectedUsd }
    ]);
    expect(falQueue.calls.submit).toEqual([]);

    // Run 1: submit → poll (IN_QUEUE, COMPLETED) → result → download.
    const firstPromise = app.runner.run({ files: glob });
    const firstRecords = await collectStream(app, firstPromise);
    const first = await firstPromise;
    expect(first.status).toBe("done");
    expect(first.totals).toMatchObject({ total: 1, done: 1, failed: 0, flagged: 0 });
    expect(falQueue.calls).toMatchObject({ status: 2, result: 1, download: 1 });
    expect(falQueue.calls.submit).toEqual([`${QUEUE_URL}/${ELEVENLABS_ENDPOINT}`]);
    expect(falQueue.calls.bodies[0]).toEqual({
      prompt: "tense synth pulse",
      music_length_ms: 65_000,
      force_instrumental: true,
      output_format: "mp3_48000_192"
    });

    // Cost recorded: the item and the run spend carry the computed price.
    const firstDone = doneRecord(firstRecords);
    expect(firstDone.costUsd).toBeCloseTo(expectedUsd, 10);
    expect(app.runner.status(first.runId).totals.spendUsd).toBeCloseTo(expectedUsd, 10);

    // Stored as audio: the export is an .mp3 with the downloaded bytes.
    const exported = await app.runner.export({
      runId: first.runId,
      outDir: path.join(tempDir, "out")
    });
    expect(exported.files).toHaveLength(1);
    const [file] = exported.files;
    expect(file?.mimeType).toBe("audio/mpeg");
    expect(file?.path.endsWith(".mp3")).toBe(true);
    expect(file?.costUsd).toBeCloseTo(expectedUsd, 10);
    expect(new Uint8Array(await readFile(file?.path ?? ""))).toEqual(MP3);

    // Run 2: the same item reuses the artifact at cost 0; fal is not called again.
    const callsAfterFirst = vi.mocked(fetch).mock.calls.length;
    const secondPromise = app.runner.run({ files: glob });
    const secondRecords = await collectStream(app, secondPromise);
    const second = await secondPromise;
    expect(second.runId).not.toBe(first.runId);
    expect(second.status).toBe("done");
    expect(second.totals).toMatchObject({ total: 1, done: 1 });
    const secondDone = doneRecord(secondRecords);
    expect(secondDone.contentHash).toBe(firstDone.contentHash);
    expect(secondDone.costUsd).toBe(0);
    expect(app.runner.status(second.runId).totals.spendUsd).toBe(0);
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsAfterFirst);
    expect(falQueue.calls.submit).toHaveLength(1);

    // Facade in the same app: app.music.generate drives the same fal provider.
    const generated = await app.music.generate({
      prompt: "rain on glass",
      model: "stable-audio-2.5",
      lengthMs: 30_000
    });
    expect(generated).toMatchObject({ audio: MP3, mimeType: "audio/mpeg", costUsd: 0.2 });
    expect(falQueue.calls.submit).toEqual([
      `${QUEUE_URL}/${ELEVENLABS_ENDPOINT}`,
      `${QUEUE_URL}/${STABLE_AUDIO_ENDPOINT}`
    ]);
    expect(falQueue.calls.bodies[1]).toEqual({ prompt: "rain on glass", seconds_total: 30 });

    await app.stop();
  });

  it("rejects a music item without a model at planning, before any fal call", async () => {
    const falQueue = createFakeFalQueue();
    vi.stubGlobal("fetch", vi.fn(falQueue.fetch));
    const sink: Record<string, unknown[]> = {};
    const app = buildApp(tempDir, sink);
    await app.start();

    // The build file schema accepts any input record; the fal handler's
    // request check refuses the missing model when the runner estimates it.
    await writeFile(
      path.join(tempDir, "no-model.moku.yaml"),
      buildFileYaml("no-model", [
        { task: "music", provider: "fal", input: { prompt: "tense synth", lengthMs: "30000" } }
      ])
    );
    const glob = path.join(tempDir, "*.moku.yaml");
    const compiled = await app.buildfile.loadGlob(glob);
    expect(compiled[0]?.spec.items[0]).toMatchObject({ task: "music", provider: "fal" });

    // estimate() rejects with the handler's 400; run() resolves failed with no items.
    const invalid = /\[ai\] Invalid music request: model /;
    await expect(app.runner.estimate({ files: glob })).rejects.toThrow(invalid);
    const result = await app.runner.run({ files: glob });
    expect(result.status).toBe("failed");
    expect(result.totals).toMatchObject({ total: 0, done: 0, spendUsd: 0 });
    expect(sink["run:failed"]).toEqual([
      { runId: result.runId, error: expect.stringMatching(invalid) }
    ]);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();

    await app.stop();
  });
});
