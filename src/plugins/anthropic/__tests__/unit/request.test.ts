/**
 * @file anthropic prompt-gen request mapping — one test per row of the
 * spec's mapping table, through `handler.execute` with a fake client that
 * records the sent body. Refused requests make no client call.
 */
/* eslint-disable unicorn/no-null -- ChatMessage.content is `string | null` in the contract */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, PromptGenRequest } from "../../../promptGen/contract";
import { TerminalProviderError } from "../../errors";
import { createPromptGenHandler } from "../../prompt-gen/handler";
import type { AnthropicContentBlock, AnthropicRequestBody } from "../../types";
import type { FakeContextOverrides } from "./fixtures";
import {
  createFakeAnthropicClient,
  createFakeAnthropicContext,
  createImageDir,
  IMAGE_BASE64
} from "./fixtures";

/**
 * Executes `request` and returns the body the client received.
 *
 * @param request - The prompt-gen request.
 * @param overrides - Context overrides.
 * @returns The sent body.
 */
async function sentBody(
  request: PromptGenRequest,
  overrides: FakeContextOverrides = {}
): Promise<AnthropicRequestBody> {
  const { client, calls } = createFakeAnthropicClient();
  const ctx = createFakeAnthropicContext({ ...overrides, state: { client, ...overrides.state } });
  await createPromptGenHandler(ctx).execute(request, {});
  const call = calls[0];
  if (call === undefined) throw new Error("no request was sent");
  return call.params;
}

/**
 * Executes `request`, expects a refusal before any client call, returns the error.
 *
 * @param request - The prompt-gen request.
 * @param overrides - Context overrides.
 * @returns The thrown error.
 */
async function refusal(
  request: PromptGenRequest,
  overrides: FakeContextOverrides = {}
): Promise<unknown> {
  const { client, calls } = createFakeAnthropicClient();
  const ctx = createFakeAnthropicContext({ ...overrides, state: { client } });
  const error = await createPromptGenHandler(ctx)
    .execute(request, {})
    .catch((error_: unknown) => error_);
  expect(calls).toHaveLength(0);
  return error;
}

/**
 * Asserts a terminal 400 whose message names `fragment`.
 *
 * @param error - The thrown error.
 * @param fragment - Text the message must contain.
 */
function expectBadRequest(error: unknown, fragment: string): void {
  expect(error).toBeInstanceOf(TerminalProviderError);
  expect(error).toMatchObject({ status: 400 });
  expect((error as Error).message).toContain(fragment);
}

const USER: ChatMessage = { role: "user", content: "Check the framing of shot 3." };

describe("anthropic prompt-gen request: system and prompt", () => {
  it("sends the system text as a plain string without cacheSystem", async () => {
    const body = await sentBody({ prompt: "Judge.", system: "You review frames." });

    expect(body.system).toBe("You review frames.");
  });

  it("sends the system text as one cached text block with cacheSystem", async () => {
    const body = await sentBody({
      prompt: "Judge.",
      system: "You review frames.",
      cacheSystem: true
    });

    expect(body.system).toEqual([
      { type: "text", text: "You review frames.", cache_control: { type: "ephemeral" } }
    ]);
  });

  it("sends no system field without system text", async () => {
    const body = await sentBody({ prompt: "Judge.", cacheSystem: true });

    expect(Object.hasOwn(body, "system")).toBe(false);
  });

  it("sends a prompt without messages as one user message", async () => {
    const body = await sentBody({ prompt: "Judge these frames." });

    expect(body.messages).toEqual([{ role: "user", content: "Judge these frames." }]);
  });
});

