import { describe, expect, it } from "vitest";
import { cliPlugin } from "../../index";

describe("cliPlugin — wiring", () => {
  it("defaults config.plain to false", () => {
    expect(cliPlugin.spec.config).toEqual({ plain: false });
  });

  it("declares no lifecycle hooks (post-start dispatch, OQ1)", () => {
    expect(cliPlugin.spec.onInit).toBeUndefined();
    expect(cliPlugin.spec.onStart).toBeUndefined();
    expect(cliPlugin.spec.onStop).toBeUndefined();
  });

  it("declares no events", () => {
    expect("events" in cliPlugin.spec).toBe(false);
  });

  it("declares its three dependencies (runner, buildfile, compose)", () => {
    const dependencyNames = cliPlugin.spec.depends?.map(
      (dependency: { name: string }) => dependency.name
    );
    expect(dependencyNames).toEqual(["runner", "buildfile", "compose"]);
  });
});
