/**
 * @file buildfile plugin — API factory (`app.buildfile.*`).
 *
 * Compiles YAML/TS build files into the zod-validated `BuildSpec` IR,
 * expands `itemsFrom` NDJSON, generates the matching JSON Schema, and
 * renders the `moku new` starter template — all derived from the single
 * schema in `schema.ts`. `registry` is deliberately NOT consulted here:
 * provider existence is checked at dispatch by the runner, so `moku
 * validate` works offline.
 */
import { glob, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { buildItemSchema, buildSpecSchema, firstIssueMessage } from "./schema";
import type {
  BuildfileApi,
  BuildfileContext,
  BuildfileSource,
  BuildItem,
  CompiledBuild
} from "./types";

/**
 * Builds the project's pinned two-line "build file is invalid" error.
 *
 * @param label - Human-readable source label (a file path, or `"<inline>"`).
 * @param detail - The issue detail (dotted path + message), no trailing period.
 * @returns A two-line `Error` in the `[ai] Build file "<label>" is invalid.\n  <detail>.` format.
 * @example
 * ```ts
 * throw buildFileInvalidError("build.moku.yaml", firstIssueMessage(result.error));
 * ```
 */
function buildFileInvalidError(label: string, detail: string): Error {
  return new Error(`[ai] Build file "${label}" is invalid.\n  ${detail}.`);
}

/**
 * Builds the two-line "nothing matched" error for an empty glob expansion.
 *
 * @param pattern - The glob pattern that matched no files.
 * @returns A two-line `Error` suggesting `moku new`.
 * @example
 * ```ts
 * throw noMatchesError("**\/*.moku.yaml");
 * ```
 */
function noMatchesError(pattern: string): Error {
  return new Error(`[ai] No build files matched "${pattern}".\n  Run "moku new" to create one.`);
}

/**
 * Derives the human-readable label used in error messages for a source.
 *
 * @param source - The compile source (file path or inline text).
 * @returns `source.path` for a path source, or `"<inline>"` for inline text.
 * @example
 * ```ts
 * sourceLabel({ text: "version: 1\n", lang: "yaml" }); // => "<inline>"
 * ```
 */
function sourceLabel(source: BuildfileSource): string {
  return "path" in source ? source.path : "<inline>";
}

/**
 * Reads and parses one source into its raw (pre-validation) value, plus the
 * directory `itemsFrom` NDJSON paths should be resolved against. YAML
 * sources are parsed with the `yaml` package; `.ts` path sources are
 * dynamically imported and their `default` export is used as the raw value.
 *
 * @param source - The compile source (file path or inline text).
 * @returns The raw parsed value and the source's containing directory.
 * @example
 * ```ts
 * const { raw, dir } = await readSource({ path: "build.moku.yaml" });
 * ```
 */
async function readSource(source: BuildfileSource): Promise<{ raw: unknown; dir: string }> {
  if ("text" in source) {
    return { raw: parseYaml(source.text), dir: process.cwd() };
  }

  const resolvedPath = path.resolve(source.path);
  const dir = path.dirname(resolvedPath);

  if (resolvedPath.endsWith(".ts")) {
    const imported: { default?: unknown } = await import(pathToFileURL(resolvedPath).href);
    return { raw: imported.default, dir };
  }

  const text = await readFile(resolvedPath, "utf8");
  return { raw: parseYaml(text), dir };
}

/**
 * Parses one NDJSON line as JSON, wrapping a syntax error in the project's
 * pinned two-line build-file error format with the offending line number.
 *
 * @param line - The trimmed, non-empty NDJSON line.
 * @param lineNumber - The line's 1-based line number in the NDJSON file.
 * @param label - The owning build file's error label.
 * @returns The parsed (not yet schema-validated) JSON value.
 * @throws {Error} When `line` is not valid JSON.
 * @example
 * ```ts
 * const parsed = parseNdjsonJson('{"task":"voiceover","input":{}}', 1, "build.moku.yaml");
 * ```
 */
function parseNdjsonJson(line: string, lineNumber: number, label: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw buildFileInvalidError(label, `itemsFrom line ${lineNumber}: ${message}`);
  }
}