describe("anthropic prompt-gen request: images", () => {
  let images: ReturnType<typeof createImageDir>;

  beforeEach(() => {
    images = createImageDir();
  });

  afterEach(() => {
    images.cleanup();
  });

  it("puts params.images first as base64 image blocks, then the prompt text", async () => {
    const sheet = { path: images.file("sheet.png"), mimeType: "image/png", hash: "h1" };
    const frame = { path: images.file("frame.jpg"), mimeType: "image/jpeg", hash: "h2" };

    const body = await sentBody({
      prompt: "Judge these frames.",
      params: { images: [sheet, frame] }
    });

    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: IMAGE_BASE64 }
          },
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: IMAGE_BASE64 }
          },
          { type: "text", text: "Judge these frames." }
        ]
      }
    ]);
  });

  it("accepts one image object as params.images", async () => {
    const sheet = { path: images.file("sheet.webp"), mimeType: "image/webp", hash: "h1" };

    const body = await sentBody({ prompt: "Judge.", params: { images: sheet } });

    expect(body.messages[0]?.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/webp", data: IMAGE_BASE64 } },
      { type: "text", text: "Judge." }
    ]);
  });

  it("maps user parts: a cached text part gets cache_control, an image part a base64 block", async () => {
    const frame = images.file("frame.gif");
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Bible.", cache: true },
          { type: "image", path: frame, mimeType: "image/gif", hash: "h3" },
          { type: "text", text: "Check it." }
        ]
      }
    ];

    const body = await sentBody({ prompt: "", messages });

    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Bible.", cache_control: { type: "ephemeral" } },
          {
            type: "image",
            source: { type: "base64", media_type: "image/gif", data: IMAGE_BASE64 }
          },
          { type: "text", text: "Check it." }
        ]
      }
    ]);
  });

  it("refuses params.images together with messages", async () => {
    const sheet = { path: images.file("sheet.png"), mimeType: "image/png", hash: "h1" };

    const error = await refusal({ prompt: "", messages: [USER], params: { images: [sheet] } });

    expectBadRequest(error, "params.images with messages");
  });

  it("refuses a params.images entry with an image type the API cannot read", async () => {
    const sheet = { path: images.file("sheet.bmp"), mimeType: "image/bmp", hash: "h1" };

    const error = await refusal({ prompt: "Judge.", params: { images: [sheet] } });

    expectBadRequest(error, "image/bmp");
  });

  it("refuses an image part with an image type the API cannot read", async () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", path: images.file("a.svg"), mimeType: "image/svg+xml", hash: "h" }
        ]
      }
    ];

    const error = await refusal({ prompt: "", messages });

    expectBadRequest(error, "image/svg+xml");
  });

  it("refuses a params.images entry that is not a local file", async () => {
    const error = await refusal({
      prompt: "Judge.",
      params: { images: [{ url: "https://x/a.png" }] }
    });

    expectBadRequest(error, "params.images must be local files");
  });
});

describe("anthropic prompt-gen request: cache marks", () => {
  it("keeps cache_control on the first 4 marks in request order, the rest go without", async () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "one", cache: true },
          { type: "text", text: "two", cache: true },
          { type: "text", text: "three", cache: true }
        ]
      },
      {
        role: "tool",
        toolCallId: "toolu_01",
        content: [{ type: "text", text: "four", cache: true }]
      }
    ];

    const body = await sentBody({ prompt: "", system: "sys", cacheSystem: true, messages });

    const mark = { type: "ephemeral" };
    expect(body.system).toEqual([{ type: "text", text: "sys", cache_control: mark }]);
    expect(body.messages[0]?.content).toEqual([
      { type: "text", text: "one", cache_control: mark },
      { type: "text", text: "two", cache_control: mark },
      { type: "text", text: "three", cache_control: mark }
    ]);
    expect(body.messages[1]?.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "text", text: "four" }] }
    ]);
  });

  it('sends ttl "1h" on the system mark and on a marked text part with cacheTtl "1h"', async () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Bible.", cache: true },
          { type: "text", text: "Check it." }
        ]
      }
    ];

    const body = await sentBody({
      prompt: "",
      system: "sys",
      cacheSystem: true,
      cacheTtl: "1h",
      messages
    });

    const mark = { type: "ephemeral", ttl: "1h" };
    expect(body.system).toStrictEqual([{ type: "text", text: "sys", cache_control: mark }]);
    expect(body.messages[0]?.content).toStrictEqual([
      { type: "text", text: "Bible.", cache_control: mark },
      { type: "text", text: "Check it." }
    ]);
  });

  it('keeps the 4-mark cap with cacheTtl "1h": the 5th mark goes without cache_control', async () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "one", cache: true },
          { type: "text", text: "two", cache: true },
          { type: "text", text: "three", cache: true }
        ]
      },
      {
        role: "tool",
        toolCallId: "toolu_01",
        content: [{ type: "text", text: "four", cache: true }]
      }
    ];

    const body = await sentBody({
      prompt: "",
      system: "sys",
      cacheSystem: true,
      cacheTtl: "1h",
      messages
    });

    const mark = { type: "ephemeral", ttl: "1h" };
    expect(body.system).toStrictEqual([{ type: "text", text: "sys", cache_control: mark }]);
    expect(body.messages[0]?.content).toStrictEqual([
      { type: "text", text: "one", cache_control: mark },
      { type: "text", text: "two", cache_control: mark },
      { type: "text", text: "three", cache_control: mark }
    ]);
    expect(body.messages[1]?.content).toStrictEqual([
      { type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "text", text: "four" }] }
    ]);
  });

  it.each([
    [undefined],
    ["5m"]
  ] as const)("sends cache_control with no ttl key for cacheTtl %s", async cacheTtl => {
    const request: PromptGenRequest = {
      prompt: "",
      system: "sys",
      cacheSystem: true,
      messages: [{ role: "user", content: [{ type: "text", text: "Bible.", cache: true }] }]
    };

    const body = await sentBody(cacheTtl === undefined ? request : { ...request, cacheTtl });

    // toStrictEqual: a `ttl: undefined` key would fail here, toEqual would pass it.
    const mark = { type: "ephemeral" };
    expect(body.system).toStrictEqual([{ type: "text", text: "sys", cache_control: mark }]);
    expect(body.messages[0]?.content).toStrictEqual([
      { type: "text", text: "Bible.", cache_control: mark }
    ]);
  });

  it('refuses a cacheTtl other than "5m" or "1h"', async () => {
    const request = { prompt: "Judge.", cacheTtl: "2h" } as unknown as PromptGenRequest;

    const error = await refusal(request);

    expectBadRequest(error, "cacheTtl");
  });
});

