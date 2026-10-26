/**
 * @file anthropic prompt-gen handler — the offline estimate, execute end to
 * end over a fake client (result, cost, meta, logs), the missing key, the
 * turn memory across two requests, abort and redaction.
 */
/* eslint-disable unicorn/no-null -- ChatMessage.content is `string | null` in the contract */
import { APIUserAbortError } from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { ChatMessage, PromptGenRequest, ToolDefinition } from "../../../promptGen/contract";
import { isPromptGenUnavailable, PromptGenUnavailableError } from "../../../promptGen/contract";
import { FlaggedProviderError, TerminalProviderError } from "../../errors";
import { createPromptGenHandler } from "../../prompt-gen/handler";
import type { AnthropicContentBlock } from "../../types";
import {
  answerOf,
  createFakeAnthropicClient,
  createFakeAnthropicContext,
  textAnswer
} from "./fixtures";

const USER: ChatMessage = { role: "user", content: "Check the framing of shot 3." };
const TOOLS: ToolDefinition[] = [
  { name: "read_frame", description: "Return one frame.", inputSchema: { type: "object" } }
];
const IMAGE = { path: "frames/a.png", mimeType: "image/png", hash: "h" };

describe("anthropic prompt-gen: estimate", () => {
  it("prices chars/4 input and config.maxTokens output offline, with no key and no client", () => {
    const ctx = createFakeAnthropicContext();

    const { usd } = createPromptGenHandler(ctx).estimate({ prompt: "abcd", system: "abcdefgh" });

    // 3 tokens × 4 + 32 000 × 20, per million
    expect(usd).toBe(0.640_012);
    expect(ctx.state.client).toBeNull();
  });

  it("adds 1 600 tokens per params.images entry and prices output at params.max_tokens", () => {
    const ctx = createFakeAnthropicContext();

    const { usd } = createPromptGenHandler(ctx).estimate({
      prompt: "abcd",
      params: { images: [IMAGE, IMAGE], max_tokens: 1000 }
    });

    // (1 + 3 200) × 4 + 1 000 × 20, per million
    expect(usd).toBe(0.032_804);
  });

  it("counts every message text, tool-call JSON and image part of a conversation", () => {
    const ctx = createFakeAnthropicContext();
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "abcd" },
          { type: "image", ...IMAGE }
        ]
      },
      {
        role: "assistant",
        content: "abcd",
        toolCalls: [{ id: "c1", name: "t", input: { shot: 3 } }]
      },
      { role: "tool", toolCallId: "c1", content: "abcdefgh" }
    ];

    const { usd } = createPromptGenHandler(ctx).estimate({
      prompt: "",
      system: "sys!",
      messages,
      params: { max_tokens: 100 }
    });

    // 4 + 4 + 4 + 10 ('{"shot":3}') + 8 = 30 chars = 8 tokens, + 1 600 per image: 1 608 × 4 + 100 × 20
    expect(usd).toBe(0.008_432);
  });

  it("refuses a model with no price", () => {
    const ctx = createFakeAnthropicContext();

    expect(() =>
      createPromptGenHandler(ctx).estimate({ prompt: "p", model: "claude-next-6" })
    ).toThrow(TerminalProviderError);
  });
});

