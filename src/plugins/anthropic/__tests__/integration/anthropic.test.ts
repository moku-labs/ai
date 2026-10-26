/**
 * @file anthropic integration — the plugin in a real app (registry +
 * promptGen + anthropic, full lifecycle), the real SDK client, and `fetch`
 * stubbed at the HTTP boundary with server-sent events the SDK streams. No
 * real network: every test stubs `fetch`, and the env is pinned to fixture
 * providers so a key in the shell is never read.
 */
/* eslint-disable unicorn/no-null -- the Messages API stream events carry `null` fields */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvProvider } from "@moku-labs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { coreConfig, createCore, createPlugin } from "../../../../config";
import { promptGenPlugin } from "../../../promptGen";
import type { PromptGenHandler, PromptGenRequest } from "../../../promptGen/contract";
import { runToolLoop } from "../../../promptGen/loop/run";
import type { RunToolLoopOptions } from "../../../promptGen/loop/types";
import { registryPlugin } from "../../../registry";
import { anthropicPlugin } from "../../index";

/** One block of a scripted answer. */
type ScriptedBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/** One scripted answer: its blocks, stop reason and usage. */
type ScriptedAnswer = {
  blocks: ScriptedBlock[];
  stopReason: string;
  usage: { input: number; output: number; cacheWrite?: number; cacheRead?: number };
};

/** One request the fake API received: the URL, the credential header (`x-api-key` or `authorization`), the body, and Bun's idle `timeout` fetch option. */
type SentRequest = {
  url: string;
  credential: string;
  body: Record<string, unknown>;
  idleTimeout: unknown;
};

/**
 * The stream events of one content block.
 *
 * @param block - The block.
 * @param index - Its index in the message.
 * @returns start, delta(s), stop.
 */
function blockEvents(block: ScriptedBlock, index: number): object[] {
  const stop = { type: "content_block_stop", index };
  if (block.type === "text") {
    return [
      {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "", citations: null }
      },
      { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
      stop
    ];
  }
  if (block.type === "thinking") {
    return [
      {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" }
      },
      {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: block.thinking }
      },
      {
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: block.signature }
      },
      stop
    ];
  }
  const start = { type: "tool_use", id: block.id, name: block.name, input: {} };
  const json = JSON.stringify(block.input);
  return [
    { type: "content_block_start", index, content_block: start },
    { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json } },
    stop
  ];
}

/**
 * A streamed Messages answer as the API sends it.
 *
 * @param answer - The scripted answer.
 * @returns A `text/event-stream` response.
 */
