/**
 * @file runner planning — glob → item intents + canonical keys.
 * Resolves each build item's provider and handler (for cost estimation),
 * orders items by their `$ref` edges, hashes `$file` inputs, computes the
 * planning key and the artifact key, and pairs the resulting `ItemIntent`
 * with the in-memory request (the flat task request — never journaled).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { collectReferences, isFileValue, isReferenceValue } from "../buildfile";
import type { BuildItem, CompiledBuild } from "../buildfile/types";
import type { ItemIntent } from "../journal/types";
import { registryPlugin } from "../registry";
import { canonicalJson, sha256Hex } from "./keys";
import { resolveHandler } from "./pipeline";
import { mimeTypeOfPath } from "./resolve";
import type { HandlerRequest, PlannedItem, ResolvedFile, RunnerContext } from "./types";

// eslint-disable-next-line unicorn/no-null -- ItemIntent.packVersion is typed `string | null`, matching the nullable SQL column (mirrors journal's SQL_NULL sentinel)
const NO_PACK_VERSION = null;

/** Label given to a compiled build that came from inline text, not a file. */
const INLINE_SOURCE = "<inline>";

/** The two keys of an already-planned item that later items may `$ref`. */
type ItemKeys = { planningKey: string; artifactKey: string };

/**
 * Computes the canonical planning key for one build item with no references:
 * a key-order independent sha256 over `{ task, input, params }`. Deliberately
 * excludes `provider` (spec/06 pipeline step 1). Items with `$ref`/`$file`
 * inputs are keyed by {@link planItems}, which substitutes each reference
 * with its target's key or the file's hash first.
 *
 * @param item - Build item to key.
 * @returns The planning key.
 * @example
 * ```ts
 * const key = planningKeyOf(item);
 * ```
 */
export function planningKeyOf(item: BuildItem): string {
  return sha256Hex(
    canonicalJson({ task: item.task, input: item.input, params: item.params ?? {} })
  );
}

/**
 * Resolves an item's effective provider: its own `provider`, else the build
 * file's `defaults.provider`, else the task's first-registered (default)
 * provider.
 *
 * @param ctx - Runner domain context.
 * @param build - The compiled build file the item belongs to.
 * @param item - The build item to resolve a provider for.
 * @returns The resolved provider name.
 * @throws {Error} When no provider is set and none is registered for the task.
 * @example
 * ```ts
 * const provider = resolveProvider(ctx, build, item);
 * ```
 */
function resolveProvider(ctx: RunnerContext, build: CompiledBuild, item: BuildItem): string {
  const explicit = item.provider ?? build.spec.defaults?.provider;
  if (explicit) return explicit;

  const [defaultProvider] = ctx.require(registryPlugin).providers(item.task);
  if (!defaultProvider) {
    throw new Error(
      `[ai] No provider registered for task "${item.task}" (build file "${build.file}").\n  Register a provider via registry.register(), or set "provider" on the build item or its defaults.`
    );
  }
  return defaultProvider;
}

/**
 * Orders a build's items so every `$ref` target comes before the items that
 * reference it (a stable topological sort; buildfile already rejected cycles
 * and unknown targets).
 *
 * @param items - The build's items, in file order.
 * @returns The same items, dependencies first, otherwise in file order.
 * @example
 * ```ts
 * const ordered = orderByReferences(build.spec.items);
 * ```
 */
export function orderByReferences(items: readonly BuildItem[]): BuildItem[] {
  const byId = new Map<string, BuildItem>();
  for (const item of items) {
    if (item.id !== undefined) byId.set(item.id, item);
  }

  const ordered: BuildItem[] = [];
  const placed = new Set<BuildItem>();
  /**
   * Places an item after its `$ref` targets (depth-first).
   *
   * @param item - The item to place.
   * @example
   * ```ts
   * place(item);
   * ```
   */
  const place = (item: BuildItem): void => {
    if (placed.has(item)) return;
    placed.add(item);
    for (const target of collectReferences(item.input).refs) {
      const dependency = byId.get(target);
      if (dependency) place(dependency);
    }
    ordered.push(item);
  };

  for (const item of items) place(item);
  return ordered;
}