/**
 * Parses and schema-validates one NDJSON line into a `BuildItem`.
 *
 * @param line - The trimmed, non-empty NDJSON line.
 * @param lineNumber - The line's 1-based line number in the NDJSON file.
 * @param label - The owning build file's error label.
 * @returns The validated `BuildItem`.
 * @throws {Error} When the line is malformed JSON or fails `buildItemSchema`.
 * @example
 * ```ts
 * const item = parseNdjsonLine('{"task":"voiceover","input":{}}', 1, "build.moku.yaml");
 * ```
 */
function parseNdjsonLine(line: string, lineNumber: number, label: string): BuildItem {
  const parsed = parseNdjsonJson(line, lineNumber, label);
  const result = buildItemSchema.safeParse(parsed);
  if (!result.success) {
    throw buildFileInvalidError(
      label,
      `itemsFrom line ${lineNumber}: ${firstIssueMessage(result.error)}`
    );
  }
  return result.data;
}

/**
 * Reads and expands an `itemsFrom` NDJSON file (one `BuildItem` per line,
 * blank lines skipped) into an array of validated items.
 *
 * @param itemsFrom - The `itemsFrom` path from the compiled spec, relative to `dir`.
 * @param dir - The owning build file's containing directory.
 * @param label - The owning build file's error label.
 * @returns The validated items read from the NDJSON file, in file order.
 * @example
 * ```ts
 * const items = await expandItemsFrom("extra.ndjson", "/repo/builds", "build.moku.yaml");
 * ```
 */
async function expandItemsFrom(
  itemsFrom: string,
  dir: string,
  label: string
): Promise<BuildItem[]> {
  const ndjsonPath = path.resolve(dir, itemsFrom);
  const text = await readFile(ndjsonPath, "utf8");
  const items: BuildItem[] = [];

  for (const [index, line] of text.split("\n").entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    items.push(parseNdjsonLine(trimmed, index + 1, label));
  }

  return items;
}

/**
 * Parses and validates one source into the `BuildSpec` IR, expanding
 * `itemsFrom` NDJSON (if present) into `spec.items`.
 *
 * @param source - A file path (YAML or TS) or inline YAML text.
 * @returns The source's label and its validated `BuildSpec`.
 * @throws {Error} The pinned two-line error when validation fails.
 * @example
 * ```ts
 * const { spec } = await compileSource({ path: "build.moku.yaml" });
 * ```
 */
async function compileSource(source: BuildfileSource): Promise<CompiledBuild> {
  const label = sourceLabel(source);
  const { raw, dir } = await readSource(source);

  const result = buildSpecSchema.safeParse(raw);
  if (!result.success) {
    throw buildFileInvalidError(label, firstIssueMessage(result.error));
  }

  const { itemsFrom } = result.data;
  if (itemsFrom === undefined) {
    return { file: label, spec: result.data };
  }

  const extraItems = await expandItemsFrom(itemsFrom, dir, label);
  return { file: label, spec: { ...result.data, items: [...result.data.items, ...extraItems] } };
}

/**
 * Expands a glob pattern into its matched file paths, sorted for
 * deterministic ordering (glob enumeration order is not guaranteed to be
 * stable across platforms or filesystems).
 *
 * @param pattern - The glob pattern to expand.
 * @returns The matched absolute or relative paths, sorted ascending.
 * @example
 * ```ts
 * const matches = await collectGlobMatches("**\/*.moku.yaml");
 * ```
 */
async function collectGlobMatches(pattern: string): Promise<string[]> {
  const matches: string[] = [];
  for await (const match of glob(pattern)) {
    matches.push(match);
  }
  return matches.toSorted();
}