describe("anthropic prompt-gen request: assistant and tool turns", () => {
  it("rebuilds an assistant turn not in memory as its text, then tool_use blocks", async () => {
    const assistant: ChatMessage = {
      role: "assistant",
      content: "Reading the frame.",
      toolCalls: [{ id: "toolu_01", name: "read_frame", input: { shot: 3 } }]
    };

    const body = await sentBody({ prompt: "", messages: [USER, assistant] });

    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Reading the frame." },
        { type: "tool_use", id: "toolu_01", name: "read_frame", input: { shot: 3 } }
      ]
    });
  });

  it("rebuilds an assistant turn with null content as tool_use blocks only", async () => {
    const assistant: ChatMessage = {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "toolu_01", name: "read_frame", input: { shot: 3 } }]
    };

    const body = await sentBody({ prompt: "", messages: [USER, assistant] });

    expect(body.messages[1]?.content).toEqual([
      { type: "tool_use", id: "toolu_01", name: "read_frame", input: { shot: 3 } }
    ]);
  });

  it("sends a text-only assistant turn as one text block", async () => {
    const assistant: ChatMessage = { role: "assistant", content: "Framing is fine." };

    const body = await sentBody({ prompt: "", messages: [USER, assistant, USER] });

    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Framing is fine." }]
    });
  });

  it("sends the remembered blocks of an assistant turn, by its first tool call id, unchanged", async () => {
    const remembered: AnthropicContentBlock[] = [
      { type: "thinking", thinking: "Frame 3 first.", signature: "sig-1" },
      { type: "tool_use", id: "toolu_01", name: "read_frame", input: { shot: 3 } },
      { type: "tool_use", id: "toolu_02", name: "read_frame", input: { shot: 4 } }
    ];
    const assistant: ChatMessage = {
      role: "assistant",
      content: null,
      toolCalls: [
        { id: "toolu_01", name: "read_frame", input: { shot: 3 } },
        { id: "toolu_02", name: "read_frame", input: { shot: 4 } }
      ]
    };

    const body = await sentBody(
      { prompt: "", messages: [USER, assistant] },
      { state: { turns: new Map([["toolu_01", remembered]]) } }
    );

    expect(body.messages[1]).toEqual({ role: "assistant", content: remembered });
  });

  it("merges consecutive tool messages into one user message of tool_result blocks", async () => {
    const images = createImageDir();
    const frame = images.file("frame.png");
    const messages: ChatMessage[] = [
      USER,
      { role: "tool", toolCallId: "toolu_01", content: "Subject is cut at the chin." },
      {
        role: "tool",
        toolCallId: "toolu_02",
        content: [
          { type: "text", text: "Frame 4:" },
          { type: "image", path: frame, mimeType: "image/png", hash: "h" }
        ]
      },
      { role: "user", content: "Now decide." }
    ];

    const body = await sentBody({ prompt: "", messages });
    images.cleanup();

    expect(body.messages).toEqual([
      { role: "user", content: "Check the framing of shot 3." },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_01", content: "Subject is cut at the chin." },
          {
            type: "tool_result",
            tool_use_id: "toolu_02",
            content: [
              { type: "text", text: "Frame 4:" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: IMAGE_BASE64 }
              }
            ]
          }
        ]
      },
      { role: "user", content: "Now decide." }
    ]);
  });
});