/**
 * Directory that `$file` paths of a build are relative to.
 *
 * @param build - The compiled build.
 * @returns The build file's directory, or the working directory for inline text.
 * @example
 * ```ts
 * buildDirectoryOf({ file: "series/e01.moku.yaml", spec }); // => "/abs/series"
 * ```
 */
function buildDirectoryOf(build: CompiledBuild): string {
  return build.file === INLINE_SOURCE ? process.cwd() : path.dirname(path.resolve(build.file));
}

/**
 * Reads and hashes every `$file` of one item. Hashes are cached per absolute
 * path so a reference sheet used by twenty items is read once.
 *
 * @param item - The build item.
 * @param buildDirectory - Directory relative paths resolve against.
 * @param cache - Resolved files by absolute path, shared across the plan.
 * @param label - The item's label, for the error message.
 * @param buildFile - The build file, for the error message.
 * @returns Resolved files keyed by the path as written in the build file.
 * @throws {Error} When a `$file` does not exist.
 * @example
 * ```ts
 * const files = await resolveItemFiles(item, dir, cache, "e01.s01", "e01.moku.yaml");
 * ```
 */
async function resolveItemFiles(
  item: BuildItem,
  buildDirectory: string,
  cache: Map<string, ResolvedFile>,
  label: string,
  buildFile: string
): Promise<Map<string, ResolvedFile>> {
  const files = new Map<string, ResolvedFile>();

  for (const written of collectReferences(item.input).files) {
    const absolute = path.resolve(buildDirectory, written);
    const cached = cache.get(absolute);
    if (cached) {
      files.set(written, cached);
      continue;
    }

    const bytes = await readFile(absolute).catch(() => {
      throw new Error(
        `[ai] File not found: ${absolute}.\n  Referenced by item "${label}" in "${buildFile}".`
      );
    });
    const resolved: ResolvedFile = {
      path: absolute,
      mimeType: mimeTypeOfPath(absolute),
      hash: sha256Hex(bytes)
    };
    cache.set(absolute, resolved);
    files.set(written, resolved);
  }

  return files;
}

/**
 * Copies an input value, replacing each `{ $ref: id }` with the target's key
 * and each `{ $file: path }` with the file's content hash — so a key changes
 * exactly when something the item consumes changes.
 *
 * @param value - The item input, or any nested part of it.
 * @param refKey - Key for a `$ref` target id.
 * @param files - Resolved files by path as written.
 * @returns The keyed copy of `value`.
 * @example
 * ```ts
 * keyedInput(item.input, id => keys.get(id)?.planningKey, files);
 * ```
 */
function keyedInput(
  value: unknown,
  refKey: (id: string) => string | undefined,
  files: ReadonlyMap<string, ResolvedFile>
): unknown {
  if (isReferenceValue(value)) return { $ref: refKey(String(value.$ref)) ?? String(value.$ref) };
  if (isFileValue(value)) return { $file: files.get(String(value.$file))?.hash ?? "" };
  if (Array.isArray(value)) return value.map(entry => keyedInput(entry, refKey, files));
  if (typeof value === "object" && value !== null) {
    const keyed: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) keyed[key] = keyedInput(entry, refKey, files);
    return keyed;
  }
  return value;
}

/**
 * Builds an item's label: its `id`, else `<NN>-<task>` from its 1-based
 * position in the build file.
 *
 * @param item - The build item.
 * @param index - Zero-based position in the build file.
 * @returns The label.
 * @example
 * ```ts
 * labelOf({ task: "voiceover", input: {} }, 2); // => "03-voiceover"
 * ```
 */
