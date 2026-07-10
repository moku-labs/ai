/**
 * @file Batch 8 — journey: CLI workflow integration scenarios (S29–S32).
 *
 * Drives the REAL cli plugin (`app.cli.dispatch`) end-to-end against the full
 * framework composition: new → validate → estimate, run → status → compose,
 * dry-run spend-nothing semantics, and the ratified failure exit codes. Every
 * test chdirs into a per-test tmp dir (restored in afterEach) so `new`'s
 * `.moku/` schema output and all build files land outside the repo, and traps
 * `process.exit` to prove `dispatch()` never calls it.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreConfig } from "../../src/config";
import { registryPlugin } from "../../src/plugins";
import { EXIT_CODES } from "../../src/plugins/cli/types";
import type { PromptGenHandler } from "../../src/plugins/promptGen/types";
import {
  buildFileYaml,
  buildFramework,
  createFakeHandler,
  createFakeProviderPlugin,
  createRunEventListenerPlugin
} from "./helpers";

/** Matches `buildfile.template()`'s first-line yaml-language-server modeline. */
const MODELINE_PATTERN = /^# yaml-language-server: \$schema=(.+)$/m;

/** A standard voiceover/"fake" build item used across the scenarios. */
const FAKE_VOICEOVER_ITEM = {
  task: "voiceover",
  provider: "fake",
  input: { text: "hello", voice: "en-US-1" }
};

/**
 * Fixture plugin registering a canned `PromptGenHandler` under
 * ("prompt-gen", "openai") — compose's default provider chain — so the cli
 * `compose` command runs against the real compose→promptGen→buildfile stack
 * without any network (helpers.ts has no PromptGenHandler-shaped fixture, so
 * this local helper fills the gap).
 */
function createCannedPromptGenPlugin(text: string) {
  const handler: PromptGenHandler = {
    estimate: () => ({ usd: 0.001 }),
    execute: async () => ({ text, costUsd: 0.001 })
  };

  return coreConfig.createPlugin("cannedPromptGen", {
    depends: [registryPlugin],
    onInit: ctx => {
      ctx.require(registryPlugin).register("prompt-gen", "openai", handler);
    }
  });
}

/** Counts regular files under `dir` recursively; 0 when the dir doesn't exist. */
async function countFiles(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries.filter(entry => entry.isFile()).length;
  } catch {
    return 0;
  }
}

