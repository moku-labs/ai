import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/index";

describe("framework createApp: environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads provider keys from the process environment", () => {
    vi.stubEnv("FAL_KEY", "test-key");

    const app = createApp({});

    expect(app.fal.info().configured).toBe(true);
  });

  it("reports a provider unconfigured when its key is absent everywhere", () => {
    vi.stubEnv("FAL_KEY", "");

    const app = createApp({});

    expect(app.fal.info().configured).toBe(false);
  });
});