function labelOf(item: BuildItem, index: number): string {
  return item.id ?? `${String(index + 1).padStart(2, "0")}-${item.task}`;
}

/**
 * Plans the items of one compiled build, dependencies first.
 *
 * @param ctx - Runner domain context.
 * @param build - The compiled build.
 * @param fileCache - Resolved files by absolute path, shared across builds.
 * @returns One planned item per build item.
 * @example
 * ```ts
 * const planned = await planBuild(ctx, build, new Map());
 * ```
 */
async function planBuild(
  ctx: RunnerContext,
  build: CompiledBuild,
  fileCache: Map<string, ResolvedFile>
): Promise<PlannedItem[]> {
  const maxAttempts = build.spec.defaults?.maxAttempts ?? ctx.config.maxAttempts;
  const buildDirectory = buildDirectoryOf(build);
  const positions = new Map(build.spec.items.map((item, index) => [item, index] as const));
  const keysById = new Map<string, ItemKeys>();
  const planned: PlannedItem[] = [];

  for (const item of orderByReferences(build.spec.items)) {
    const label = labelOf(item, positions.get(item) ?? 0);
    const provider = resolveProvider(ctx, build, item);
    const packVersion = item.pack?.version ?? NO_PACK_VERSION;
    const params = item.params ?? {};
    const files = await resolveItemFiles(item, buildDirectory, fileCache, label, build.file);

    // Keys: references are replaced by their target's key (or the file hash).
    const planningInput = keyedInput(item.input, id => keysById.get(id)?.planningKey, files);
    const artifactInput = keyedInput(item.input, id => keysById.get(id)?.artifactKey, files);
    const keys: ItemKeys = {
      planningKey: sha256Hex(canonicalJson({ task: item.task, input: planningInput, params })),
      artifactKey: sha256Hex(
        canonicalJson({ task: item.task, provider, packVersion, input: artifactInput, params })
      )
    };
    if (item.id !== undefined) keysById.set(item.id, keys);

    // The flat task request, estimated on its unresolved form.
    const request: HandlerRequest = { ...item.input, params };
    const estimatedCostUsd = resolveHandler(ctx, item.task, provider).estimate(request).usd;

    const refKeys = new Map<string, string>();
    for (const target of collectReferences(item.input).refs) {
      const targetKeys = keysById.get(target);
      if (targetKeys) refKeys.set(target, targetKeys.planningKey);
    }

    const intent: ItemIntent = {
      planningKey: keys.planningKey,
      buildFile: build.file,
      task: item.task,
      provider,
      packVersion,
      estimatedCostUsd,
      label,
      buildName: build.spec.name,
      artifactKey: keys.artifactKey
    };
    planned.push({ intent, request, maxAttempts, refKeys, files });
  }

  return planned;
}

/**
 * Expands compiled build files into planned items: for every item, resolves
 * its provider and handler, hashes its `$file` inputs, computes its planning
 * and artifact keys and cost estimate, and pairs the resulting `ItemIntent`
 * with its flat request and effective `maxAttempts` (from the build file's
 * `defaults.maxAttempts`, falling back to `config.maxAttempts`). Within a
 * build, `$ref` targets are planned before the items that use them.
 *
 * @param ctx - Runner domain context.
 * @param builds - Compiled build files from `buildfile.loadGlob`.
 * @returns One planned item per build item, file by file.
 * @throws {Error} When a provider cannot be resolved or a `$file` is missing.
 * @example
 * ```ts
 * const planned = await planItems(ctx, builds);
 * ```
 */
export async function planItems(
  ctx: RunnerContext,
  builds: readonly CompiledBuild[]
): Promise<PlannedItem[]> {
  const fileCache = new Map<string, ResolvedFile>();
  const planned: PlannedItem[] = [];
  for (const build of builds) {
    planned.push(...(await planBuild(ctx, build, fileCache)));
  }
  return planned;
}
