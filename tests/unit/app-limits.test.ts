import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/index";

describe("framework createApp: limits lanes and apimodels wiring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("caps the apimodels video lane at 2 concurrent jobs and 20 rpm", () => {
    const app = createApp({});

    const lane = app.limits.laneConfig("video/apimodels/default");

    expect(lane.concurrency).toBe(2);
    expect(lane.rpm).toBe(20);
  });

  it("keeps the framework defaults on every other lane", () => {
    const app = createApp({});

    const lane = app.limits.laneConfig("video/fal/default");

    expect(lane).toEqual({
      rpm: 60,
      concurrency: 4,
      breakerThreshold: 5,
      breakerCooldownMs: 30_000
    });
  });

  it("registers apimodels and reads its key from the process environment", () => {
    vi.stubEnv("APIMODELS_API_KEY", "test-key");

    const app = createApp({});

    expect(app.apimodels.info().configured).toBe(true);
    expect(app.apimodels.info().models).toContain("seedance-2.5");
  });
});
