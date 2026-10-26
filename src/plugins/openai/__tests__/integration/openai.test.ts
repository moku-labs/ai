import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvProvider } from "@moku-labs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { promptGenPlugin } from "../../../promptGen";
import type { ChatMessage } from "../../../promptGen/contract";
import { registryPlugin } from "../../../registry";
import { translatePlugin } from "../../../translate";
import { voiceoverPlugin } from "../../../voiceover";
import { FlaggedProviderError } from "../../errors";
import { openaiPlugin } from "../../index";

// ---------------------------------------------------------------------------
// Integration test: openai provider through the real createApp lifecycle —
// registered under all three tasks (voiceover/translate/prompt-gen) in
// onInit, consumed end-to-end through each task facade. Fetch is mocked at
// the boundary (vi.stubGlobal, real Response instances — the SDK reads
// `.headers.entries()`/`.text()`/`.json()`/`.arrayBuffer()` internally, so a
// hand-rolled fake object is not enough); NO real network calls anywhere.
// ---------------------------------------------------------------------------

/**
 * OpenAI's real chat message `content`/`refusal` fields are typed
 * `string | null` — the single source of the `null` literal for this file.
 */
// eslint-disable-next-line unicorn/no-null -- see comment above
const NO_TEXT = null;

/**
 * Builds a `chat.completions` response echoing `options.echo` back as the
 * assistant's content, or a refusal when `options.flagged` is set.
 *
 * @param options - The text to echo, and whether to simulate a refusal.
 * @param options.echo - The text to echo back as the completion content.
 * @param options.flagged - When true, the response carries a refusal instead of content.
 * @returns A fake chat completion `Response`.
 * @example
 * ```ts
 * fakeChatResponse({ echo: "Hello" });
 * ```
 */
function fakeChatResponse(options: { echo: string; flagged?: boolean }): Response {
  const payload = {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 0,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: options.flagged ? NO_TEXT : `echo:${options.echo}`,
          refusal: options.flagged ? "I can't help with that." : NO_TEXT
        }
      }
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  };
  return Response.json(payload);
}

/**
 * Builds an `audio.speech` response carrying `bytes` as the raw audio body.
 *
 * @param bytes - The raw audio bytes the response should carry.
 * @returns A fake tts `Response`.
 * @example
 * ```ts
 * fakeSpeechResponse(new Uint8Array([1, 2, 3, 4]));
 * ```
 */
function fakeSpeechResponse(bytes: Uint8Array): Response {
  return new Response(bytes, { status: 200, headers: { "content-type": "audio/mpeg" } });
}

/** The parts of a posted Responses body the fake reads. */
type ResponsesBody = {
  model: string;
  store?: boolean;
  reasoning?: { effort: string };
  tools?: unknown[];
  input: Array<{ type: string; role?: string; content?: Array<{ text?: string }> }>;
};

/**
 * Builds a Responses answer for a posted body: a GPT-6 tool turn (a
 * reasoning item and one `read_frame` call) when the body offers tools and
 * answers no call yet; otherwise a text answer echoing the last user text.
 *
 * @param body - The posted Responses body.
 * @returns A fake Responses `Response`.
 * @example
 * ```ts
 * fakeResponsesResponse({ model: "gpt-4o-mini", input: [] });
 * ```
 */
function fakeResponsesResponse(body: ResponsesBody): Response {
  const usage = { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } };
  const answersCall = body.input.some(item => item.type === "function_call_output");
  if (body.tools !== undefined && !answersCall) {
    const output = [
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC" },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "read_frame",
        arguments: '{"shot":3}'
      }
    ];
    return Response.json({ id: "resp_1", object: "response", status: "completed", output, usage });
  }

  const lastUser = body.input.findLast(item => item.role === "user");
  const text = `echo:${lastUser?.content?.[0]?.text ?? ""}`;
  const output = [{ type: "message", content: [{ type: "output_text", text, annotations: [] }] }];
  return Response.json({ id: "resp_2", object: "response", status: "completed", output, usage });
}

