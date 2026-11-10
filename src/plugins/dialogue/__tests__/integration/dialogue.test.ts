import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { coreConfig, createCore, createPlugin } from "../../../../config";
import { registryPlugin } from "../../../registry";
import type { DialogueHandler, DialogueRequest } from "../../contract";
import { dialoguePlugin } from "../../index";
import type { DialogueApi } from "../../types";

/** mp3 bytes the fake provider returns ("ID3" header + a marker). */
const SCENE = new Uint8Array([73, 68, 51, 4]);
const LINE = new Uint8Array([73, 68, 51, 5]);

/**
 * A fake dialogue handler that records the requests it executed.
 *
 * @returns The handler and its call log.
 */
function fakeHandler(): { handler: DialogueHandler; calls: DialogueRequest[] } {
  const calls: DialogueRequest[] = [];
  return {
    calls,
    handler: {
      estimate: request => ({ usd: request.lines.length * 0.1 }),
      execute: async request => {
        calls.push(request);
        return {
          audio: SCENE,
          mimeType: "audio/mpeg",
          costUsd: 0.2,
          outputs: [
            { bytes: SCENE, mimeType: "audio/mpeg" },
            { bytes: LINE, mimeType: "audio/mpeg", name: "signAlice" }
          ],
          lines: [{ index: 0, id: "signAlice", startMs: 0, endMs: 900 }]
        };
      }
    }
  };
}

/**
 * Real app: registry + dialogue + one fake provider registered in `onInit`.
 *
 * @param tempDir - Directory for the journal and store.
 * @param handler - The fake dialogue handler.
 * @returns A started app.
 */
async function startApp(tempDir: string, handler: DialogueHandler) {
  const fakeProvider = createPlugin("fakeDialogueProvider", {
    depends: [registryPlugin, dialoguePlugin],
    onInit: ctx => {
      ctx.require(registryPlugin).register("dialogue", "fake", handler);
    }
  });
  const app = createCore(coreConfig, {
    plugins: [registryPlugin, dialoguePlugin, fakeProvider],
    pluginConfigs: {
      journal: { path: path.join(tempDir, "journal.db") },
      store: { dir: path.join(tempDir, "store") },
      dialogue: { defaultProvider: "fake" }
    }
  }).createApp();
  await app.start();
  return app;
}

const request: DialogueRequest = {
  model: "eleven_v4",
  lines: [
    { id: "signAlice", text: "[tense] No.", voice: "v1" },
    { id: "signDaniel", text: "[bitterly] Yes.", voice: "v2" }
  ]
};

describe("dialogue: through a real app", () => {
  let tempDir: string;
  const stops: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "dialogue-int-"));
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("generates, estimates and lists providers through app.dialogue", async () => {
    const { handler, calls } = fakeHandler();
    const app = await startApp(tempDir, handler);
    stops.push(() => app.stop());

    const scene = await app.dialogue.generate(request);

    expect(scene.audio).toBe(SCENE);
    expect(scene.outputs.map(output => output.name)).toEqual([undefined, "signAlice"]);
    expect(calls).toEqual([request]);
    expect(app.dialogue.estimate(request).usd).toBeCloseTo(0.2);
    expect(app.dialogue.providers()).toEqual(["fake"]);
  });

  it("throws the two-line unknown-provider error for an unregistered provider", async () => {
    const app = await startApp(tempDir, fakeHandler().handler);
    stops.push(() => app.stop());

    expect(() => app.dialogue.estimate(request, { provider: "acme" })).toThrow(
      '[ai] No dialogue provider named "acme" is registered.\n  Available: fake.'
    );
  });

  it("exposes app.dialogue typed as DialogueApi", async () => {
    const app = await startApp(tempDir, fakeHandler().handler);
    stops.push(() => app.stop());

    expectTypeOf(app.dialogue).toEqualTypeOf<DialogueApi>();
    expect(Object.keys(app.dialogue).toSorted()).toEqual(["estimate", "generate", "providers"]);
  });
});
