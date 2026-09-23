/**
 * @file Batch 5 — cross-plugin registry + provider integration (S18–S21).
 *
 * Exercises the registry surface, the real elevenlabs/openai provider plugins
 * (fetch stubbed at the HTTP boundary — no network anywhere), and estimate
 * parity between the task facades and the runner. Per-test tmp dirs keep
 * `.moku/` out of the repo.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFileYaml,
  buildFramework,
  createFakeHandler,
  createFakeProviderPlugin
} from "./helpers";

/**
 * OpenAI's real chat message `content`/`refusal` fields are typed
 * `string | null` — the single source of the `null` literal for this file.
 */
// eslint-disable-next-line unicorn/no-null -- see comment above
const NO_TEXT = null;

/** Builds a fake `chat.completions` response echoing the prompt back as `echo:<prompt>`. */
function fakeChatResponse(echo: string): Response {
  const payload = {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 0,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: `echo:${echo}`, refusal: NO_TEXT }
      }
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  };
  return Response.json(payload);
}

/**
 * Fakes the OpenAI HTTP boundary: dispatches by request path to a chat
 * response echoing the last user message (pattern copied from
 * `src/plugins/openai/__tests__/integration/openai.test.ts`).
 */
function createFakeOpenaiFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ content: string }>;
      };
      return fakeChatResponse(body.messages?.at(-1)?.content ?? "");
    }
    throw new Error(`createFakeOpenaiFetch: unexpected request to ${url}`);
  }) as typeof fetch;
}

/**
 * A successful ElevenLabs TTS response carrying `bytes` as the audio body
 * (pattern copied from `src/plugins/elevenlabs/__tests__/integration/`).
 */
function fakeElevenlabsAudioResponse(bytes: Uint8Array): Response {
  const fake = {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: () => Promise.resolve({}),
    arrayBuffer: () => Promise.resolve(bytes.buffer)
  };
  return fake as unknown as Response;
}

