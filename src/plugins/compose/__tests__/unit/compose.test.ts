import { describe, expect, expectTypeOf, it } from "vitest";
import { buildfilePlugin } from "../../../buildfile";
import { createBuildfileApi } from "../../../buildfile/api";
import type { BuildfileApi } from "../../../buildfile/types";
import { promptGenPlugin } from "../../../promptGen";
import type { PromptGenApi, PromptGenRequest } from "../../../promptGen/types";
import { createComposeApi } from "../../api";
import { emitScript, emitYaml, schemaPathFromTemplate } from "../../emit";
import type { ComposeApi, ComposeContext, ComposeResult, Config } from "../../types";

// ---------------------------------------------------------------------------
// Unit test: createComposeApi (mock promptGen, REAL buildfile — buildfile is
// a stateless pure compiler, so wiring the real createBuildfileApi exercises
// compose's repair loop against real zod validation instead of re-mocking
// buildfile's own validation logic).
// ---------------------------------------------------------------------------

const SCHEMA_PATH = ".moku/build.schema.json";

const VALID_YAML =
  'version: 1\nname: demo\nitems:\n  - task: voiceover\n    input:\n      text: "Hello, world!"\n      voice: "v1"\n';

/** Fails buildSpecSchema validation: `version` must be the literal `1`. */
const INVALID_YAML = "version: 2\nname: demo\nitems: []\n";

/** Builds a fake `PromptGenApi` returning one canned response per call, in order. */
function createFakePromptGen(responses: ReadonlyArray<{ text: string; costUsd: number }>): {
  api: PromptGenApi;
  calls: PromptGenRequest[];
} {
  const calls: PromptGenRequest[] = [];
  const api: PromptGenApi = {
    generate: async request => {
      calls.push(request);
      const response = responses[calls.length - 1];
      if (response === undefined) {
        throw new Error("createFakePromptGen: ran out of canned responses");
      }
      return { text: response.text, costUsd: response.costUsd };
    },
    estimate: () => ({ usd: 0 }),
    providers: () => ["fake"]
  };
  return { api, calls };
}

/** Which dependency plugin instance {@link ComposeContext.require} was called with. */
type RequiredDep = typeof buildfilePlugin | typeof promptGenPlugin;

/**
 * Builds a mock `ComposeContext` around a fake promptGen and the real
 * buildfile API, plus a log of every plugin instance `ctx.require` resolved
 * — used to assert compose never reaches for `registry`.
 */
function createTestCtx(
  promptGen: PromptGenApi,
  configOverrides?: Partial<Config>
): { ctx: ComposeContext; requiredDeps: RequiredDep[] } {
  const buildfileApi = createBuildfileApi({
    config: { defaultGlob: "**/*.moku.yaml", schemaPath: SCHEMA_PATH },
    state: {},
    emit: () => undefined
  });
  const config: Config = { provider: "openai", maxRepairAttempts: 2, ...configOverrides };
  const requiredDeps: RequiredDep[] = [];

  function requireImpl(plugin: typeof buildfilePlugin): BuildfileApi;
  function requireImpl(plugin: typeof promptGenPlugin): PromptGenApi;
  function requireImpl(plugin: RequiredDep): BuildfileApi | PromptGenApi {
    requiredDeps.push(plugin);
    return plugin === buildfilePlugin ? buildfileApi : promptGen;
  }

  const ctx: ComposeContext = { config, state: {}, emit: () => undefined, require: requireImpl };
  return { ctx, requiredDeps };
}