/**
 * Expands `pattern` and compiles every match, in deterministic path order.
 *
 * @param pattern - The glob pattern to expand and compile.
 * @returns One `CompiledBuild` per matched file, in sorted path order.
 * @throws {Error} A two-line error suggesting `moku new` when nothing matches.
 * @example
 * ```ts
 * const builds = await loadGlobMatches("**\/*.moku.yaml");
 * ```
 */
async function loadGlobMatches(pattern: string): Promise<CompiledBuild[]> {
  const matches = await collectGlobMatches(pattern);
  if (matches.length === 0) {
    throw noMatchesError(pattern);
  }
  return Promise.all(matches.map(match => compileSource({ path: match })));
}

/**
 * Generates the JSON Schema for `BuildSpec` from `buildSpecSchema` via
 * `z.toJSONSchema`, so the runtime validator and the schema `moku new`
 * writes for editor autocomplete can never drift.
 *
 * @returns The JSON Schema object.
 * @example
 * ```ts
 * const schema = computeJsonSchema();
 * ```
 */
function computeJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(buildSpecSchema);
}

/**
 * Renders the starter build-file text for `moku new`: BOTH the
 * yaml-language-server modeline and the `$schema:` key (only the modeline
 * comment activates editor autocomplete — the `$schema:` key alone does
 * not — so both are emitted from this one source), a minimal valid spec,
 * and one commented example item per M0 task (voiceover, translate,
 * prompt-gen).
 *
 * @param name - The `name:` field of the generated build file.
 * @param schemaPath - Path the modeline and `$schema:` key should point at.
 * @returns The starter build-file text; itself a valid build file.
 * @example
 * ```ts
 * renderTemplate("demo", ".moku/build.schema.json");
 * ```
 */
function renderTemplate(name: string, schemaPath: string): string {
  const quotedName = JSON.stringify(name);
  return `# yaml-language-server: $schema=${schemaPath}
$schema: ${schemaPath}
version: 1
name: ${quotedName}
items: []

# Example items — uncomment and edit to use:
#
# - task: voiceover
#   input:
#     text: "Hello, world!"
#     voice: "en-US-1"
#
# - task: translate
#   input:
#     text: "Hello, world!"
#     targetLang: "es"
#
# - task: prompt-gen
#   input:
#     prompt: "Describe a sunset over the ocean."
`;
}

/**
 * Creates the buildfile API surface (`app.buildfile.*`).
 *
 * @param ctx - Plugin context (config only — buildfile is stateless).
 * @returns The `app.buildfile` API.
 * @example
 * ```ts
 * const api = createBuildfileApi(ctx);
 * const { spec } = await api.compile({ path: "build.moku.yaml" });
 * ```
 */
export function createBuildfileApi(ctx: BuildfileContext): BuildfileApi {
  /**
   * Expands the given (or configured default) glob and compiles every
   * match, bound to this API's configuration.
   *
   * @param pattern - Glob pattern; defaults to `ctx.config.defaultGlob`.
   * @returns One `CompiledBuild` per matched file, in sorted path order.
   * @example
   * ```ts
   * const builds = await api.loadGlob();
   * ```
   */
  const boundLoadGlob = (pattern?: string): Promise<CompiledBuild[]> =>
    loadGlobMatches(pattern ?? ctx.config.defaultGlob);

  /**
   * Renders starter build-file text for `moku new`, bound to this API's
   * configured schema path.
   *
   * @param opts - Template options.
   * @param opts.name - The `name:` field of the generated build file.
   * @returns The starter build-file text.
   * @example
   * ```ts
   * const text = api.template({ name: "demo" });
   * ```
   */
  const boundTemplate = (opts: { name: string }): string =>
    renderTemplate(opts.name, ctx.config.schemaPath);

  return {
    compile: compileSource,
    loadGlob: boundLoadGlob,
    jsonSchema: computeJsonSchema,
    template: boundTemplate
  };
}
