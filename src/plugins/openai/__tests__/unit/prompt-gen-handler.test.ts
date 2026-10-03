import { describe, expect, it } from "vitest";
import type { PromptGenRequest } from "../../../promptGen/contract";
import { PromptGenUnavailableError } from "../../../promptGen/contract";
import { FlaggedProviderError } from "../../errors";
import { createPromptGenHandler } from "../../prompt-gen/handler";
import {
  createFakeOpenaiClient,
  createFakeOpenaiContext,
  refusalMessage,
  textMessage
} from "./fixtures";

const UNSUPPORTED =
  "[ai] OpenAI prompt-gen does not support messages or tools.\n  Use the fal provider for tool calling.";

/** One request per field this provider cannot express. */
const TOOL_REQUESTS: Array<[string, PromptGenRequest]> = [
  ["messages", { prompt: "", messages: [{ role: "user", content: "Check shot 3." }] }],
  [
    "tools",
    {
      prompt: "p",
      tools: [{ name: "read_frame", description: "Return one frame.", inputSchema: {} }]
    }
  ],
  ["toolChoice", { prompt: "p", toolChoice: "auto" }]
];

/**
 * The error a synchronous call throws.
 *
 * @param call - The call expected to throw.
 * @returns The thrown value.
 */
function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

describe("openai unit: prompt-gen handler (prompt-gen contract)", () => {
  describe("estimate", () => {
    it("prices a chars/4 token heuristic for prompt + system against the chat model prices", () => {
      const ctx = createFakeOpenaiContext();
      const handler = createPromptGenHandler(ctx);

      const withoutSystem = handler.estimate({ prompt: "Describe a sunset." });
      const withSystem = handler.estimate({
        prompt: "Describe a sunset.",
        system: "You are a poet."
      });

      expect(withoutSystem.usd).toBeGreaterThan(0);
      expect(withSystem.usd).toBeGreaterThan(withoutSystem.usd);
    });

    it("never needs an API key (state.client stays null)", () => {
      const ctx = createFakeOpenaiContext();
      const handler = createPromptGenHandler(ctx);

      handler.estimate({ prompt: "Describe a sunset." });

      expect(ctx.state.client).toBeNull();
    });

    it.each(TOOL_REQUESTS)("throws unavailable 'unsupported' for %s", (_label, request) => {
      const handler = createPromptGenHandler(createFakeOpenaiContext());

      const error = thrownBy(() => handler.estimate(request));

      expect(error).toBeInstanceOf(PromptGenUnavailableError);
      expect((error as PromptGenUnavailableError).reason).toBe("unsupported");
      expect((error as Error).message).toBe(UNSUPPORTED);
    });
  });

  describe("execute", () => {
    it("sends the caller's system + prompt as chat messages", async () => {
      const { client, chatCalls } = createFakeOpenaiClient();
      const ctx = createFakeOpenaiContext({ state: { client } });
      const handler = createPromptGenHandler(ctx);

      await handler.execute({ prompt: "Describe a sunset.", system: "You are a poet." }, {});

      expect(chatCalls[0]?.params.messages).toEqual([
        { role: "system", content: "You are a poet." },
        { role: "user", content: "Describe a sunset." }
      ]);
    });

    it("omits the system message entirely when none is given", async () => {
      const { client, chatCalls } = createFakeOpenaiClient();
      const ctx = createFakeOpenaiContext({ state: { client } });
      const handler = createPromptGenHandler(ctx);

      await handler.execute({ prompt: "Describe a sunset." }, {});

      expect(chatCalls[0]?.params.messages).toEqual([
        { role: "user", content: "Describe a sunset." }
      ]);
    });

    it("forwards a caller-supplied temperature, and omits it entirely when absent", async () => {
      const { client, chatCalls } = createFakeOpenaiClient();
      const ctx = createFakeOpenaiContext({ state: { client } });
      const handler = createPromptGenHandler(ctx);

      await handler.execute({ prompt: "hi", temperature: 0.7 }, {});
      await handler.execute({ prompt: "hi" }, {});

      expect(chatCalls[0]?.params.temperature).toBe(0.7);
      expect(Object.hasOwn(chatCalls[1]?.params ?? {}, "temperature")).toBe(false);
    });

    it("returns the completion text and usage-based actual cost", async () => {
      const { client } = createFakeOpenaiClient({
        chatResult: {
          choices: [{ message: textMessage("A fiery orange sunset.") }],
          usage: { prompt_tokens: 15, completion_tokens: 8 }
        }
      });
      const ctx = createFakeOpenaiContext({ state: { client } });
      const handler = createPromptGenHandler(ctx);

      const result = await handler.execute({ prompt: "Describe a sunset." }, {});

      expect(result.text).toBe("A fiery orange sunset.");
      expect(result.costUsd).toBeCloseTo((15 / 1_000_000) * 0.15 + (8 / 1_000_000) * 0.6, 10);
      expect(result.toolCalls).toEqual([]);
      expect(result.finishReason).toBe("stop");
      expect(result.usage).toStrictEqual({
        promptTokens: 15,
        completionTokens: 8,
        cachedTokens: 0,
        cacheWriteTokens: 0
      });
      expect(result.meta).toEqual({ model: "gpt-4o-mini", promptTokens: 15, completionTokens: 8 });
    });

    it("reads cached prompt tokens into the typed usage", async () => {
      const { client } = createFakeOpenaiClient({
        chatResult: {
          choices: [{ message: textMessage("ok"), finish_reason: "stop" }],
          usage: {
            prompt_tokens: 2400,
            completion_tokens: 120,
            prompt_tokens_details: { cached_tokens: 1800 }
          }
        }
      });
      const handler = createPromptGenHandler(createFakeOpenaiContext({ state: { client } }));

      const result = await handler.execute({ prompt: "hi" }, {});

      expect(result.usage).toStrictEqual({
        promptTokens: 2400,
        completionTokens: 120,
        cachedTokens: 1800,
        cacheWriteTokens: 0,
        cachedReadTokens: 1800
      });
    });

    it("keeps a reported cached count of 0 as cachedReadTokens", async () => {
      const { client } = createFakeOpenaiClient({
        chatResult: {
          choices: [{ message: textMessage("ok"), finish_reason: "stop" }],
          usage: {
            prompt_tokens: 2400,
            completion_tokens: 120,
            prompt_tokens_details: { cached_tokens: 0 }
          }
        }
      });
      const handler = createPromptGenHandler(createFakeOpenaiContext({ state: { client } }));

      const result = await handler.execute({ prompt: "hi" }, {});

      expect(result.usage).toStrictEqual({
        promptTokens: 2400,
        completionTokens: 120,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        cachedReadTokens: 0
      });
    });

    it("leaves cachedReadTokens out when the details carry no cached count", async () => {
      const { client } = createFakeOpenaiClient({
        chatResult: {
          choices: [{ message: textMessage("ok"), finish_reason: "stop" }],
          usage: { prompt_tokens: 2400, completion_tokens: 120, prompt_tokens_details: {} }
        }
      });
      const handler = createPromptGenHandler(createFakeOpenaiContext({ state: { client } }));

      const result = await handler.execute({ prompt: "hi" }, {});

      expect(result.usage).toStrictEqual({
        promptTokens: 2400,
        completionTokens: 120,
        cachedTokens: 0,
        cacheWriteTokens: 0
      });
      expect(result.usage).not.toHaveProperty("cachedReadTokens");
      expect(result.usage).not.toHaveProperty("cachedWriteTokens");
    });

    it("reports zero usage when the provider sends none", async () => {
      const { client } = createFakeOpenaiClient({
        chatResult: { choices: [{ message: textMessage("ok") }] }
      });
      const handler = createPromptGenHandler(createFakeOpenaiContext({ state: { client } }));

      const result = await handler.execute({ prompt: "hi" }, {});

      expect(result.usage).toStrictEqual({
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0
      });
    });

    it("maps finish_reason length to length, anything else to stop", async () => {
      const { client } = createFakeOpenaiClient({
        chatResult: { choices: [{ message: textMessage("cut"), finish_reason: "length" }] }
      });
      const handler = createPromptGenHandler(createFakeOpenaiContext({ state: { client } }));
      const { client: filtered } = createFakeOpenaiClient({
        chatResult: { choices: [{ message: textMessage("x"), finish_reason: "content_filter" }] }
      });
      const filteredHandler = createPromptGenHandler(
        createFakeOpenaiContext({ state: { client: filtered } })
      );

      const cut = await handler.execute({ prompt: "hi" }, {});
      const other = await filteredHandler.execute({ prompt: "hi" }, {});

      expect(cut.finishReason).toBe("length");
      expect(other.finishReason).toBe("stop");
    });

    it("ignores cacheSystem alone: same SDK body as without it", async () => {
      const { client, chatCalls } = createFakeOpenaiClient();
      const handler = createPromptGenHandler(createFakeOpenaiContext({ state: { client } }));

      await handler.execute({ prompt: "hi", system: "Be terse." }, {});
      await handler.execute({ prompt: "hi", system: "Be terse.", cacheSystem: true }, {});

      expect(chatCalls[1]?.params).toEqual(chatCalls[0]?.params);
    });

    it.each(
      TOOL_REQUESTS
    )("throws unavailable 'unsupported' for %s before any SDK call", async (_label, request) => {
      const { client, chatCalls } = createFakeOpenaiClient();
      const handler = createPromptGenHandler(createFakeOpenaiContext({ state: { client } }));

      const error = await handler.execute(request, {}).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(PromptGenUnavailableError);
      expect((error as PromptGenUnavailableError).reason).toBe("unsupported");
      expect((error as Error).message).toBe(UNSUPPORTED);
      expect(chatCalls).toEqual([]);
    });

    it("throws FlaggedProviderError when the model refuses to answer", async () => {
      const { client } = createFakeOpenaiClient({
        chatResult: {
          choices: [{ message: refusalMessage("I can't help with that.") }]
        }
      });
      const ctx = createFakeOpenaiContext({ state: { client } });
      const handler = createPromptGenHandler(ctx);

      await expect(handler.execute({ prompt: "hi" }, {})).rejects.toBeInstanceOf(
        FlaggedProviderError
      );
    });

    it("forwards the abort signal to the SDK call", async () => {
      const { client, chatCalls } = createFakeOpenaiClient();
      const ctx = createFakeOpenaiContext({ state: { client } });
      const handler = createPromptGenHandler(ctx);
      const controller = new AbortController();

      await handler.execute({ prompt: "hi" }, { signal: controller.signal });

      expect(chatCalls[0]?.signal).toBe(controller.signal);
    });

    it("never includes the prompt or completion text in meta (redaction)", async () => {
      const { client } = createFakeOpenaiClient({
        chatResult: { choices: [{ message: textMessage("GENERATED_SECRET") }] }
      });
      const ctx = createFakeOpenaiContext({ state: { client } });
      const handler = createPromptGenHandler(ctx);

      const result = await handler.execute({ prompt: "PROMPT_SECRET" }, {});

      expect(JSON.stringify(result.meta)).not.toContain("PROMPT_SECRET");
      expect(JSON.stringify(result.meta)).not.toContain("GENERATED_SECRET");
    });
  });
});
