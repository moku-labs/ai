import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PromptGenRequest } from "../../../promptGen/contract";
import { ToolArgumentsError } from "../../../promptGen/contract";
import { TerminalProviderError } from "../../errors";
import { CHAT_PATH, planChat } from "../../llm/chat";
import { createPromptGenHandler } from "../../llm/handler";
import type { LocalFile } from "../../types";
import type { TempFiles } from "./fixtures";
import {
  callsOf,
  createFakeEnv,
  createTempFiles,
  createTestCtx,
  jsonResponse,
  stubFetch,
  stubStorageFetch
} from "./fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// fal prompt-gen tool calling: messages, tools, cache markers, typed usage.
// ─────────────────────────────────────────────────────────────────────────────

const OPUS = "anthropic/claude-opus-5.5";
const CHAT_URL = `https://fal.run/${CHAT_PATH}`;
const READ_FRAME = {
  name: "read_frame",
  description: "Return one rendered frame of a shot as an image.",
  inputSchema: { type: "object", properties: { shot: { type: "number" } }, required: ["shot"] }
};

/** The recorded OpenRouter answer of a tool-call turn (opus-5.5 through fal). */
const RECORDED_TOOL_CALL = readFileSync(
  new URL("recorded/openrouter-tool-call.json", import.meta.url),
  "utf8"
);

let temp: TempFiles;
let still: LocalFile;
let frame: LocalFile;

beforeAll(() => {
  temp = createTempFiles();
  still = temp.file("still.png", new Uint8Array([9, 9]), "image/png", "d".repeat(64));
  frame = temp.file("frame.png", new Uint8Array([7, 7]), "image/png", "e".repeat(64));
});

