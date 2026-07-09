/**
 * @file narration template pack — versioned data module (NOT a plugin).
 *
 * Packs bundle provider param presets for a named "look" — here, narration
 * voiceover. `voiceover/api.ts`'s internal `mergePackParams` merges a pack's
 * per-provider `values` under a request's own `params` (request wins) —
 * see spec/07's ratified OQ5.
 */

/**
 * The M0 narration template pack: per-provider param presets, keyed by
 * provider name. `version` participates in artifact identity — bump it
 * whenever `values` changes so cached/journaled artifacts invalidate
 * correctly.
 *
 * @example
 * ```ts
 * import { narrationPack } from "./packs/narration";
 * narrationPack.values.elevenlabs; // per-provider preset, once populated
 * ```
 */
export const narrationPack = {
  name: "narration",
  version: "1.0.0",
  values: {}
} as const;