describe("anthropic prompt-gen: execute", () => {
  it("returns text, usage, cost from usage × price and a text-free meta", async () => {
    const message = answerOf([{ type: "text", text: "The framing is tight." }], "end_turn", {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 1800,
      cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 }
    });
    const { client } = createFakeAnthropicClient([message]);
    const ctx = createFakeAnthropicContext({ state: { client } });

    const result = await createPromptGenHandler(ctx).execute({ prompt: "Judge." }, {});

    // 100×4 + 200×5 + 100×8 + 1 800×0.2 + 20×20, per million
    expect(result).toEqual({
      text: "The framing is tight.",
      costUsd: 0.002_96,
      toolCalls: [],
      finishReason: "stop",
      usage: {
        promptTokens: 2200,
        completionTokens: 20,
        cachedTokens: 1800,
        cacheWriteTokens: 300,
        cachedReadTokens: 1800,
        cachedWriteTokens: 300
      },
      meta: {
        model: "claude-opus-5-5",
        effort: "medium",
        stopReason: "end_turn",
        promptTokens: 2200,
        completionTokens: 20
      }
    });
  });

  it("logs done with the model and token counts", async () => {
    const message = answerOf([{ type: "text", text: "ok" }], "end_turn", {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 50
    });
    const { client } = createFakeAnthropicClient([message]);
    const ctx = createFakeAnthropicContext({ state: { client } });

    await createPromptGenHandler(ctx).execute({ prompt: "Judge.", model: "claude-sonnet-5" }, {});

    expect(ctx.log.info).toHaveBeenCalledWith("anthropic:prompt-gen:done", {
      model: "claude-sonnet-5",
      promptTokens: 150,
      completionTokens: 20,
      cachedTokens: 50
    });
  });

  it("returns a length-cut answer as finishReason length and logs partial", async () => {
    const { client } = createFakeAnthropicClient([
      answerOf([{ type: "text", text: "The fram" }], "max_tokens")
    ]);
    const ctx = createFakeAnthropicContext({ state: { client } });

    const result = await createPromptGenHandler(ctx).execute({ prompt: "Judge." }, {});

    expect(result.finishReason).toBe("length");
    expect(ctx.log.warn).toHaveBeenCalledWith("anthropic:prompt-gen:partial", {
      model: "claude-opus-5-5"
    });
  });

  it("does not log partial for a complete answer", async () => {
    const { client } = createFakeAnthropicClient([textAnswer("Fine.")]);
    const ctx = createFakeAnthropicContext({ state: { client } });

    await createPromptGenHandler(ctx).execute({ prompt: "Judge." }, {});

    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it("throws a FlaggedProviderError for a refusal and logs the redacted failure", async () => {
    const { client } = createFakeAnthropicClient([answerOf([], "refusal")]);
    const ctx = createFakeAnthropicContext({ state: { client } });

    await expect(
      createPromptGenHandler(ctx).execute({ prompt: "Judge." }, {})
    ).rejects.toBeInstanceOf(FlaggedProviderError);
    expect(ctx.log.warn).toHaveBeenCalledWith("anthropic:prompt-gen:failed", {
      errorType: "flagged",
      kind: "content-policy"
    });
  });

  it("passes the caller's signal to the client", async () => {
    const { client, calls } = createFakeAnthropicClient();
    const ctx = createFakeAnthropicContext({ state: { client } });
    const controller = new AbortController();

    await createPromptGenHandler(ctx).execute({ prompt: "Judge." }, { signal: controller.signal });

    expect(calls[0]?.signal).toBe(controller.signal);
  });

  it("rethrows a caller abort unchanged", async () => {
    const abort = new APIUserAbortError();
    const { client } = createFakeAnthropicClient([abort]);
    const ctx = createFakeAnthropicContext({ state: { client } });

    await expect(createPromptGenHandler(ctx).execute({ prompt: "Judge." }, {})).rejects.toBe(abort);
  });
});

describe("anthropic prompt-gen: the API key", () => {
  it("throws PromptGenUnavailableError auth with no key, before any client exists", async () => {
    const ctx = createFakeAnthropicContext();

    const error = await createPromptGenHandler(ctx)
      .execute({ prompt: "Judge." }, {})
      .catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(PromptGenUnavailableError);
    expect(isPromptGenUnavailable(error)).toBe(true);
    expect(error).toMatchObject({
      reason: "auth",
      message:
        "[ai] ANTHROPIC_API_KEY is not set.\n  Export it, or use another prompt-gen provider."
    });
    expect(ctx.state.client).toBeNull();
    expect(ctx.log.warn).toHaveBeenCalledWith("anthropic:prompt-gen:failed", {
      errorType: "unavailable",
      kind: "auth"
    });
  });

  it("refuses a bad request before it asks for the key", async () => {
    const ctx = createFakeAnthropicContext();

    await expect(
      createPromptGenHandler(ctx).execute({ prompt: "Judge.", params: { reasoning: "max" } }, {})
    ).rejects.toBeInstanceOf(TerminalProviderError);
  });
});

describe("anthropic prompt-gen: turn memory", () => {
  it("sends the thinking blocks of a tool turn back unchanged on the next request", async () => {
    const toolTurn: AnthropicContentBlock[] = [
      { type: "thinking", thinking: "Frame 3 first.", signature: "sig-1" },
      { type: "redacted_thinking", data: "enc-1" },
      { type: "tool_use", id: "toolu_01", name: "read_frame", input: { shot: 3 } }
    ];
    const { client, calls } = createFakeAnthropicClient([
      answerOf(toolTurn, "tool_use"),
      textAnswer("Framing is fine.")
    ]);
    const ctx = createFakeAnthropicContext({ state: { client } });
    const handler = createPromptGenHandler(ctx);

    const first = await handler.execute({ prompt: "", messages: [USER], tools: TOOLS }, {});
    const next: PromptGenRequest = {
      prompt: "",
      tools: TOOLS,
      messages: [
        USER,
        { role: "assistant", content: null, toolCalls: first.toolCalls },
        { role: "tool", toolCallId: "toolu_01", content: "Cut at the chin." }
      ]
    };
    await handler.execute(next, {});

    expect(first.finishReason).toBe("tool_calls");
    expect(calls[1]?.params.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Frame 3 first.", signature: "sig-1" },
        { type: "redacted_thinking", data: "enc-1" },
        { type: "tool_use", id: "toolu_01", name: "read_frame", input: { shot: 3 } }
      ]
    });
  });

  it("remembers nothing for an answer without tool calls", async () => {
    const { client } = createFakeAnthropicClient([textAnswer("Done.")]);
    const ctx = createFakeAnthropicContext({ state: { client } });

    await createPromptGenHandler(ctx).execute({ prompt: "Judge." }, {});

    expect(ctx.state.turns.size).toBe(0);
  });
});

describe("anthropic prompt-gen: redaction", () => {
  it("keeps prompt, system and answer text out of logs and meta", async () => {
    const { client } = createFakeAnthropicClient([
      answerOf([{ type: "text", text: "SECRET-ANSWER" }], "max_tokens")
    ]);
    const ctx = createFakeAnthropicContext({ state: { client } });

    const result = await createPromptGenHandler(ctx).execute(
      { prompt: "SECRET-PROMPT", system: "SECRET-SYSTEM" },
      {}
    );

    const logged = JSON.stringify([ctx.log.info.mock.calls, ctx.log.warn.mock.calls, result.meta]);
    expect(logged).not.toMatch(/SECRET/);
  });
});
