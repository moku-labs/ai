/**
 * @file runner keys — canonical JSON + sha256, the shared primitives behind
 * planning keys and artifact keys (used by plan.ts and pipeline.ts).
 */
import { createHash } from "node:crypto";

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
export function sortKeysDeep(value: unknown): unknown {
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
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * Hex-encoded sha256 digest of a UTF-8 string or raw bytes.
 *
 * @param content - Text or bytes to hash.
 * @returns The 64-character lowercase hex digest.
 * @example
 * ```ts
 * sha256Hex("hello");
 * ```
 */
export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