describe("anthropic prompt-gen request: tools", () => {
  it("sends tools as name, description and input_schema", async () => {
    const inputSchema = {
      type: "object",
      properties: { shot: { type: "number" } },
      required: ["shot"]
    };

    const body = await sentBody({
      prompt: "",
      messages: [USER],
      tools: [{ name: "read_frame", description: "Return one frame.", inputSchema }]
    });

    expect(body.tools).toEqual([
      { name: "read_frame", description: "Return one frame.", input_schema: inputSchema }
    ]);
  });

  it("flattens a tool whose input schema is a top-level union into one object schema", async () => {
    // Anthropic answers 400 to oneOf / anyOf / allOf at the top of input_schema (live, 2026-10-27).
    const inputSchema = {
      oneOf: [
        { type: "object", properties: { op: { const: "write" } }, required: ["op"] },
        {
          type: "object",
          properties: { op: { const: "translate" }, to: { type: "string" } },
          required: ["op", "to"]
        }
      ]
    };

    const body = await sentBody({
      prompt: "",
      messages: [USER],
      tools: [{ name: "captions", description: "Captions.", inputSchema }]
    });

    expect(body.tools).toEqual([
      {
        name: "captions",
        description: "Captions.",
        input_schema: {
          type: "object",
          properties: {
            op: { anyOf: [{ const: "write" }, { const: "translate" }] },
            to: { type: "string" }
          },
          required: ["op"],
          description: 'One of: {op: "write"} | {op: "translate", to}'
        }
      }
    ]);
  });

  it("sends no tools field for an empty tool list", async () => {
    const body = await sentBody({ prompt: "", messages: [USER], tools: [] });

    expect(Object.hasOwn(body, "tools")).toBe(false);
  });

  it.each([
    ["auto", { type: "auto" }],
    ["none", { type: "none" }],
    ["required", { type: "any" }],
    [{ name: "read_frame" }, { type: "tool", name: "read_frame" }]
  ] as const)("maps toolChoice %o to tool_choice %o", async (toolChoice, expected) => {
    const body = await sentBody({ prompt: "", messages: [USER], toolChoice });

    expect(body.tool_choice).toEqual(expected);
  });

  it("sends no tool_choice when toolChoice is unset", async () => {
    const body = await sentBody({ prompt: "", messages: [USER] });

    expect(Object.hasOwn(body, "tool_choice")).toBe(false);
  });
});

