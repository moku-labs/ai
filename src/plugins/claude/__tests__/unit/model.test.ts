import { describe, expect, it } from "vitest";
import { effortFor, mapModel } from "../../prompt/model";

const DEFAULTS = { textModel: "", modelMap: {} };

describe("mapModel", () => {
  it("strips the anthropic/ prefix and turns dots into dashes", () => {
    expect(mapModel(DEFAULTS, "anthropic/claude-opus-5.5")).toBe("claude-opus-5-5");
  });

  it("passes bare claude ids and family aliases through", () => {
    expect(mapModel(DEFAULTS, "claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(mapModel(DEFAULTS, "opus")).toBe("opus");
    expect(mapModel(DEFAULTS, "haiku")).toBe("haiku");
    expect(mapModel(DEFAULTS, "fable")).toBe("fable");
  });

  it("maps a foreign vendor id to textModel", () => {
    expect(mapModel({ textModel: "sonnet", modelMap: {} }, "openai/gpt-6-sol")).toBe("sonnet");
  });

  it("returns undefined (no --model) for a foreign id or no id when textModel is empty", () => {
    expect(mapModel(DEFAULTS, "openai/gpt-6-sol")).toBeUndefined();
    expect(mapModel(DEFAULTS, undefined)).toBeUndefined();
  });

  it("maps the bare anthropic/ prefix to textModel, never to an empty --model", () => {
    expect(mapModel(DEFAULTS, "anthropic/")).toBeUndefined();
    expect(mapModel({ textModel: "haiku", modelMap: {} }, "anthropic/")).toBe("haiku");
  });

  it("uses textModel when the request names no model", () => {
    expect(mapModel({ textModel: "haiku", modelMap: {} }, undefined)).toBe("haiku");
  });

  it("lets modelMap win over the built-in rules, by exact id", () => {
    const config = {
      textModel: "sonnet",
      modelMap: { "anthropic/claude-opus-5.5": "opus", "openai/gpt-6-sol": "haiku" }
    };

    expect(mapModel(config, "anthropic/claude-opus-5.5")).toBe("opus");
    expect(mapModel(config, "openai/gpt-6-sol")).toBe("haiku");
    expect(mapModel(config, "toString")).toBe("sonnet");
  });
});

describe("effortFor", () => {
  it("maps off to low and passes the other levels through", () => {
    expect(effortFor("off")).toBe("low");
    expect(effortFor("low")).toBe("low");
    expect(effortFor("medium")).toBe("medium");
    expect(effortFor("high")).toBe("high");
  });

  it("returns undefined (no --effort) when reasoning is absent", () => {
    expect(effortFor(undefined)).toBeUndefined();
  });
});
