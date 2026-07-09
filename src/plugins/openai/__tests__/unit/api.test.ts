import { describe, expect, it } from "vitest";
import { createOpenaiApi } from "../../api";
import { createFakeOpenaiContext } from "./fixtures";

describe("openai unit: createOpenaiApi", () => {
  describe("info", () => {
    it("reports configured: false and never throws when no API key is set", () => {
      const ctx = createFakeOpenaiContext();
      const api = createOpenaiApi(ctx);

      expect(api.info()).toEqual({
        provider: "openai",
        configured: false,
        models: { tts: "gpt-4o-mini-tts", chat: "gpt-4o-mini" }
      });
    });

    it("reports configured: true once an API key is present, without constructing a client", () => {
      const ctx = createFakeOpenaiContext({ apiKey: "sk-test" });
      const api = createOpenaiApi(ctx);

      expect(api.info().configured).toBe(true);
      expect(ctx.state.client).toBeNull();
    });

    it("reflects the configured models per capability", () => {
      const ctx = createFakeOpenaiContext({
        config: { models: { tts: "tts-1-hd", chat: "gpt-4o" } }
      });
      const api = createOpenaiApi(ctx);

      expect(api.info().models).toEqual({ tts: "tts-1-hd", chat: "gpt-4o" });
    });
  });
});
