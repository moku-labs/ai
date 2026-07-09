/**
 * @file buildfile plugin — type definitions (BuildSpec = z.infer of the schema).
 */
import type { PluginCtx } from "@moku-labs/core";
import type { z } from "zod";
import type { buildItemSchema, buildSpecSchema } from "./schema";

/**
 * One build item — a single task invocation inside a `BuildSpec`. Inferred
 * directly from {@link buildItemSchema} so the runtime validator and the
 * static type can never drift.
 *
 * @example
 * ```ts
 * const item: BuildItem = {
 *   task: "voiceover",
 *   input: { text: "Hello, world!", voice: "en-US-1" }
 * };
 * ```
 */
export type BuildItem = z.infer<typeof buildItemSchema>;

/**
 * A whole build file's intermediate representation (IR) — the parsed,
 * validated shape of a `*.moku.yaml` file or a `defineBuild()` result.
 * Inferred directly from {@link buildSpecSchema}.
 *
 * @example
 * ```ts
 * const spec: BuildSpec = { version: 1, name: "demo", items: [] };
 * ```
 */
export type BuildSpec = z.infer<typeof buildSpecSchema>;

/**
 * buildfile plugin configuration: the default glob used when a run/validate
 * omits an explicit pattern, and where `moku new` writes the generated JSON
 * Schema for the modeline to point at.
 *
 * @example
 * ```ts
 * const config: Config = { defaultGlob: "**\/*.moku.yaml", schemaPath: ".moku/build.schema.json" };
 * ```
 */
export type Config = {
  /** Glob used when a run/validate is invoked without an explicit pattern. Default: "**\/*.moku.yaml". */
  defaultGlob: string;
  /** Where `moku new` writes the generated JSON Schema for the modeline to point at. Default: ".moku/build.schema.json". */
  schemaPath: string;
};

/**
 * The result of compiling one build file: its source label (file path, or
 * the synthetic `"<inline>"` label for inline text) and the validated
 * `BuildSpec`.
 *
 * @example
 * ```ts
 * const compiled: CompiledBuild = {
 *   file: "build.moku.yaml",
 *   spec: { version: 1, name: "demo", items: [] }
 * };
 * ```
 */
export type CompiledBuild = { file: string; spec: BuildSpec };

/**
 * Input to {@link BuildfileApi.compile}: either a file path (YAML or TS,
 * dispatched by extension) or inline YAML text.
 *
 * @example
 * ```ts
 * const byPath: BuildfileSource = { path: "build.moku.yaml" };
 * const byText: BuildfileSource = { text: "version: 1\nname: demo\nitems: []\n", lang: "yaml" };
 * ```
 */
export type BuildfileSource = { path: string } | { text: string; lang: "yaml" };

/**
 * Public API surface of the `buildfile` plugin, exposed as `app.buildfile`.
 * Parses and validates build files into the `BuildSpec` IR, generates the
 * matching JSON Schema, and renders the `moku new` starter template.
 *
 * @example
 * ```ts
 * const { spec } = await app.buildfile.compile({ path: "build.moku.yaml" });
 * ```
 */
export type BuildfileApi = {
  /**
   * Parses and validates one source into the `BuildSpec` IR. Expands
   * `itemsFrom` NDJSON (if present) into `spec.items`.
   *
   * @param source - A file path (YAML or TS) or inline YAML text.
   * @returns The source's label and its validated `BuildSpec`.
   */
  compile(source: BuildfileSource): Promise<CompiledBuild>;
  /**
   * Expands a glob (or the plugin's configured default) and compiles every
   * match, in deterministic (sorted) path order.
   *
   * @param pattern - Glob pattern; defaults to `config.defaultGlob`.
   * @returns One `CompiledBuild` per matched file, in sorted path order.
   */
  loadGlob(pattern?: string): Promise<CompiledBuild[]>;
  /**
   * The JSON Schema generated from `buildSpecSchema` via `z.toJSONSchema`,
   * for `moku new` to write and the modeline to point at.
   *
   * @returns The JSON Schema object.
   */
  jsonSchema(): Record<string, unknown>;
  /**
   * Renders starter build-file text for `moku new`: the
   * yaml-language-server modeline, the `$schema` key, a minimal valid
   * spec, and a commented example item per M0 task.
   *
   * @param opts - Template options.
   * @param opts.name - The `name:` field of the generated build file.
   * @returns The starter build-file text.
   */
  template(opts: { name: string }): string;
};

/**
 * Domain context type for the buildfile API factory: plugin config plus
 * empty state — buildfile is a stateless pure compiler (no `createState`).
 *
 * @example
 * ```ts
 * export const createBuildfileApi = (ctx: BuildfileContext): BuildfileApi => ({ ... });
 * ```
 */
export type BuildfileContext = PluginCtx<Config, Record<string, never>>;