describe("createComposeApi", () => {
  // -------------------------------------------------------------------------
  // happy path: emit "build"
  // -------------------------------------------------------------------------

  describe("compose: happy path (emit build)", () => {
    it("returns the validated spec and YAML text with the modeline + $schema key", async () => {
      const { api: promptGen } = createFakePromptGen([{ text: VALID_YAML, costUsd: 0.001 }]);
      const { ctx } = createTestCtx(promptGen);
      const api = createComposeApi(ctx);

      const result = await api.compose({ prompt: "narrate a greeting", emit: "build" });

      expect(result.spec).toEqual({
        version: 1,
        name: "demo",
        items: [{ task: "voiceover", input: { text: "Hello, world!", voice: "v1" } }]
      });
      expect(result.text).toContain(`# yaml-language-server: $schema=${SCHEMA_PATH}`);
      expect(result.text).toContain(`$schema: ${SCHEMA_PATH}`);
      expect(result.costUsd).toBe(0.001);
    });

    it("the emitted YAML text round-trips through buildfile.compile", async () => {
      const { api: promptGen } = createFakePromptGen([{ text: VALID_YAML, costUsd: 0.001 }]);
      const { ctx } = createTestCtx(promptGen);
      const api = createComposeApi(ctx);
      const buildfile = ctx.require(buildfilePlugin);

      const result = await api.compose({ prompt: "narrate a greeting", emit: "build" });
      const recompiled = await buildfile.compile({ text: result.text, lang: "yaml" });

      expect(recompiled.spec).toEqual(result.spec);
    });

    it("never calls ctx.require with anything other than buildfile/promptGen", async () => {
      const { api: promptGen } = createFakePromptGen([{ text: VALID_YAML, costUsd: 0.001 }]);
      const { ctx, requiredDeps } = createTestCtx(promptGen);
      const api = createComposeApi(ctx);

      await api.compose({ prompt: "narrate a greeting", emit: "build" });

      expect(requiredDeps.length).toBeGreaterThan(0);
      expect(requiredDeps.every(dep => dep === buildfilePlugin || dep === promptGenPlugin)).toBe(
        true
      );
    });
  });

  // -------------------------------------------------------------------------
  // happy path: emit "script"
  // -------------------------------------------------------------------------

  describe("compose: happy path (emit script)", () => {
    it("returns a defineBuild() TypeScript module containing the spec as a typed literal", async () => {
      const { api: promptGen } = createFakePromptGen([{ text: VALID_YAML, costUsd: 0.001 }]);
      const { ctx } = createTestCtx(promptGen);
      const api = createComposeApi(ctx);

      const result = await api.compose({ prompt: "narrate a greeting", emit: "script" });

      expect(result.text).toContain('import { defineBuild } from "@moku-labs/ai";');
      expect(result.text).toContain("export default defineBuild(");
      expect(result.text).toContain('"task": "voiceover"');
      expect(result.text).toContain('"name": "demo"');
    });
  });

  // -------------------------------------------------------------------------
  // name override
  // -------------------------------------------------------------------------

  describe("compose: opts.name override", () => {
    it("overrides the generated spec's name in both the returned spec and the emitted text", async () => {
      const { api: promptGen } = createFakePromptGen([{ text: VALID_YAML, costUsd: 0.001 }]);
      const { ctx } = createTestCtx(promptGen);
      const api = createComposeApi(ctx);

      const result = await api.compose({
        prompt: "narrate a greeting",
        emit: "build",
        name: "custom-name"
      });

      expect(result.spec.name).toBe("custom-name");
      expect(result.text).toContain("name: custom-name");
      expect(result.text).not.toContain("name: demo");
    });
  });

  // -------------------------------------------------------------------------
  // fenced-output stripping
  // -------------------------------------------------------------------------

  describe("compose: fenced model output", () => {
    it("strips a wrapping ```yaml fence before validating", async () => {
      const fenced = `\`\`\`yaml\n${VALID_YAML}\`\`\``;
      const { api: promptGen } = createFakePromptGen([{ text: fenced, costUsd: 0.001 }]);
      const { ctx } = createTestCtx(promptGen);
      const api = createComposeApi(ctx);

      const result = await api.compose({ prompt: "narrate a greeting", emit: "build" });

      expect(result.spec.name).toBe("demo");
    });

    it("strips a wrapping fence with no language tag", async () => {
      const fenced = `\`\`\`\n${VALID_YAML}\`\`\``;
      const { api: promptGen } = createFakePromptGen([{ text: fenced, costUsd: 0.001 }]);
      const { ctx } = createTestCtx(promptGen);
      const api = createComposeApi(ctx);

      const result = await api.compose({ prompt: "narrate a greeting", emit: "build" });

      expect(result.spec.name).toBe("demo");
    });
  });

  // -------------------------------------------------------------------------
  // repair loop: first attempt invalid, second valid
  // -------------------------------------------------------------------------

  describe("compose: repair loop", () => {
    it("re-prompts once and succeeds on the second attempt, summing cost across both", async () => {
      const { api: promptGen, calls } = createFakePromptGen([
        { text: INVALID_YAML, costUsd: 0.5 },
        { text: VALID_YAML, costUsd: 0.25 }
      ]);
      const { ctx } = createTestCtx(promptGen);
      const api = createComposeApi(ctx);

      const result = await api.compose({ prompt: "narrate a greeting", emit: "build" });

      expect(calls).toHaveLength(2);
      expect(result.spec.name).toBe("demo");
      expect(result.costUsd).toBe(0.75);
    });

    it("includes the original prompt, the previous output, and the zod validation issue in the repair prompt", async () => {
      const { api: promptGen, calls } = createFakePromptGen([
        { text: INVALID_YAML, costUsd: 0.1 },
        { text: VALID_YAML, costUsd: 0.1 }
      ]);
      const { ctx } = createTestCtx(promptGen);
      const api = createComposeApi(ctx);

      await api.compose({ prompt: "narrate a greeting", emit: "build" });

      const repairPrompt = calls[1]?.prompt ?? "";
      expect(repairPrompt).toContain("narrate a greeting");
      expect(repairPrompt).toContain(INVALID_YAML.trim());
      expect(repairPrompt.toLowerCase()).toContain("version");
    });
  });

  // -------------------------------------------------------------------------
  // repair loop: exhaustion (exact two-line error)
  // -------------------------------------------------------------------------

  describe("compose: repair attempts exhausted", () => {
    it("throws the exact two-line error after maxRepairAttempts + 1 failed attempts", async () => {
      const { api: promptGen, calls } = createFakePromptGen([
        { text: INVALID_YAML, costUsd: 0.1 },
        { text: INVALID_YAML, costUsd: 0.1 }
      ]);
      const { ctx } = createTestCtx(promptGen, { maxRepairAttempts: 1 });
      const api = createComposeApi(ctx);

      await expect(api.compose({ prompt: "narrate a greeting", emit: "build" })).rejects.toThrow(
        '[ai] Compose could not produce a valid build file after 2 attempts.\n  Refine the prompt or write the build file manually with "moku new".'
      );
      expect(calls).toHaveLength(2);
    });

    it("matches the exact pinned two-line format", async () => {
      const { api: promptGen } = createFakePromptGen([{ text: INVALID_YAML, costUsd: 0 }]);
      const { ctx } = createTestCtx(promptGen, { maxRepairAttempts: 0 });
      const api = createComposeApi(ctx);

      await expect(api.compose({ prompt: "x", emit: "build" })).rejects.toThrow(
        /^\[ai] Compose could not produce a valid build file after \d+ attempts\.\n {2}.+\.$/
      );
    });
  });

  // -------------------------------------------------------------------------
  // provider / signal forwarding
  // -------------------------------------------------------------------------

  describe("compose: provider + signal forwarding", () => {
    it("forwards config.provider and opts.signal to promptGen.generate", async () => {
      const calls: Array<{ provider: string | undefined; signal: AbortSignal | undefined }> = [];
      const promptGen: PromptGenApi = {
        generate: async (_request, opts) => {
          calls.push({ provider: opts?.provider, signal: opts?.signal });
          return { text: VALID_YAML, costUsd: 0 };
        },
        estimate: () => ({ usd: 0 }),
        providers: () => ["fake"]
      };
      const { ctx } = createTestCtx(promptGen, { provider: "anthropic" });
      const api = createComposeApi(ctx);
      const controller = new AbortController();

      await api.compose({ prompt: "x", emit: "build", signal: controller.signal });

      expect(calls[0]).toEqual({ provider: "anthropic", signal: controller.signal });
    });
  });

  // -------------------------------------------------------------------------
  // types: ComposeApi
  // -------------------------------------------------------------------------

  describe("types: ComposeApi", () => {
    it("compose resolves a ComposeResult", async () => {
      const { api: promptGen } = createFakePromptGen([{ text: VALID_YAML, costUsd: 0 }]);
      const { ctx } = createTestCtx(promptGen);
      const api: ComposeApi = createComposeApi(ctx);

      expectTypeOf(api.compose).returns.resolves.toEqualTypeOf<ComposeResult>();

      await api.compose({ prompt: "x", emit: "build" });
    });

    it("rejects an unsupported emit value at compile time", async () => {
      const { api: promptGen } = createFakePromptGen([{ text: VALID_YAML, costUsd: 0 }]);
      const { ctx } = createTestCtx(promptGen);
      const api = createComposeApi(ctx);

      // @ts-expect-error -- emit must be "build" | "script"
      const result = await api.compose({ prompt: "x", emit: "bogus" });

      expect(result.spec.name).toBe("demo");
    });
  });
});

