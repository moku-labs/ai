/**
 * @file buildfile references — `{ $ref: "<item id>" }` and `{ $file: "<path>" }`
 * input values: discovery, and the offline checks `compile()` runs (unknown
 * target, duplicate id, cycle, malformed value).
 */
import type { BuildItem } from "./types";

/** Every `$ref` target and `$file` path found inside one value. */
export type CollectedReferences = { refs: string[]; files: string[] };

/**
 * Whether `value` is a `{ $ref }` object (exactly one key).
 *
 * @param value - Any input value.
 * @returns True for `{ $ref: ... }`.
 * @example
 * ```ts
 * isReferenceValue({ $ref: "key" }); // => true
 * ```
 */
export function isReferenceValue(value: unknown): value is { $ref: unknown } {
  return isSingleKeyObject(value, "$ref");
}

/**
 * Whether `value` is a `{ $file }` object (exactly one key).
 *
 * @param value - Any input value.
 * @returns True for `{ $file: ... }`.
 * @example
 * ```ts
 * isFileValue({ $file: "refs/a.png" }); // => true
 * ```
 */
export function isFileValue(value: unknown): value is { $file: unknown } {
  return isSingleKeyObject(value, "$file");
}

/**
 * Whether `value` is a plain object with exactly the one key `key`.
 *
 * @param value - Any value.
 * @param key - The single expected key.
 * @returns True when `value` is `{ [key]: unknown }`.
 * @example
 * ```ts
 * isSingleKeyObject({ $ref: "a" }, "$ref"); // => true
 * ```
 */
function isSingleKeyObject(value: unknown, key: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === key;
}

/**
 * Walks a value (nested objects and arrays) and collects every `$ref` target
 * and `$file` path, in document order. Malformed (non-string) values are
 * collected as their `String()` form so the caller can report them.
 *
 * @param value - An item `input` or any nested part of it.
 * @returns The `$ref` targets and `$file` paths found.
 * @example
 * ```ts
 * collectReferences({ image: { $ref: "key" }, refs: [{ $file: "a.png" }] });
 * // => { refs: ["key"], files: ["a.png"] }
 * ```
 */
export function collectReferences(value: unknown): CollectedReferences {
  const found: CollectedReferences = { refs: [], files: [] };
  walk(value, found);
  return found;
}

/**
 * Recursive worker for {@link collectReferences}.
 *
 * @param value - The value to walk.
 * @param found - Accumulator, mutated in place.
 * @example
 * ```ts
 * walk(input, found);
 * ```
 */
function walk(value: unknown, found: CollectedReferences): void {
  if (isReferenceValue(value)) {
    found.refs.push(String(value.$ref));
    return;
  }
  if (isFileValue(value)) {
    found.files.push(String(value.$file));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, found);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) walk(entry, found);
  }
}

/**
 * Finds the first malformed reference value (`$ref`/`$file` that is not a
 * non-empty string) inside a value.
 *
 * @param value - An item `input`.
 * @returns The offending key (`"$ref"` or `"$file"`), or undefined.
 * @example
 * ```ts
 * findMalformedReference({ image: { $ref: 3 } }); // => "$ref"
 * ```
 */
function findMalformedReference(value: unknown): "$ref" | "$file" | undefined {
  if (isReferenceValue(value)) return isNonEmptyString(value.$ref) ? undefined : "$ref";
  if (isFileValue(value)) return isNonEmptyString(value.$file) ? undefined : "$file";

  for (const child of childrenOf(value)) {
    const malformed = findMalformedReference(child);
    if (malformed) return malformed;
  }
  return undefined;
}

/**
 * The direct children of a value: array entries, object values, or none.
 *
 * @param value - Any value.
 * @returns The children to walk.
 * @example
 * ```ts
 * childrenOf({ a: 1, b: [2] }); // => [1, [2]]
 * ```
 */
function childrenOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && value !== null) return Object.values(value);
  return [];
}

/**
 * Whether a value is a non-empty string.
 *
 * @param value - Any value.
 * @returns True for a string with at least one character.
 * @example
 * ```ts
 * isNonEmptyString("a"); // => true
 * ```
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Checks the `$ref` graph of one build file: ids are unique, every `$ref`
 * names an existing id, reference values are well-formed, and there is no
 * cycle. Returns the first problem as the detail half of the build-file
 * error (`"<path>: <message>"`), or undefined when the graph is valid.
 *
 * @param items - The build file's items.
 * @returns The first problem, or undefined.
 * @example
 * ```ts
 * const problem = checkReferenceGraph(spec.items);
 * if (problem) throw buildFileInvalidError(label, problem);
 * ```
 */
export function checkReferenceGraph(items: readonly BuildItem[]): string | undefined {
  const ids = new Map<string, number>();

  // Ids are unique.
  for (const [index, item] of items.entries()) {
    if (item.id === undefined) continue;
    if (ids.has(item.id)) return `items.${index}.id: duplicate id "${item.id}"`;
    ids.set(item.id, index);
  }

  // Reference values are well formed and point at existing ids.
  for (const [index, item] of items.entries()) {
    const malformed = findMalformedReference(item.input);
    if (malformed) return `items.${index}.input: ${malformed} must be a non-empty string`;
    for (const target of collectReferences(item.input).refs) {
      if (!ids.has(target)) return `items.${index}.input: unknown $ref "${target}"`;
    }
  }

  return findCycle(items);
}

/**
 * Depth-first search for a `$ref` cycle among items with ids.
 *
 * @param items - The build file's items (ids already known unique and valid).
 * @returns `"items: $ref cycle a -> b -> a"`, or undefined.
 * @example
 * ```ts
 * findCycle(items);
 * ```
 */
function findCycle(items: readonly BuildItem[]): string | undefined {
  const edges = new Map<string, string[]>();
  for (const item of items) {
    if (item.id !== undefined) edges.set(item.id, collectReferences(item.input).refs);
  }

  const done = new Set<string>();
  const onPath: string[] = [];

  /**
   * Visits one id depth-first, tracking the current path.
   *
   * @param id - The item id to visit.
   * @returns The cycle as `a -> b -> a`, or undefined.
   * @example
   * ```ts
   * visit("e01.key");
   * ```
   */
  const visit = (id: string): string | undefined => {
    const cycleStart = onPath.indexOf(id);
    if (cycleStart !== -1) return [...onPath.slice(cycleStart), id].join(" -> ");
    if (done.has(id)) return undefined;

    onPath.push(id);
    for (const next of edges.get(id) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    onPath.pop();
    done.add(id);
    return undefined;
  };

  for (const id of edges.keys()) {
    const cycle = visit(id);
    if (cycle) return `items: $ref cycle ${cycle}`;
  }
  return undefined;
}