describe("journey: cli workflow integration", () => {
  let tempDir: string;
  let originalCwd: string;
  let originalExit: typeof process.exit;
  let processExitCalled: boolean;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-root-int-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);

    // Trap process.exit for the whole test — dispatch() must never call it.
    processExitCalled = false;
    originalExit = process.exit;
    // biome-ignore lint/suspicious/noExplicitAny: swapping process.exit for the duration of the test
    (process as any).exit = (): never => {
      processExitCalled = true;
      throw new Error("process.exit must never be called by dispatch()");
    };
  });

  afterEach(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: restoring process.exit
    (process as any).exit = originalExit;
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // S29 — new → validate → estimate
  // ---------------------------------------------------------------------------

  it("S29: new writes starter YAML + JSON Schema, then validate and estimate exit ok", async () => {
    const framework = buildFramework(tempDir, {
      extraPlugins: [
        createFakeProviderPlugin(
          "fakeVoiceoverProvider",
          "voiceover",
          "fake",
          createFakeHandler({ costUsd: 0.1 })
        )
      ]
    });
    const app = framework.createApp();
    await app.start();

    try {
      // `moku new demo` scaffolds the starter build file + the JSON Schema.
      const newCode = await app.cli.dispatch(["new", "demo"]);
      expect(newCode).toBe(EXIT_CODES.ok);

      // The starter is template() output on disk: modeline + `$schema:` key.
      const starter = await readFile(path.join(tempDir, "demo.moku.yaml"), "utf8");
      expect(starter).toContain('name: "demo"');
      expect(starter).toContain("$schema:");
      const modelineMatch = MODELINE_PATTERN.exec(starter);
      const schemaPath = modelineMatch?.[1];
      if (schemaPath === undefined) {
        throw new Error("starter build file is missing the yaml-language-server modeline");
      }

      // The JSON Schema file the modeline points at was written alongside it.
      const schemaText = await readFile(path.resolve(tempDir, schemaPath), "utf8");
      const schema = JSON.parse(schemaText) as Record<string, unknown>;
      expect(schema).toHaveProperty("properties");

      // Point the build file at the fake voiceover provider, then validate + estimate.
      await writeFile(
        path.join(tempDir, "demo.moku.yaml"),
        buildFileYaml("demo", [FAKE_VOICEOVER_ITEM]),
        "utf8"
      );
      expect(await app.cli.dispatch(["validate"])).toBe(EXIT_CODES.ok);
      expect(await app.cli.dispatch(["estimate"])).toBe(EXIT_CODES.ok);

      expect(processExitCalled).toBe(false);
    } finally {
      await app.stop();
    }
  });

  // ---------------------------------------------------------------------------
  // S30 — run → status + commands() tree + cli compose command
  // ---------------------------------------------------------------------------

  it("S30: run completes a journaled run, status reports it, commands() lists the tree, compose writes a file", async () => {
    const sink: Record<string, unknown[]> = {};
    const composedYaml = buildFileYaml("composed", [FAKE_VOICEOVER_ITEM]);
    const framework = buildFramework(tempDir, {
      extraPlugins: [
        createFakeProviderPlugin(
          "fakeVoiceoverProvider",
          "voiceover",
          "fake",
          createFakeHandler({ costUsd: 0.1 })
        ),
        createCannedPromptGenPlugin(composedYaml),
        createRunEventListenerPlugin(sink)
      ]
    });
    const app = framework.createApp();
    await app.start();

    try {
      // A real (non-dry) run over one voiceover/fake item.
      await writeFile(
        path.join(tempDir, "job.moku.yaml"),
        buildFileYaml("job", [FAKE_VOICEOVER_ITEM]),
        "utf8"
      );
      expect(await app.cli.dispatch(["run"])).toBe(EXIT_CODES.ok);

      // The journal (via probe) shows the run as done, with the item committed.
      const doneEvents = sink["run:done"] ?? [];
      expect(doneEvents).toHaveLength(1);
      const { runId } = doneEvents[0] as { runId: string };
      expect(app.probe.journal.getRun(runId)?.status).toBe("done");
      expect(app.probe.journal.totals(runId)).toMatchObject({ total: 1, done: 1 });

      // `moku status <runId>` — a finished run is not `latestResumableRun()`,
      // so status needs the explicit runId positional (cf. cli.test.ts).
      expect(await app.cli.dispatch(["status", runId])).toBe(EXIT_CODES.ok);

      // commands() exposes the mountable tree with descriptions.
      const tree = app.cli.commands();
      const names = tree.commands.map(command => command.name);
      expect(names).toEqual(
        expect.arrayContaining(["new", "validate", "estimate", "run", "status", "compose"])
      );
      for (const command of tree.commands) {
        expect(command.description.length).toBeGreaterThan(0);
      }

      // `moku compose "<prompt>" --out <path>` — buildfile→compose→cli chain.
      const composeCode = await app.cli.dispatch([
        "compose",
        "narrate a greeting",
        "--out",
        "composed.moku.yaml"
      ]);
      expect(composeCode).toBe(EXIT_CODES.ok);
      const composedText = await readFile(path.join(tempDir, "composed.moku.yaml"), "utf8");
      expect(composedText).toContain("task: voiceover");

      expect(processExitCalled).toBe(false);
    } finally {
      await app.stop();
    }
  });

  // ---------------------------------------------------------------------------
  // S31 — run --dry-run spends nothing
  // ---------------------------------------------------------------------------

  it("S31: run --dry-run exits ok, opens no journal run, stores nothing, never executes handlers", async () => {
    const handler = createFakeHandler({ costUsd: 0.25 });
    const framework = buildFramework(tempDir, {
      extraPlugins: [
        createFakeProviderPlugin("fakeVoiceoverProvider", "voiceover", "fake", handler)
      ]
    });
    const app = framework.createApp();
    await app.start();

    try {
      await writeFile(
        path.join(tempDir, "dry.moku.yaml"),
        buildFileYaml("dry", [FAKE_VOICEOVER_ITEM]),
        "utf8"
      );
      expect(await app.cli.dispatch(["run", "--dry-run"])).toBe(EXIT_CODES.ok);

      // Pinned dry-run semantics (runner/api.ts): a dry run short-circuits to
      // the estimate — NO journal row is opened (only a synthetic "dry-run"
      // id is returned) — so there is no run row and nothing to resume.
      expect(app.probe.journal.getRun("dry-run")).toBeUndefined();
      expect(app.probe.journal.latestResumableRun()).toBeUndefined();

      // No spend: the handler never executed and the store holds no artifacts.
      expect(handler.attempts()).toBe(0);
      expect(await countFiles(path.join(tempDir, "store"))).toBe(0);

      expect(processExitCalled).toBe(false);
    } finally {
      await app.stop();
    }
  });

  // ---------------------------------------------------------------------------
  // S32 — failure exit codes
  // ---------------------------------------------------------------------------

  it("S32: malformed YAML, unregistered provider, and unknown command map to the ratified exit codes", async () => {
    const framework = buildFramework(tempDir, {
      extraPlugins: [
        createFakeProviderPlugin(
          "fakeVoiceoverProvider",
          "voiceover",
          "fake",
          createFakeHandler({ costUsd: 0.1 })
        )
      ]
    });
    const app = framework.createApp();
    await app.start();

    try {
      // The ratified exit-code contract members (spec/13-cli.md).
      expect(EXIT_CODES).toMatchObject({
        ok: 0,
        failure: 1,
        validation: 2,
        usage: 3,
        paused: 4,
        budgetStop: 5
      });

      // Malformed YAML → validation error (explicit glob keeps files disjoint).
      await writeFile(path.join(tempDir, "bad.moku.yaml"), "items: [unclosed\n", "utf8");
      expect(await app.cli.dispatch(["validate", "bad.moku.yaml"])).toBe(EXIT_CODES.validation);

      // Unregistered provider fails at planning → run resolves { status: "failed" } → failure.
      await writeFile(
        path.join(tempDir, "ghost.moku.yaml"),
        buildFileYaml("ghost", [
          { task: "voiceover", provider: "ghost", input: { text: "hi", voice: "en-US-1" } }
        ]),
        "utf8"
      );
      expect(await app.cli.dispatch(["run", "ghost.moku.yaml"])).toBe(EXIT_CODES.failure);

      // Unknown command renders usage and returns the usage code — never throws.
      expect(await app.cli.dispatch(["nonsense-command"])).toBe(EXIT_CODES.usage);

      expect(processExitCalled).toBe(false);
    } finally {
      await app.stop();
    }
  });
});