describe("cross-plugin registry + providers integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-root-int-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  // ---------------------------------------------------------------------------
  // S18 — registry surface + duplicate-registration guard
  // ---------------------------------------------------------------------------

  it("S18: registry surface reflects registrations and guards duplicates", async () => {
    const handlerA = createFakeHandler({ costUsd: 0.01 });
    const handlerB = createFakeHandler({ costUsd: 0.02 });
    const app = buildFramework(tempDir, {
      extraPlugins: [createFakeProviderPlugin("fakeProvider", "voiceover", "fake", handlerA)]
    }).createApp();
    await app.start();

    // A second provider registered post-start, to pin registration ordering.
    app.registry.register("voiceover", "fake-b", handlerB);

    // tasks() and providers() reflect registration order.
    expect(app.registry.tasks()).toContain("voiceover");
    expect(app.registry.providers("voiceover")).toEqual(["fake", "fake-b"]);

    // resolve() returns the registered handler by reference, or undefined.
    expect(app.registry.resolve("voiceover", "fake")).toBe(handlerA);
    expect(app.registry.resolve("voiceover", "nope")).toBeUndefined();

    // Duplicate registration throws the pinned two-line message.
    expect(() => app.registry.register("voiceover", "fake", handlerA)).toThrow(
      '[ai] Provider "fake" is already registered for task "voiceover".\n  Register each task/provider pair exactly once.'
    );

    await app.stop();
  });

  // ---------------------------------------------------------------------------
  // S19 — openai registers all 3 tasks; facades generate through the real stack
  // ---------------------------------------------------------------------------

  it("S19: openai registers under all three tasks and generates through each facade", async () => {
    vi.stubGlobal("fetch", createFakeOpenaiFetch());
    const app = buildFramework(tempDir, { providers: true }).createApp();
    await app.start();

    // onInit registered openai under every task facade.
    expect(app.voiceover.providers()).toContain("openai");
    expect(app.translate.providers()).toContain("openai");
    expect(app.promptGen.providers()).toContain("openai");

    // translate round-trips through the real plugin + stubbed HTTP boundary.
    const translated = await app.translate.generate(
      { text: "Hello", targetLang: "es" },
      { provider: "openai" }
    );
    expect(translated.text).toBe("echo:Hello");
    expect(translated.costUsd).toBeGreaterThan(0);

    // prompt-gen round-trips the same way.
    const prompted = await app.promptGen.generate(
      { prompt: "Describe a sunset." },
      { provider: "openai" }
    );
    expect(prompted.text).toBe("echo:Describe a sunset.");
    expect(prompted.text.length).toBeGreaterThan(0);
    expect(prompted.costUsd).toBeGreaterThanOrEqual(0);

    // info() reflects the fixture-configured API key and bundled models.
    expect(app.openai.info()).toEqual({
      provider: "openai",
      configured: true,
      models: { tts: "gpt-4o-mini-tts", chat: "gpt-4o-mini" }
    });

    await app.stop();
  });

  // ---------------------------------------------------------------------------
  // S20 — elevenlabs through the full runner pipeline (registry → runner with
  // journal + store under it). The runner hands handlers the flat task
  // request (D1), so the real elevenlabs handler runs with no adapter.
  // ---------------------------------------------------------------------------

  it("S20: real elevenlabs handler runs through the runner pipeline into store + journal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(fakeElevenlabsAudioResponse(new Uint8Array([1, 2, 3])))
    );
    const app = buildFramework(tempDir, {
      providers: true,
      pluginConfigs: { elevenlabs: { priceOverrides: { eleven_multilingual_v2: 0.001 } } }
    }).createApp();
    await app.start();
    expect(app.elevenlabs.info().configured).toBe(true);

    // One elevenlabs voiceover item, planned and run with no adapter (D1).
    // It also carries mime type and label onto the journal row (D9).
    const voiceDir = path.join(tempDir, "voice");
    await mkdir(voiceDir);
    await writeFile(
      path.join(voiceDir, "voice.moku.yaml"),
      buildFileYaml("voice", [
        {
          task: "voiceover",
          provider: "elevenlabs",
          input: { text: "Hello world", voice: "voice-1" }
        }
      ])
    );

    // The run settles done, with the fake audio bytes committed to the CAS.
    const result = await app.runner.run({ files: path.join(voiceDir, "*.moku.yaml") });
    expect(result.status).toBe("done");
    expect(result.totals.done).toBe(1);

    const [doneItem] = app.probe.journal.listItems(result.runId, { status: "done" });
    if (!doneItem || doneItem.contentHash === null) {
      throw new Error("expected one done item with a contentHash");
    }
    expect(await app.probe.store.read(doneItem.contentHash)).toEqual(new Uint8Array([1, 2, 3]));

    // Cost came from the elevenlabs price table: "Hello world" × 0.001/char.
    expect(doneItem.actualCostUsd).toBeCloseTo("Hello world".length * 0.001, 10);
    expect(doneItem.mimeType).toBe("audio/mpeg");
    expect(doneItem.label).toBe("01-voiceover");

    await app.stop();
  });

  // ---------------------------------------------------------------------------
  // S21 — estimate parity: facade estimate === runner estimate === handler
  // ---------------------------------------------------------------------------

  it("S21: facade and runner estimates both come from the same handler estimate()", async () => {
    const handler = createFakeHandler({ costUsd: 0.07 });
    const app = buildFramework(tempDir, {
      extraPlugins: [createFakeProviderPlugin("fakeProvider", "voiceover", "fake", handler)]
    }).createApp();
    await app.start();

    // Two identical voiceover items in one build file.
    await writeFile(
      path.join(tempDir, "estimate.moku.yaml"),
      buildFileYaml("estimate-parity", [
        { task: "voiceover", provider: "fake", input: { text: "hi", voice: "v1" } },
        { task: "voiceover", provider: "fake", input: { text: "hi", voice: "v1" } }
      ])
    );

    // Facade estimate: the handler's own number, untouched.
    const facade = app.voiceover.estimate({ text: "hi", voice: "v1" }, { provider: "fake" });
    expect(facade).toEqual({ usd: 0.07 });

    // Runner estimate: one line per task/provider, 2 items × the same 0.07.
    const runnerEstimate = await app.runner.estimate({
      files: path.join(tempDir, "*.moku.yaml")
    });
    expect(runnerEstimate.lines).toHaveLength(1);
    const [line] = runnerEstimate.lines;
    if (!line) {
      throw new Error("expected one estimate line");
    }
    expect(line).toMatchObject({ task: "voiceover", provider: "fake", items: 2 });
    expect(line.usd).toBeCloseTo(0.14, 10);
    expect(runnerEstimate.totalUsd).toBeCloseTo(0.14, 10);
    expect(runnerEstimate.totalUsd).toBe(line.usd);

    await app.stop();
  });
});