/**
 * Fakes the OpenAI HTTP boundary: dispatches by request path to a chat,
 * Responses or speech response, reading the last user message out of the
 * request body so assertions can verify the round trip end to end.
 *
 * @param responsesBodies - Collects every posted Responses body, in order.
 * @param idleTimeouts - Collects Bun's idle `timeout` fetch option of every Responses request.
 * @returns A fake `fetch` implementation.
 * @example
 * ```ts
 * vi.stubGlobal("fetch", createFakeOpenaiFetch());
 * ```
 */
function createFakeOpenaiFetch(
  responsesBodies: ResponsesBody[] = [],
  idleTimeouts: unknown[] = []
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/audio/speech")) {
      return fakeSpeechResponse(new Uint8Array([1, 2, 3, 4]));
    }
    if (url.includes("/responses")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as ResponsesBody;
      responsesBodies.push(body);
      idleTimeouts.push(Reflect.get(init ?? {}, "timeout"));
      return fakeResponsesResponse(body);
    }
    if (url.includes("/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ content: string }>;
      };
      const lastMessage = body.messages?.at(-1)?.content ?? "";
      return fakeChatResponse({
        echo: lastMessage,
        flagged: lastMessage.includes("TRIGGER_CONTENT_POLICY")
      });
    }
    throw new Error(`createFakeOpenaiFetch: unexpected request to ${url}`);
  }) as typeof fetch;
}

/** A fixture `EnvProvider` resolving `OPENAI_API_KEY` without touching real process env. */
const fixtureEnvProvider: EnvProvider = {
  name: "openai-integration-fixture",
  load: () => ({ OPENAI_API_KEY: "test-key" })
};

/**
 * Assembles a fresh framework wiring registry + voiceover + translate +
 * promptGen + openai. `journal` (core plugin) is pinned to `dbPath` so
 * `onStart` never writes `.moku/journal.db` into the repo's real cwd; `env`
 * (also core) is pinned to the fixture provider above when `withApiKey` is
 * true, so `configured`/`execute()` see a resolved API key without touching
 * real process env.
 *
 * @param dbPath - The temp-dir journal database path for this test.
 * @param withApiKey - Whether to wire the fixture env provider supplying the API key.
 * @returns The assembled framework (`createApp`/`createPlugin`).
 * @example
 * ```ts
 * const { createApp } = buildFramework(dbPath, true);
 * ```
 */
function buildFramework(dbPath: string, withApiKey: boolean) {
  return createCore(coreConfig, {
    plugins: [registryPlugin, voiceoverPlugin, translatePlugin, promptGenPlugin, openaiPlugin],
    pluginConfigs: {
      journal: { path: dbPath },
      ...(withApiKey ? { env: { providers: [fixtureEnvProvider] } } : {})
    }
  });
}

