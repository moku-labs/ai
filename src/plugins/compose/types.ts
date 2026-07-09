/**
 * @file compose plugin — type definitions.
 */
import type { PluginCtx } from "@moku-labs/core";
import type { buildfilePlugin } from "../buildfile";
import type { BuildfileApi, BuildSpec } from "../buildfile/types";
import type { promptGenPlugin } from "../promptGen";
import type { PromptGenApi } from "../promptGen/types";

/**
 * compose plugin configuration: the promptGen provider used for generation,
 * and the repair-loop ceiling applied when model output fails IR
 * validation.
 *
 * @example
 * ```ts
 * const config: Config = { provider: "openai", maxRepairAttempts: 2 };
 * ```
 */
export type Config = {
  /** Provider passed to promptGen.generate. Default: "openai". */
  provider: string;
  /** Max regeneration attempts when the model output fails IR validation. Default: 2. */
  maxRepairAttempts: number;
};

/**
 * The result of {@link ComposeApi.compose}: the validated build spec, its
 * emitted text (YAML build-file text or a `defineBuild()` script, per
 * `opts.emit`), and the total cost accumulated across every
 * `promptGen.generate` call the repair loop made.
 *
 * @example
 * ```ts
 * const result: ComposeResult = {
 *   spec: { version: 1, name: "demo", items: [] },
 *   text: "version: 1\nname: demo\nitems: []\n",
 *   costUsd: 0.0004
 * };
 * ```
 */
export type ComposeResult = { spec: BuildSpec; text: string; costUsd: number };

/**
 * `ctx.require` narrowed to compose's two declared dependencies (buildfile,
 * promptGen), each resolving to its real API type. An intersection of two
 * concrete call signatures — the kernel's own generic `require` satisfies
 * both. Deliberately excludes `registry`: compose reaches prompt generation
 * exclusively through the `promptGen` facade (the audited registry cast
 * belongs to the owning task plugin, not compose — ratified decision).
 *
 * @example
 * ```ts
 * const requireDeps: ComposeRequire = ctx.require;
 * requireDeps(buildfilePlugin).jsonSchema();
 * ```
 */
export type ComposeRequire = ((plugin: typeof buildfilePlugin) => BuildfileApi) &
  ((plugin: typeof promptGenPlugin) => PromptGenApi);

/**
 * Domain context type for the compose API factory: plugin config plus empty
 * state (compose is a stateless orchestrator — no `createState`), plus
 * `require` narrowed to its two dependencies.
 *
 * @example
 * ```ts
 * export const createComposeApi = (ctx: ComposeContext): ComposeApi => ({ ... });
 * ```
 */
export type ComposeContext = PluginCtx<Config, Record<string, never>> & {
  require: ComposeRequire;
};

/**
 * Public API surface of the `compose` plugin, exposed as `app.compose`.
 *
 * @example
 * ```ts
 * const { spec, text } = await app.compose.compose({ prompt: "...", emit: "build" });
 * ```
 */
export type ComposeApi = {
  /**
   * Generates a build file from a natural-language prompt. Pipeline: system
   * prompt (embeds `buildfile.jsonSchema()` plus per-task input
   * documentation) → `promptGen.generate` → `buildfile.compile` (zod
   * validation) → on failure, re-prompt with the validation issue, bounded
   * by `config.maxRepairAttempts` additional attempts → emit. The returned
   * spec is always the one that passed `buildfile.compile` — compose can
   * never hand back an invalid build file. Never writes files; the `cli`
   * command writes the returned text.
   *
   * @param opts - Compose options.
   * @param opts.prompt - The natural-language build description.
   * @param opts.emit - `"build"` for YAML build-file text, `"script"` for a `defineBuild()` TS module.
   * @param opts.name - Overrides the generated spec's `name` field.
   * @param opts.signal - Optional abort signal forwarded to every `promptGen.generate` call.
   * @returns The validated spec, its emitted text, and the total generation cost.
   * @throws {Error} The pinned two-line error when every attempt fails IR validation.
   */
  compose(opts: {
    prompt: string;
    emit: "build" | "script";
    name?: string;
    signal?: AbortSignal;
  }): Promise<ComposeResult>;
};