// ---------------------------------------------------------------------------
// Unit test: emit.ts helpers
// ---------------------------------------------------------------------------

describe("emit", () => {
  const spec = {
    version: 1 as const,
    name: "demo",
    items: [{ task: "voiceover", input: { text: "hi", voice: "v1" } }]
  };

  describe("schemaPathFromTemplate", () => {
    it("extracts the $schema path from a rendered template's modeline", () => {
      const template = `# yaml-language-server: $schema=${SCHEMA_PATH}\n$schema: ${SCHEMA_PATH}\nversion: 1\n`;
      expect(schemaPathFromTemplate(template)).toBe(SCHEMA_PATH);
    });

    it("throws when the text doesn't start with the expected modeline", () => {
      expect(() => schemaPathFromTemplate("version: 1\nname: x\n")).toThrow(
        /^\[ai] Compose could not derive a schema path/
      );
    });
  });

  describe("emitYaml", () => {
    it("emits the modeline, $schema key, then the spec body", () => {
      const text = emitYaml(spec, SCHEMA_PATH);
      const lines = text.split("\n");

      expect(lines[0]).toBe(`# yaml-language-server: $schema=${SCHEMA_PATH}`);
      expect(lines[1]).toBe(`$schema: ${SCHEMA_PATH}`);
      expect(text).toContain("name: demo");
      expect(text).toContain("task: voiceover");
    });
  });

  describe("emitScript", () => {
    it("emits an importable defineBuild() TypeScript module", () => {
      const text = emitScript(spec);

      expect(text).toContain('import { defineBuild } from "@moku-labs/ai";');
      expect(text).toContain("export default defineBuild({");
      expect(text).toContain('"name": "demo"');
    });
  });
});
