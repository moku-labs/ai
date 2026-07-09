import { describe, expect, it } from "vitest";
import { createPromptGenHandler } from "../../prompt-gen/handler";
import { FlaggedProviderError } from "../../types";
import {
  createFakeOpenaiClient,
  createFakeOpenaiContext,
  refusalMessage,
  textMessage
} from "./fixtures";

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
      expect(result.meta).toEqual({ model: "gpt-4o-mini", promptTokens: 15, completionTokens: 8 });
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