describe("anthropic prompt-gen request: params", () => {
  it.each([
    ["off", "low"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    [undefined, "medium"]
  ])("maps params.reasoning %s to output_config.effort %s, with no thinking field", async (reasoning, effort) => {
    const body = await sentBody({ prompt: "Judge.", params: { reasoning } });

    expect(body.output_config.effort).toBe(effort);
    expect(Object.hasOwn(body, "thinking")).toBe(false);
  });

  it("refuses any other params.reasoning", async () => {
    const error = await refusal({ prompt: "Judge.", params: { reasoning: "max" } });

    expectBadRequest(error, "params.reasoning");
  });

  it("sends params.responseSchema as output_config.format, normalized for structured output", async () => {
    const schema = {
      type: "object",
      properties: { score: { type: "number" } },
      required: ["score"]
    };

    const body = await sentBody({ prompt: "Judge.", params: { responseSchema: schema } });

    expect(body.output_config.format).toEqual({
      type: "json_schema",
      schema: {
        type: "object",
        properties: { score: { type: "number" } },
        additionalProperties: false,
        required: ["score"]
      }
    });
  });

  it("sends a schema the normalizer cannot read (no type) as given", async () => {
    const schema = { properties: { score: { type: "number" } } };

    const body = await sentBody({ prompt: "Judge.", params: { responseSchema: schema } });

    expect(body.output_config.format).toEqual({ type: "json_schema", schema });
  });

  it("sends no output_config.format without params.responseSchema", async () => {
    const body = await sentBody({ prompt: "Judge." });

    expect(body.output_config).toEqual({ effort: "medium" });
  });

  it.each([
    [["a"]],
    ["schema"],
    [null]
  ])("refuses params.responseSchema %o", async responseSchema => {
    const error = await refusal({ prompt: "Judge.", params: { responseSchema } });

    expectBadRequest(error, "params.responseSchema");
  });

  it("sends params.max_tokens when it is a positive integer", async () => {
    const body = await sentBody({ prompt: "Judge.", params: { max_tokens: 128_000 } });

    expect(body.max_tokens).toBe(128_000);
  });

  it.each([
    [1.5],
    [0],
    [-3],
    ["100"],
    [undefined]
  ])("falls back to config.maxTokens for params.max_tokens %o", async maxTokens => {
    const body = await sentBody(
      { prompt: "Judge.", params: { max_tokens: maxTokens } },
      { config: { maxTokens: 4096 } }
    );

    expect(body.max_tokens).toBe(4096);
  });

  it("never sends temperature", async () => {
    const body = await sentBody({ prompt: "Judge.", temperature: 0.7 });

    expect(Object.hasOwn(body, "temperature")).toBe(false);
  });
});

describe("anthropic prompt-gen request: input and model", () => {
  it("refuses empty messages", async () => {
    const error = await refusal({ prompt: "Judge.", messages: [] });

    expectBadRequest(error, "messages must not be empty");
  });

  it("refuses an empty prompt without messages", async () => {
    const error = await refusal({ prompt: "   " });

    expectBadRequest(error, "non-empty prompt");
  });

  it("ignores the prompt when messages are set", async () => {
    const body = await sentBody({ prompt: "", messages: [USER] });

    expect(body.messages).toEqual([{ role: "user", content: "Check the framing of shot 3." }]);
  });

  it.each([
    [undefined, "claude-opus-5-5"],
    ["default", "claude-opus-5-5"],
    ["anthropic/claude-opus-5.5", "claude-opus-5-5"],
    ["anthropic/claude-sonnet-5.5", "claude-sonnet-5-5"],
    ["anthropic/claude-sonnet-5", "claude-sonnet-5"],
    ["anthropic/claude-haiku-5.5", "claude-haiku-5-5"],
    ["anthropic/claude-fable-5.1", "claude-fable-5-1"],
    ["claude-sonnet-5-5", "claude-sonnet-5-5"]
  ])("sends model %s as %s", async (model, expected) => {
    const request: PromptGenRequest =
      model === undefined ? { prompt: "Judge." } : { prompt: "Judge.", model };

    const body = await sentBody(request);

    expect(body.model).toBe(expected);
  });

  it("resolves an alias in config.model too", async () => {
    const body = await sentBody(
      { prompt: "Judge." },
      { config: { model: "anthropic/claude-haiku-5.5" } }
    );

    expect(body.model).toBe("claude-haiku-5-5");
  });

  it("refuses a model with no price", async () => {
    const error = await refusal({ prompt: "Judge.", model: "claude-next-6" });

    expectBadRequest(error, "claude-next-6");
  });

  it("sends a model priced through config.priceOverrides as is", async () => {
    const price = {
      inputPerM: 1,
      outputPerM: 2,
      cacheReadPerM: 0.1,
      cacheWrite5mPerM: 1.25,
      cacheWrite1hPerM: 2
    };

    const body = await sentBody(
      { prompt: "Judge.", model: "claude-next-6" },
      { config: { priceOverrides: { "claude-next-6": price } } }
    );

    expect(body.model).toBe("claude-next-6");
  });
});
