/**
 * @file runner planning — glob → item intents + canonical planning keys skeleton.
 */
import type { BuildItem, CompiledBuild } from "../buildfile/types";
import type { ItemIntent } from "../journal/types";

/**
 * Expands compiled build files into journal item intents (with planning keys
 * and per-item cost estimates).
 *
 * @param _builds - Compiled build files from buildfile.loadGlob.
 * @example
 * ```ts
 * const intents = planItems(builds);
 * ```
 */
export function planItems(_builds: readonly CompiledBuild[]): ItemIntent[] {
  throw new Error("not implemented");
}

/**
 * Computes the canonical planning key for one build item (key-order
 * independent sha256 over task/provider/input/params/pack).
 *
 * @param _item - Build item to key.
 * @example
 * ```ts
 * const key = planningKeyOf(item);
 * ```
 */
export function planningKeyOf(_item: BuildItem): string {
  throw new Error("not implemented");
}
