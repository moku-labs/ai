/**
 * @file anthropic API — `info()` reports the key and the default model,
 * never throws and never builds the client.
 */
import { describe, expect, it } from "vitest";
import { createAnthropicApi } from "../../api";
import { createFakeAnthropicContext } from "./fixtures";

describe("anthropic api: info", () => {
  it("reports configured and the default model when the key is set", () => {
    const ctx = createFakeAnthropicContext({
      apiKey: "sk-ant-test",
      config: { model: "claude-sonnet-5" }
    });

    expect(createAnthropicApi(ctx).info()).toEqual({
      provider: "anthropic",
      configured: true,
      model: "claude-sonnet-5"
    });
  });

  it("reports not configured without the key, without building the client", () => {
    const ctx = createFakeAnthropicContext();

    expect(createAnthropicApi(ctx).info().configured).toBe(false);
    expect(ctx.state.client).toBeNull();
  });

  it("reads the variable named by config.apiKeyEnv", () => {
    const ctx = createFakeAnthropicContext({
      apiKey: "sk-ant-test",
      config: { apiKeyEnv: "STUDIO_CLAUDE_KEY" }
    });

    expect(createAnthropicApi(ctx).info().configured).toBe(true);
  });
});
