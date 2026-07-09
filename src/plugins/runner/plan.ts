/**
 * @file runner planning — glob → item intents + canonical planning keys.
 * Resolves each build item's provider and handler (for cost estimation),
 * computes its planning key, and pairs the resulting `ItemIntent` with the
 * in-memory request payload (input/params — never journaled).
 */
import { createHash } from "node:crypto";
import type { BuildItem, CompiledBuild } from "../buildfile/types";
import type { ItemIntent } from "../journal/types";
import { registryPlugin } from "../registry";
import { resolveHandler } from "./pipeline";
import type { HandlerRequest, PlannedItem, RunnerContext } from "./types";

// eslint-disable-next-line unicorn/no-null -- ItemIntent.packVersion is typed `string | null`, matching the nullable SQL column (mirrors journal's SQL_NULL sentinel)
const NO_PACK_VERSION = null;

/**
 * Deep-sorts every object's keys (arrays keep their order) so structurally
 * equal values serialize identically regardless of key insertion order.
 *
 * @param value - Any JSON-serializable value.
 * @returns A structurally equivalent value with object keys sorted.
 * @example
 * ```ts
 * sortKeysDeep({ b: 1, a: 2 }); // => { a: 2, b: 1 }
 * ```
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => sortKeysDeep(item));
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).toSorted()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Serializes a value to key-order-independent canonical JSON.
 *
 * @param value - Any JSON-serializable value.
 * @returns The canonical JSON text.
 * @example
 * ```ts
 * canonicalJson({ task: "voiceover", input: { text: "hi" } });
 * ```
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * Hex-encoded sha256 digest of a UTF-8 string.
 *
 * @param text - Text to hash.
 * @returns The 64-character lowercase hex digest.
 * @example
 * ```ts
 * sha256Hex("hello");
 * ```
 */
function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Computes the canonical planning key for one build item: a key-order
 * independent sha256 over `{ task, input, params }`. Deliberately excludes
 * `provider` — planning-key identity is defined by task+input+params alone
 * (spec/06 pipeline step 1).
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
 * Expands compiled build files into planned items: for every item, resolves
 * its provider and handler, computes its planning key and cost estimate,
 * and pairs the resulting `ItemIntent` with its in-memory request and
 * effective `maxAttempts` (from the build file's `defaults.maxAttempts`,
 * falling back to `config.maxAttempts`).
 *
 * @param ctx - Runner domain context.
 * @param builds - Compiled build files from `buildfile.loadGlob`.
 * @returns One planned item per build item, in file then item order.
 * @example
 * ```ts
 * const planned = planItems(ctx, builds);
 * ```
 */
export function planItems(ctx: RunnerContext, builds: readonly CompiledBuild[]): PlannedItem[] {
  const planned: PlannedItem[] = [];

  for (const build of builds) {
    const maxAttempts = build.spec.defaults?.maxAttempts ?? ctx.config.maxAttempts;

    for (const item of build.spec.items) {
      const provider = resolveProvider(ctx, build, item);
      const handler = resolveHandler(ctx, item.task, provider);
      const request: HandlerRequest = { input: item.input, params: item.params ?? {} };
      const estimatedCostUsd = handler.estimate(request).usd;

      const intent: ItemIntent = {
        planningKey: planningKeyOf(item),
        buildFile: build.file,
        task: item.task,
        provider,
        packVersion: item.pack?.version ?? NO_PACK_VERSION,
        estimatedCostUsd
      };

      planned.push({ intent, request, maxAttempts });
    }
  }

  return planned;
}
