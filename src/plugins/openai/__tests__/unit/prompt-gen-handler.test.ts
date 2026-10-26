import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RateLimitError } from "openai";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../../promptGen/contract";
import { isPromptGenUnavailable, PromptGenUnavailableError } from "../../../promptGen/contract";
import { RetryableProviderError, TerminalProviderError } from "../../errors";
import { createPromptGenHandler } from "../../prompt-gen/handler";
import type { OpenaiResponse } from "../../types";
import { createFakeOpenaiClient, createFakeOpenaiContext, textResponse } from "./fixtures";

/** `ChatMessage.content` of a tool-only assistant turn is null by contract. */
// eslint-disable-next-line unicorn/no-null -- see comment above
const NO_TEXT = null;

/** USD per token of a per-million price. */
const PER_TOKEN = 1 / 1_000_000;

/** A temp dir holding the image files the requests send. */
const imageDir = mkdtempSync(path.join(tmpdir(), "moku-openai-images-"));
afterAll(() => rmSync(imageDir, { recursive: true, force: true }));

/** A GPT-6 tool turn: a reasoning item, then one function call. */
const TOOL_TURN: OpenaiResponse = {
  status: "completed",
  output: [
    { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC_1" },
    {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "read_frame",
      arguments: '{"shot":3}'
    }
  ],
  usage: { input_tokens: 100, output_tokens: 20 }
};

describe("openai unit: prompt-gen handler (Responses API)", () => {
  describe("estimate", () => {
    it("prices chars/4 of system + prompt in and max_output_tokens out at the model's price", () => {
      const handler = createPromptGenHandler(createFakeOpenaiContext());

      // "abcd\nabcdefg" is 12 characters: 3 tokens in; 32 000 out by default.
      const { usd } = handler.estimate({ prompt: "abcdefg", system: "abcd" });

      expect(usd).toBeCloseTo((3 * 0.15 + 32_000 * 0.6) * PER_TOKEN, 12);
    });

    it("adds 1 600 tokens per image and prices params.max_tokens out, offline", () => {
      const handler = createPromptGenHandler(createFakeOpenaiContext());
      const image = { path: "/nowhere/a.png", mimeType: "image/png", hash: "h" };

      const { usd } = handler.estimate({
        prompt: "abcd",
        model: "gpt-6-luna",
        params: { images: [image, image], max_tokens: 1000 }
      });

      expect(usd).toBeCloseTo(((1 + 3200) * 0.1 + 1000 * 0.5) * PER_TOKEN, 12);
    });

    it("estimates a messages + tools request instead of refusing it", () => {
      const handler = createPromptGenHandler(createFakeOpenaiContext());

      const { usd } = handler.estimate({
        prompt: "",
        model: "gpt-6-astra",
        messages: [{ role: "user", content: "abcd" }],
        tools: [{ name: "read_frame", description: "One frame.", inputSchema: {} }],
        params: { max_tokens: 10 }
      });

      expect(usd).toBeCloseTo((1 * 10 + 10 * 50) * PER_TOKEN, 12);
    });

    it("never needs an API key (state.client stays null)", () => {
      const ctx = createFakeOpenaiContext();

      createPromptGenHandler(ctx).estimate({ prompt: "Describe a sunset." });

      expect(ctx.state.client).toBeNull();
    });

    it("prices an unpriced model at 0 USD and logs openai:prompt-gen:unpriced once per model", async () => {
      const { client } = createFakeOpenaiClient();
      const ctx = createFakeOpenaiContext({ state: { client } });
      const handler = createPromptGenHandler(ctx);

      const first = handler.estimate({ prompt: "hi", model: "gpt-9-custom" });
      handler.estimate({ prompt: "hi", model: "openai/gpt-9-custom" });
      const result = await handler.execute({ prompt: "hi", model: "gpt-9-custom" }, {});
      handler.estimate({ prompt: "hi", model: "gpt-9-other" });

      expect(first.usd).toBe(0);
      expect(result.costUsd).toBe(0);
      expect(ctx.log.warn).toHaveBeenCalledTimes(2);
      expect(ctx.log.warn).toHaveBeenNthCalledWith(1, "openai:prompt-gen:unpriced", {
        model: "gpt-9-custom"
      });
      expect(ctx.log.warn).toHaveBeenNthCalledWith(2, "openai:prompt-gen:unpriced", {
        model: "gpt-9-other"
      });
    });
  });

  describe("execute", () => {
    it("calls responses.create with store false, the prompt-gen timeout and the caller's signal", async () => {
      const { client, responsesCalls } = createFakeOpenaiClient();
      const handler = createPromptGenHandler(createFakeOpenaiContext({ state: { client } }));
      const custom = createPromptGenHandler(
        createFakeOpenaiContext({ state: { client }, config: { promptGenTimeoutMs: 5000 } })
      );
      const controller = new AbortController();

      await handler.execute({ prompt: "hi" }, { signal: controller.signal });
      await custom.execute({ prompt: "hi" }, {});

      expect(responsesCalls[0]?.params.store).toBe(false);
      expect(responsesCalls[0]?.options).toEqual({ signal: controller.signal, timeout: 900_000 });
      expect(responsesCalls[1]?.options).toEqual({ timeout: 5000 });
    });

    it("sends the system text as a developer message and the prompt as user input_text", async () => {
      const { client, responsesCalls } = createFakeOpenaiClient();
      const handler = createPromptGenHandler(createFakeOpenaiContext({ state: { client } }));

      await handler.execute({ prompt: "Describe a sunset.", system: "You are a poet." }, {});

      expect(responsesCalls[0]?.params.input).toEqual([
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "You are a poet." }]
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Describe a sunset." }]
        }
      ]);
    });

    it("sends params.images as base64 data URLs read from disk, after the prompt text", async () => {
      const file = path.join(imageDir, "frame.png");
      writeFileSync(file, new Uint8Array([137, 80, 78, 71]));
      const { client, responsesCalls } = createFakeOpenaiClient();
      const handler = createPromptGenHandler(createFakeOpenaiContext({ state: { client } }));

      await handler.execute(
        {
          prompt: "Rate this frame.",
          params: { images: { path: file, mimeType: "image/png", hash: "h" } }
        },
        {}
      );

      expect(responsesCalls[0]?.params.input).toEqual([
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Rate this frame." },
            { type: "input_image", image_url: "data:image/png;base64,iVBORw==", detail: "auto" }
          ]
        }
      ]);
    });

    it("returns the answer text, usage-based cost, typed usage and redacted meta", async () => {
      const { client } = createFakeOpenaiClient({
        responsesResult: textResponse("A fiery orange sunset.", {
          input_tokens: 15,
          output_tokens: 8,
          input_tokens_details: { cached_tokens: 4 }
        })
      });
      const handler = createPromptGenHandler(createFakeOpenaiContext({ state: { client } }));

      const result = await handler.execute({ prompt: "Describe a sunset." }, {});

      expect(result.text).toBe("A fiery orange sunset.");
      expect(result.costUsd).toBeCloseTo((11 * 0.15 + 4 * 0.075 + 8 * 0.6) * PER_TOKEN, 12);
      expect(result.toolCalls).toEqual([]);
      expect(result.finishReason).toBe("stop");
      expect(result.usage).toStrictEqual({
        promptTokens: 15,
        completionTokens: 8,
        cachedTokens: 4,
        cacheWriteTokens: 0,
        cachedReadTokens: 4
      });
      expect(result.meta).toEqual({ model: "gpt-4o-mini", promptTokens: 15, completionTokens: 8 });
    });

    it("prices by chars/4 of what was sent and received when no usage is reported", async () => {
      const { client } = createFakeOpenaiClient({
        responsesResult: {
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "abcdefgh" }] }]
        }
      });
      const handler = createPromptGenHandler(createFakeOpenaiContext({ state: { client } }));

      const result = await handler.execute({ prompt: "abcd" }, {});

      expect(result.costUsd).toBeCloseTo((1 * 0.15 + 2 * 0.6) * PER_TOKEN, 12);
      expect(result.usage).toStrictEqual({
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0
      });
    });

    it("sends a tool turn's reasoning back before its function call on the next request", async () => {
      const { client, responsesCalls } = createFakeOpenaiClient({ responsesResult: TOOL_TURN });
      const ctx = createFakeOpenaiContext({ state: { client } });
      const handler = createPromptGenHandler(ctx);
      const tools = [
        { name: "read_frame", description: "One frame.", inputSchema: { type: "object" } }
      ];
      const asked: ChatMessage[] = [{ role: "user", content: "Check shot 3." }];

      const first = await handler.execute(
        { prompt: "", model: "gpt-6-astra", messages: asked, tools },
        {}
      );
      const next: ChatMessage[] = [
        ...asked,
        { role: "assistant", content: NO_TEXT, toolCalls: first.toolCalls },
        { role: "tool", toolCallId: "call_1", content: "Subject is cut at the chin." }
      ];
      await handler.execute({ prompt: "", model: "gpt-6-astra", messages: next, tools }, {});

      expect(first.toolCalls).toEqual([{ id: "call_1", name: "read_frame", input: { shot: 3 } }]);
      expect(first.finishReason).toBe("tool_calls");
      expect(responsesCalls[1]?.params.input).toEqual([
        { type: "message", role: "user", content: [{ type: "input_text", text: "Check shot 3." }] },
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC_1" },
        { type: "function_call", call_id: "call_1", name: "read_frame", arguments: '{"shot":3}' },
        { type: "function_call_output", call_id: "call_1", output: "Subject is cut at the chin." }
      ]);
    });

    it("refuses a missing API key as unavailable 'auth' so promptGen falls back, building no client", async () => {
      const ctx = createFakeOpenaiContext();
      const handler = createPromptGenHandler(ctx);

      const error = await handler.execute({ prompt: "hi" }, {}).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(PromptGenUnavailableError);
      expect(isPromptGenUnavailable(error)).toBe(true);
      expect((error as PromptGenUnavailableError).reason).toBe("auth");
      expect((error as Error).message).toBe(
        "[ai] OPENAI_API_KEY is not set.\n  Export it, or use another prompt-gen provider."
      );
      expect(ctx.state.client).toBeNull();
    });

    it("refuses a bad request with a terminal 400 before any SDK call", async () => {
      const { client, responsesCalls } = createFakeOpenaiClient();
      const handler = createPromptGenHandler(createFakeOpenaiContext({ state: { client } }));

      const error = await handler
        .execute({ prompt: "hi", params: { reasoning: "max" } }, {})
        .catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(TerminalProviderError);
      expect((error as TerminalProviderError).status).toBe(400);
      expect(responsesCalls).toEqual([]);
    });

    it("logs a classified SDK failure as openai:prompt-gen:failed, redacted, and rethrows it", async () => {
      const { client } = createFakeOpenaiClient({
        responsesImpl: async () => {
          throw new RateLimitError(429, {}, "PROMPT_SECRET", new Headers());
        }
      });
      const ctx = createFakeOpenaiContext({ state: { client } });

      const error = await createPromptGenHandler(ctx)
        .execute({ prompt: "PROMPT_SECRET" }, {})
        .catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(RetryableProviderError);
      expect(ctx.log.warn).toHaveBeenCalledWith("openai:prompt-gen:failed", {
        errorType: "retryable",
        status: 429,
        kind: undefined
      });
    });

    it("never includes the prompt or the answer text in meta or logs (redaction)", async () => {
      const { client } = createFakeOpenaiClient({
        responsesResult: textResponse("GENERATED_SECRET")
      });
      const ctx = createFakeOpenaiContext({ state: { client } });
      const handler = createPromptGenHandler(ctx);

      const result = await handler.execute({ prompt: "PROMPT_SECRET" }, {});

      const logged = JSON.stringify([
        vi.mocked(ctx.log.info).mock.calls,
        vi.mocked(ctx.log.warn).mock.calls
      ]);
      expect(JSON.stringify(result.meta)).not.toMatch(/PROMPT_SECRET|GENERATED_SECRET/);
      expect(logged).not.toMatch(/PROMPT_SECRET|GENERATED_SECRET/);
    });
  });
});