function streamResponse(answer: ScriptedAnswer): Response {
  const usage = {
    input_tokens: answer.usage.input,
    output_tokens: 1,
    cache_creation_input_tokens: answer.usage.cacheWrite ?? 0,
    cache_read_input_tokens: answer.usage.cacheRead ?? 0,
    cache_creation: null
  };
  const message = {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage
  };
  const events = [
    { type: "message_start", message },
    ...answer.blocks.flatMap((block, index) => blockEvents(block, index)),
    {
      type: "message_delta",
      delta: { stop_reason: answer.stopReason, stop_sequence: null },
      usage: { output_tokens: answer.usage.output }
    },
    { type: "message_stop" }
  ];
  const text = events
    .map(event => `event: ${Reflect.get(event, "type")}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * Stubs `fetch` with a fake Messages API: records each request and answers
 * the scripted answers in order.
 *
 * @param answers - The scripted answers.
 * @returns The recorded requests.
 */
function stubMessagesApi(answers: ScriptedAnswer[]): SentRequest[] {
  const sent: SentRequest[] = [];
  const fakeFetch = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.includes("/v1/messages")) throw new Error(`unexpected request to ${url}`);

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const headers = new Headers(init?.headers);
    const credential = headers.get("x-api-key") ?? headers.get("authorization") ?? "";
    sent.push({ url, credential, body, idleTimeout: Reflect.get(init ?? {}, "timeout") });
    const answer = answers[sent.length - 1];
    if (answer === undefined) throw new Error("no scripted answer left");
    return streamResponse(answer);
  };
  vi.stubGlobal("fetch", fakeFetch);
  return sent;
}

/** Env with the key: the only provider, so the shell's env is never read. */
const keyProvider: EnvProvider = {
  name: "anthropic-integration-key",
  load: () => ({ ANTHROPIC_API_KEY: "sk-ant-test" })
};

/** Env without the key. */
const emptyProvider: EnvProvider = { name: "anthropic-integration-empty", load: () => ({}) };

/** A second prompt-gen provider, for the fallback scenario. */
const backupHandler: PromptGenHandler = {
  estimate: () => ({ usd: 0 }),
  execute: async () => ({
    text: "backup answer",
    costUsd: 0,
    toolCalls: [],
    finishReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, cacheWriteTokens: 0 }
  })
};

/** Registers {@link backupHandler} as the "backup" prompt-gen provider. */
const backupPlugin = createPlugin("anthropicBackup", {
  depends: [registryPlugin],
  onInit: ctx => {
    ctx.require(registryPlugin).register("prompt-gen", "backup", backupHandler);
  }
});

/**
 * A fresh app: registry, promptGen, anthropic (and the backup provider when
 * asked), the journal in a temp dir, the env pinned to one fixture provider.
 *
 * @param dbPath - Journal path.
 * @param options - Whether the key is set, whether to add the backup provider.
 * @param options.withKey - Whether ANTHROPIC_API_KEY is set.
 * @param options.withBackup - Whether "backup" is registered and is promptGen's fallback.
 * @returns The app.
 */
function createTestApp(dbPath: string, options: { withKey: boolean; withBackup?: boolean }) {
  const plugins = options.withBackup
    ? [registryPlugin, promptGenPlugin, anthropicPlugin, backupPlugin]
    : [registryPlugin, promptGenPlugin, anthropicPlugin];
  const framework = createCore(coreConfig, {
    plugins,
    pluginConfigs: {
      journal: { path: dbPath },
      env: { providers: [options.withKey ? keyProvider : emptyProvider] },
      promptGen: {
        defaultProvider: "anthropic",
        fallback: options.withBackup ? ["backup"] : []
      }
    }
  });
  return framework.createApp();
}

/**
 * A journal double: runs each step's work once and keeps its value.
 *
 * @returns The `step` function of {@link runToolLoop}.
 */
function createJournal(): RunToolLoopOptions["step"] {
  const stored = new Map<string, unknown>();
  return async function step<T>(
    key: string,
    work: (signal: AbortSignal) => Promise<{ value: T; costUsd: number }>
  ): Promise<T> {
    if (stored.has(key)) return stored.get(key) as T;
    const done = await work(new AbortController().signal);
    stored.set(key, done.value);
    return done.value;
  };
}

describe("anthropic integration", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "moku-anthropic-integration-"));
    dbPath = path.join(tempDir, "journal.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("registers prompt-gen and reports info", async () => {
    stubMessagesApi([]);
    const app = createTestApp(dbPath, { withKey: true });
    await app.start();

    expect(app.promptGen.providers()).toEqual(["anthropic"]);
    expect(app.anthropic.info()).toEqual({
      provider: "anthropic",
      configured: true,
      model: "claude-opus-5-5"
    });

    await app.stop();
  });

  it("sends a prompt with a schema, an image and reasoning as one streamed Messages request", async () => {
    const sheetPath = path.join(tempDir, "sheet.png");
    writeFileSync(sheetPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const sent = stubMessagesApi([
      {
        blocks: [{ type: "text", text: '{"score":7}' }],
        stopReason: "end_turn",
        usage: { input: 100, output: 20 }
      }
    ]);
    const app = createTestApp(dbPath, { withKey: true });
    await app.start();
    const schema = {
      type: "object",
      properties: { score: { type: "number" } },
      required: ["score"]
    };

    const result = await app.promptGen.generate(
      {
        prompt: "Judge these frames.",
        system: "Bible.",
        cacheSystem: true,
        params: {
          reasoning: "high",
          max_tokens: 128_000,
          responseSchema: schema,
          images: [{ path: sheetPath, mimeType: "image/png", hash: "h1" }]
        }
      },
      { provider: "anthropic" }
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.credential).toContain("sk-ant-test");
    // Bun's socket idle timer is off: a long thinking pass is never cut at ~5 min.
    expect(sent[0]?.idleTimeout).toBe(false);
    expect(sent[0]?.body).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 128_000,
      system: [{ type: "text", text: "Bible.", cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "iVBORw==" }
            },
            { type: "text", text: "Judge these frames." }
          ]
        }
      ],
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: { ...schema, additionalProperties: false } }
      },
      stream: true
    });
    expect(result.text).toBe('{"score":7}');
    expect(result.costUsd).toBe(0.0008);
    expect(result.meta).toMatchObject({ provider: "anthropic", stopReason: "end_turn" });

    await app.stop();
  });

  it("replays the thinking blocks of a tool turn unchanged in a two-step runToolLoop", async () => {
    const sent = stubMessagesApi([
      {
        blocks: [
          { type: "thinking", thinking: "Read frame 3 first.", signature: "sig-abc" },
          { type: "tool_use", id: "toolu_01", name: "read_frame", input: { shot: 3 } }
        ],
        stopReason: "tool_use",
        usage: { input: 300, output: 40 }
      },
      {
        blocks: [{ type: "text", text: "Framing is fine." }],
        stopReason: "end_turn",
        usage: { input: 400, output: 10 }
      }
    ]);
    const app = createTestApp(dbPath, { withKey: true });
    await app.start();
    const step = createJournal();

    const result = await runToolLoop({
      generate: (request: PromptGenRequest, signal: AbortSignal) =>
        app.promptGen.generate(request, { signal, provider: "anthropic" }),
      model: "claude-opus-5-5",
      system: "You review frames.",
      messages: [{ role: "user", content: "Check shot 3." }],
      tools: [
        {
          name: "read_frame",
          description: "Return one frame of a shot.",
          schema: z.object({ shot: z.number() }),
          run: async ({ shot }) => ({
            value: `Frame of shot ${shot}.`,
            content: [{ type: "text", text: `Frame of shot ${shot}: cut at the chin.` }],
            costUsd: 0
          })
        }
      ],
      budget: { usd: 5, finishAt: 0.9 },
      maxSteps: 4,
      step,
      signal: new AbortController().signal
    });

    expect(result).toMatchObject({ stoppedBy: "done", steps: 2, finalText: "Framing is fine." });
    const replayed = (sent[1]?.body.messages as unknown[] | undefined)?.[1];
    expect(replayed).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Read frame 3 first.", signature: "sig-abc" },
        { type: "tool_use", id: "toolu_01", name: "read_frame", input: { shot: 3 } }
      ]
    });

    await app.stop();
  });

  it("falls back to the next provider without the key, with no request sent", async () => {
    const sent = stubMessagesApi([]);
    const app = createTestApp(dbPath, { withKey: false, withBackup: true });
    await app.start();

    const result = await app.promptGen.generate({ prompt: "Judge these frames." });

    expect(result.text).toBe("backup answer");
    expect(result.meta).toMatchObject({ provider: "backup" });
    expect(sent).toHaveLength(0);
    expect(app.anthropic.info().configured).toBe(false);

    await app.stop();
  });
});
