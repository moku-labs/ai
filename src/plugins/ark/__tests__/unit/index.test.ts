import { describe, expect, it } from "vitest";
import { arkPlugin } from "../../index";
import { createFakeRegistry, createTestCtx, DEFAULT_CONFIG } from "../fixtures";

describe("arkPlugin — wiring", () => {
  it("is named ark with the documented config defaults", () => {
    expect(arkPlugin.name).toBe("ark");
    expect(arkPlugin.spec.config).toEqual(DEFAULT_CONFIG);
  });

  it("depends on the registry only", () => {
    const names = arkPlugin.spec.depends?.map((dependency: { name: string }) => dependency.name);
    expect(names).toEqual(["registry"]);
  });

  it("declares no events, hooks, onStart or onStop", () => {
    expect("events" in arkPlugin.spec).toBe(false);
    expect("hooks" in arkPlugin.spec).toBe(false);
    expect(arkPlugin.spec.onStart).toBeUndefined();
    expect(arkPlugin.spec.onStop).toBeUndefined();
  });

  it("registers video/ark and asset/ark in onInit", () => {
    const registry = createFakeRegistry();
    const ctx = createTestCtx({ registry });

    // A partial plugin ctx: onInit only reads require, config, state, env and log.
    type InitContext = Parameters<NonNullable<typeof arkPlugin.spec.onInit>>[0];
    arkPlugin.spec.onInit?.(ctx as unknown as InitContext);

    expect(registry.providers("video")).toEqual(["ark"]);
    expect(registry.providers("asset")).toEqual(["ark"]);
    for (const task of ["video", "asset"]) {
      expect(registry.resolve(task, "ark")).toMatchObject({
        estimate: expect.any(Function),
        submit: expect.any(Function),
        poll: expect.any(Function)
      });
    }
  });
});