afterAll(() => {
  temp.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A 200 chat answer built from the recorded JSON text. */
function recordedAnswer(): Response {
  return new Response(RECORDED_TOOL_CALL, {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

/** A 200 chat answer with one choice. */
function choiceAnswer(choice: Record<string, unknown>, usage?: Record<string, unknown>): Response {
  return jsonResponse(200, { id: "gen-2", provider: "Anthropic", choices: [choice], usage });
}

/** Captures what a promise rejects with. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

/** Captures what a function throws. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("request body with messages, tools and cache", () => {
  it("posts the turns, the tools, the named tool choice and the cache markers in order", async () => {
    const fetchMock = stubStorageFetch(recordedAnswer());
    const request: PromptGenRequest = {
      prompt: "",
      system: "You review storyboard frames.",
      cacheSystem: true,
      temperature: 0.2,
      params: { reasoning: "low", max_tokens: 4000 },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Shot list: 1 wide, 2 close, 3 medium.", cache: true },
            { type: "text", text: "Check the framing of shot 3 against the key still." },
            { type: "image", ...still }
          ]
        },
        {
          role: "assistant",
          // eslint-disable-next-line unicorn/no-null -- a tool-only assistant turn has null content by contract
          content: null,
          toolCalls: [{ id: "toolu_01", name: "read_frame", input: { shot: 3 } }]
        },
        {
          role: "tool",
          toolCallId: "toolu_01",
          content: [
            { type: "text", text: "Frame 12 of shot 3." },
            { type: "image", ...frame }
          ]
        }
      ],
      tools: [READ_FRAME],
      toolChoice: { name: "read_frame" }
    };

    await createPromptGenHandler(createTestCtx()).execute(request, {});

    const post = callsOf(fetchMock).find(call => call.url === CHAT_URL);
    const expected = {
      model: OPUS,
      messages: [
        {
          role: "system",
          content: [
            {
              type: "text",
              text: "You review storyboard frames.",
              cache_control: { type: "ephemeral" }
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Shot list: 1 wide, 2 close, 3 medium.",
              cache_control: { type: "ephemeral" }
            },
            { type: "text", text: "Check the framing of shot 3 against the key still." },
            {
              type: "image_url",
              image_url: { url: "https://cdn.fal.test/file/dddddddddddddddd.png" }
            }
          ]
        },
        {
          role: "assistant",
          // eslint-disable-next-line unicorn/no-null -- the wire carries JSON null content
          content: null,
          tool_calls: [
            {
              id: "toolu_01",
              type: "function",
              function: { name: "read_frame", arguments: '{"shot":3}' }
            }
          ]
        },
        {
          role: "tool",
          tool_call_id: "toolu_01",
          content: [
            { type: "text", text: "Frame 12 of shot 3." },
            {
              type: "image_url",
              image_url: { url: "https://cdn.fal.test/file/eeeeeeeeeeeeeeee.png" }
            }
          ]
        }
      ],
      max_tokens: 4000,
      temperature: 0.2,
      reasoning: { effort: "low" },
      tools: [
        {
          type: "function",
          function: {
            name: "read_frame",
            description: "Return one rendered frame of a shot as an image.",
            parameters: READ_FRAME.inputSchema
          }
        }
      ],
      tool_choice: { type: "function", function: { name: "read_frame" } }
    };
    expect(String(post?.body)).toBe(JSON.stringify(expected));
  });

  it("orders the body fields: model, messages, max_tokens, temperature, reasoning, response_format, tools, tool_choice", () => {
    const plan = planChat(createTestCtx(), {
      prompt: "",
      temperature: 1,
      params: { responseSchema: { type: "object" } },
      messages: [{ role: "user", content: "hi" }],
      tools: [READ_FRAME],
      toolChoice: "required"
    });
    expect(Object.keys(plan.body)).toEqual([
      "model",
      "messages",
      "max_tokens",
      "temperature",
      "reasoning",
      "response_format",
      "tools",
      "tool_choice"
    ]);
  });

  it("caches the system text and appends tools on the one-turn prompt path", () => {
    const plan = planChat(createTestCtx(), {
      prompt: "p",
      system: "s",
      cacheSystem: true,
      tools: [READ_FRAME],
      toolChoice: "auto"
    });
    expect(plan.body.messages).toEqual([
      {
        role: "system",
        content: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }]
      },
      { role: "user", content: "p" }
    ]);
    expect(plan.body.tool_choice).toBe("auto");
    expect(plan.body.tools).toHaveLength(1);
  });

  it("collects every image part into plan.images, in message order", () => {
    const plan = planChat(createTestCtx(), {
      prompt: "",
      messages: [
        { role: "user", content: [{ type: "image", ...frame }] },
        { role: "tool", toolCallId: "c", content: [{ type: "image", ...still }] }
      ]
    });
    expect(plan.images).toEqual([frame, still]);
  });
});

describe("messages path refusals", () => {
  it.each([
    [
      "empty messages",
      { prompt: "p", messages: [] },
      "[ai] fal prompt-gen messages must not be empty.\n  Pass at least one user message."
    ],
    [
      "params.images with messages",
      { prompt: "", params: { images: [] }, messages: [{ role: "user", content: "hi" }] },
      "Put images in message content parts."
    ],
    [
      "an image part that is not a local file",
      {
        prompt: "",
        messages: [{ role: "user", content: [{ type: "image", path: "x" }] }]
      },
      "params.images must be local files"
    ]
  ])("refuses %s as a terminal 400", (_label, request, message) => {
    const error = thrownBy(() => planChat(createTestCtx(), request as PromptGenRequest));
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({ status: 400, message: expect.stringContaining(message) });
  });

  it("refuses before any call and accepts an empty prompt with messages", async () => {
    const fetchMock = stubFetch(
      choiceAnswer({ message: { content: "ok" }, finish_reason: "stop" })
    );
    const handler = createPromptGenHandler(createTestCtx());

    await expect(handler.execute({ prompt: "", messages: [] }, {})).rejects.toThrow(
      TerminalProviderError
    );
    expect(fetchMock).not.toHaveBeenCalled();

    const result = await handler.execute(
      { prompt: "", messages: [{ role: "user", content: "hi" }] },
      {}
    );
    expect(result.text).toBe("ok");
  });
});

describe("answer with tool calls", () => {
  it("reads the recorded tool-call answer: no text, the call, tool_calls, typed usage", async () => {
    stubFetch(recordedAnswer());

    const result = await createPromptGenHandler(createTestCtx()).execute(
      {
        prompt: "",
        messages: [{ role: "user", content: "Check the framing of shot 3." }],
        tools: [READ_FRAME]
      },
      {}
    );

    expect(result).toEqual({
      text: "",
      costUsd: 0.010_884,
      toolCalls: [{ id: "toolu_01HxQ7bVf3mZ2kR9tLwN4cYp", name: "read_frame", input: { shot: 3 } }],
      finishReason: "tool_calls",
      usage: {
        promptTokens: 2431,
        completionTokens: 58,
        cachedTokens: 1820,
        cacheWriteTokens: 412
      },
      meta: {
        modelId: OPUS,
        reasoning: "medium",
        provider: "Anthropic",
        finishReason: "tool_calls",
        promptTokens: 2431,
        completionTokens: 58,
        costSource: "usage",
        partial: false
      }
    });
  });

  it("accepts null content with tool calls whatever the finish reason", async () => {
    stubFetch(
      choiceAnswer({
        message: {
          // eslint-disable-next-line unicorn/no-null -- the router sends JSON null content on a tool turn
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read_frame", arguments: "" } }
          ]
        },
        finish_reason: "stop"
      })
    );
    const result = await createPromptGenHandler(createTestCtx()).execute({ prompt: "p" }, {});
    expect(result).toMatchObject({
      text: "",
      toolCalls: [{ id: "call_1", name: "read_frame", input: {} }],
      finishReason: "stop"
    });
  });

  it("accepts missing content when the finish reason is tool_calls", async () => {
    stubFetch(choiceAnswer({ message: { role: "assistant" }, finish_reason: "tool_calls" }));
    const result = await createPromptGenHandler(createTestCtx()).execute({ prompt: "p" }, {});
    expect(result).toMatchObject({ text: "", toolCalls: [], finishReason: "tool_calls" });
  });

  it("still rejects null content without tool calls on a stop", async () => {
    // eslint-disable-next-line unicorn/no-null -- JSON null content with nothing else is incomplete
    stubFetch(choiceAnswer({ message: { content: null }, finish_reason: "stop" }));
    await expect(
      createPromptGenHandler(createTestCtx()).execute({ prompt: "p" }, {})
    ).rejects.toThrow("[ai] fal returned an incomplete LLM result.");
  });

  it("throws ToolArgumentsError for arguments that are not JSON, without a retry", async () => {
    const fetchMock = stubFetch(
      choiceAnswer({
        message: {
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_frame", arguments: "{shot: 3" }
            }
          ]
        },
        finish_reason: "tool_calls"
      })
    );
    const error = await rejectionOf(
      createPromptGenHandler(createTestCtx()).execute({ prompt: "p" }, {})
    );
    expect(error).toBeInstanceOf(ToolArgumentsError);
    expect(error).toMatchObject({ toolName: "read_frame", raw: "{shot: 3" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["content_filter", { message: { content: "x" }, finish_reason: "content_filter" }],
    ["a missing reason", { message: { content: "x" } }]
  ])("reads %s as finishReason other", async (_label, choice) => {
    stubFetch(choiceAnswer(choice));
    const result = await createPromptGenHandler(createTestCtx()).execute({ prompt: "p" }, {});
    expect(result.finishReason).toBe("other");
  });

  it("takes cache writes from prompt_tokens_details and reads unreported counts as 0", async () => {
    stubFetch(
      choiceAnswer(
        { message: { content: "x" }, finish_reason: "stop" },
        {
          prompt_tokens: 100,
          completion_tokens: 3,
          prompt_tokens_details: { cache_write_tokens: 90 }
        }
      )
    );
    const result = await createPromptGenHandler(createTestCtx()).execute({ prompt: "p" }, {});
    expect(result.usage).toEqual({
      promptTokens: 100,
      completionTokens: 3,
      cachedTokens: 0,
      cacheWriteTokens: 90
    });
  });

  it("prices a messages answer without usage by the text of all parts", async () => {
    stubFetch(choiceAnswer({ message: { content: "abcdefgh" }, finish_reason: "stop" }));
    const result = await createPromptGenHandler(createTestCtx()).execute(
      {
        prompt: "ignored prompt text",
        messages: [{ role: "user", content: [{ type: "text", text: "abcd" }] }]
      },
      {}
    );
    // 1 token in (abcd) × 4, 2 tokens out × 20, per M.
    expect(result).toMatchObject({ costUsd: 0.000_044, meta: { costSource: "chars" } });
    expect(result.usage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0
    });
  });
});

describe("estimate with messages", () => {
  it("prices every text, assistant text and argument JSON plus 1000 tokens per image, max_tokens out", () => {
    const fetchMock = stubFetch();
    const handler = createPromptGenHandler(createTestCtx({ env: createFakeEnv({}) }));
    const request: PromptGenRequest = {
      prompt: "",
      system: "abcd",
      params: { max_tokens: 1000 },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "abcdefgh" },
            { type: "image", path: "/nowhere/a.png", mimeType: "image/png", hash: "h" }
          ]
        },
        { role: "assistant", content: "ab", toolCalls: [{ id: "c", name: "t", input: { a: 1 } }] },
        { role: "tool", toolCallId: "c", content: "abcd" }
      ]
    };

    // "abcd\nabcdefgh\nab\n{"a":1}\nabcd" = 29 ASCII → 8 tokens, + 1000 for the image.
    // 1008 × 4 / M + 1000 × 20 / M.
    expect(handler.estimate(request)).toEqual({ usd: 0.024_032 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("request log with messages", () => {
  it("logs the last user or tool message as the prompt and names the uploaded images", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "moku-fal-llm-tools-log-"));
    const file = path.join(dir, "fal.jsonl");
    stubStorageFetch(recordedAnswer());
    const ctx = createTestCtx({ config: { requestLog: file } });

    await createPromptGenHandler(ctx).execute(
      {
        prompt: "",
        messages: [
          { role: "user", content: "Check shot 3." },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "toolu_01", name: "read_frame", input: { shot: 3 } }]
          },
          {
            role: "tool",
            toolCallId: "toolu_01",
            content: [
              { type: "text", text: "Frame 12 of shot 3." },
              { type: "image", ...frame }
            ]
          }
        ],
        tools: [READ_FRAME]
      },
      {}
    );

    const [line] = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map(text => JSON.parse(text) as Record<string, unknown>);
    rmSync(dir, { recursive: true, force: true });
    expect(line).toMatchObject({
      task: "prompt-gen",
      requestId: "gen-1791000000-Kp4LmT9wRXq7vB2n",
      prompt: "Frame 12 of shot 3.",
      body: { model: OPUS, image_urls: ["frame.png"] }
    });
    expect(line?.body).not.toHaveProperty("messages");
  });
});