describe("openai integration", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "moku-openai-integration-"));
    dbPath = path.join(tempDir, "journal.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("registers under all three tasks in onInit, visible via each facade's providers()", async () => {
    const { createApp } = buildFramework(dbPath, true);
    const app = createApp();
    await app.start();

    expect(app.voiceover.providers()).toEqual(["openai"]);
    expect(app.translate.providers()).toEqual(["openai"]);
    expect(app.promptGen.providers()).toEqual(["openai"]);

    await app.stop();
  });

  it("round-trips through app.voiceover.generate() with provider openai", async () => {
    vi.stubGlobal("fetch", createFakeOpenaiFetch());
    const { createApp } = buildFramework(dbPath, true);
    const app = createApp();
    await app.start();

    const result = await app.voiceover.generate(
      { text: "Hello", voice: "alloy" },
      { provider: "openai" }
    );

    expect([...result.audio]).toEqual([1, 2, 3, 4]);
    expect(result.mimeType).toBe("audio/mpeg");
    expect(result.costUsd).toBeCloseTo(("Hello".length / 1_000_000) * 15, 10);

    await app.stop();
  });

  it("round-trips through app.translate.generate() with provider openai", async () => {
    vi.stubGlobal("fetch", createFakeOpenaiFetch());
    const { createApp } = buildFramework(dbPath, true);
    const app = createApp();
    await app.start();

    const result = await app.translate.generate(
      { text: "Hello", targetLang: "es" },
      { provider: "openai" }
    );

    expect(result.text).toBe("echo:Hello");
    expect(result.costUsd).toBeGreaterThan(0);

    await app.stop();
  });

  it("round-trips through app.promptGen.generate() with provider openai", async () => {
    vi.stubGlobal("fetch", createFakeOpenaiFetch());
    const { createApp } = buildFramework(dbPath, true);
    const app = createApp();
    await app.start();

    const result = await app.promptGen.generate(
      { prompt: "Describe a sunset." },
      { provider: "openai" }
    );

    expect(result.text).toBe("echo:Describe a sunset.");
    expect(result.costUsd).toBeGreaterThan(0);

    await app.stop();
  });

  it("sends a gpt-6-astra tool turn to responses.create and replays its reasoning on the next step", async () => {
    const sent: ResponsesBody[] = [];
    const idleTimeouts: unknown[] = [];
    vi.stubGlobal("fetch", createFakeOpenaiFetch(sent, idleTimeouts));
    const { createApp } = buildFramework(dbPath, true);
    const app = createApp();
    await app.start();
    const tools = [
      { name: "read_frame", description: "One frame.", inputSchema: { type: "object" } }
    ];
    const asked: ChatMessage[] = [{ role: "user", content: "Check shot 3." }];

    const first = await app.promptGen.generate(
      { prompt: "", model: "openai/gpt-6-astra", messages: asked, tools },
      { provider: "openai" }
    );
    const answered: ChatMessage[] = [
      ...asked,
      { role: "assistant", content: NO_TEXT, toolCalls: first.toolCalls },
      { role: "tool", toolCallId: "call_1", content: "Subject is cut at the chin." }
    ];
    await app.promptGen.generate(
      { prompt: "", model: "openai/gpt-6-astra", messages: answered, tools },
      { provider: "openai" }
    );

    expect(first.toolCalls).toEqual([{ id: "call_1", name: "read_frame", input: { shot: 3 } }]);
    expect(first.finishReason).toBe("tool_calls");
    // Bun's socket idle timer is off: a long reasoning pass is never cut at ~5 min.
    expect(idleTimeouts).toEqual([false, false]);
    expect(sent[0]).toMatchObject({
      model: "gpt-6-astra",
      store: false,
      reasoning: { effort: "medium" }
    });
    expect(sent[1]?.input.map(item => item.type)).toEqual([
      "message",
      "reasoning",
      "function_call",
      "function_call_output"
    ]);

    await app.stop();
  });

  it("exposes app.openai.info() reflecting the configured API key", async () => {
    const { createApp } = buildFramework(dbPath, true);
    const app = createApp();
    await app.start();

    expect(app.openai.info()).toEqual({
      provider: "openai",
      configured: true,
      models: { tts: "gpt-4o-mini-tts", chat: "gpt-4o-mini" }
    });

    await app.stop();
  });

  it("app.openai.info() reports configured: false with no API key configured", async () => {
    const { createApp } = buildFramework(dbPath, false);
    const app = createApp();
    await app.start();

    expect(app.openai.info().configured).toBe(false);

    await app.stop();
  });

  it("throws the pinned missing-key error from execute() when no API key is configured", async () => {
    const { createApp } = buildFramework(dbPath, false);
    const app = createApp();
    await app.start();

    await expect(
      app.voiceover.generate({ text: "hi", voice: "alloy" }, { provider: "openai" })
    ).rejects.toThrow(
      "[ai] OPENAI_API_KEY is not set.\n  Export it or set config.apiKeyEnv to the variable that holds your key."
    );

    await app.stop();
  });

  it("propagates a FlaggedProviderError through app.translate.generate() on a model refusal", async () => {
    vi.stubGlobal("fetch", createFakeOpenaiFetch());
    const { createApp } = buildFramework(dbPath, true);
    const app = createApp();
    await app.start();

    await expect(
      app.translate.generate(
        { text: "TRIGGER_CONTENT_POLICY", targetLang: "es" },
        { provider: "openai" }
      )
    ).rejects.toBeInstanceOf(FlaggedProviderError);

    await app.stop();
  });
});
