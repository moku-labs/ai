import { describe, expect, it } from "vitest";
import { createTranslateHandler } from "../../translate/handler";
import { FlaggedProviderError } from "../../types";
import {
  createFakeOpenaiClient,
  createFakeOpenaiContext,
  refusalMessage,
  textMessage
} from "./fixtures";

describe("openai unit: translate handler (translate contract)", () => {
  describe("estimate", () => {
    it("prices a chars/4 token heuristic for input + output against the chat model prices", () => {
      const ctx = createFakeOpenaiContext();
      const handler = createTranslateHandler(ctx);

      const result = handler.estimate({ text: "Hello", targetLang: "es" });

      expect(result.usd).toBeGreaterThan(0);
    });

    it("never needs an API key (state.client stays null)", () => {
      const ctx = createFakeOpenaiContext();
      const handler = createTranslateHandler(ctx);

      handler.estimate({ text: "Hello", targetLang: "es" });

      expect(ctx.state.client).toBeNull();
    });
  });

  describe("execute", () => {
    it("interpolates target (and source) language into the system prompt", async () => {
      const { client, chatCalls } = createFakeOpenaiClient();
      const ctx = createFakeOpenaiContext({ state: { client } });
      const handler = createTranslateHandler(ctx);

      await handler.execute({ text: "Hello", targetLang: "es", sourceLang: "en" }, {});

      const systemMessage = chatCalls[0]?.params.messages[0];
      expect(systemMessage?.role).toBe("system");
      expect(systemMessage?.content).toContain("en");
      expect(systemMessage?.content).toContain("es");
      const userMessage = chatCalls[0]?.params.messages[1];
      expect(userMessage).toEqual({ role: "user", content: "Hello" });
    });

    it("uses an auto-detect placeholder when sourceLang is omitted", async () => {
      const { client, chatCalls } = createFakeOpenaiClient();
      const ctx = createFakeOpenaiContext({ state: { client } });
      const handler = createTranslateHandler(ctx);

      await handler.execute({ text: "Hello", targetLang: "es" }, {});

      expect(chatCalls[0]?.params.messages[0]?.content).toContain("auto-detect");
    });

    it("returns the completion text and usage-based actual cost", async () => {
      const { client } = createFakeOpenaiClient({
        chatResult: {
          choices: [{ message: textMessage("Hola") }],
          usage: { prompt_tokens: 20, completion_tokens: 10 }
        }
      });
      const ctx = createFakeOpenaiContext({ state: { client } });
      const handler = createTranslateHandler(ctx);

      const result = await handler.execute({ text: "Hello", targetLang: "es" }, {});

      expect(result.text).toBe("Hola");
      // gpt-4o-mini bundled price: 0.15 in / 0.6 out per 1M tokens.
      expect(result.costUsd).toBeCloseTo((20 / 1_000_000) * 0.15 + (10 / 1_000_000) * 0.6, 10);
      expect(result.meta).toEqual({ model: "gpt-4o-mini", promptTokens: 20, completionTokens: 10 });
    });

    it("falls back to the token heuristic when usage is absent", async () => {
      const { client } = createFakeOpenaiClient({
        chatResult: { choices: [{ message: textMessage("Hola") }] }
      });
      const ctx = createFakeOpenaiContext({ state: { client } });
      const handler = createTranslateHandler(ctx);

      const result = await handler.execute({ text: "Hello", targetLang: "es" }, {});

      expect(result.costUsd).toBeGreaterThanOrEqual(0);
      expect(result.meta?.promptTokens).toBeUndefined();
    });

    it("never sets detectedSourceLang (no reliable signal from a chat completion)", async () => {
      const { client } = createFakeOpenaiClient();
      const ctx = createFakeOpenaiContext({ state: { client } });
      const handler = createTranslateHandler(ctx);

      const result = await handler.execute({ text: "Hello", targetLang: "es" }, {});

      expect(result.detectedSourceLang).toBeUndefined();
    });

    it("throws FlaggedProviderError when the model refuses to answer", async () => {
      const { client } = createFakeOpenaiClient({
        chatResult: {
          choices: [{ message: refusalMessage("I can't help with that.") }]
        }
      });
      const ctx = createFakeOpenaiContext({ state: { client } });
      const handler = createTranslateHandler(ctx);

      await expect(handler.execute({ text: "Hello", targetLang: "es" }, {})).rejects.toBeInstanceOf(
        FlaggedProviderError
      );
    });

    it("forwards the abort signal to the SDK call", async () => {
      const { client, chatCalls } = createFakeOpenaiClient();
      const ctx = createFakeOpenaiContext({ state: { client } });
      const handler = createTranslateHandler(ctx);
      const controller = new AbortController();

      await handler.execute({ text: "Hello", targetLang: "es" }, { signal: controller.signal });

      expect(chatCalls[0]?.signal).toBe(controller.signal);
    });

    it("never includes the source or translated text in meta or thrown errors (redaction)", async () => {
      const { client } = createFakeOpenaiClient({
        chatResult: { choices: [{ message: textMessage("TRANSLATED_SECRET") }] }
      });
      const ctx = createFakeOpenaiContext({ state: { client } });
      const handler = createTranslateHandler(ctx);

      const result = await handler.execute({ text: "SOURCE_SECRET", targetLang: "es" }, {});

      expect(JSON.stringify(result.meta)).not.toContain("SOURCE_SECRET");
      expect(JSON.stringify(result.meta)).not.toContain("TRANSLATED_SECRET");
    });
  });
});
