/**
 * @file defineBuild — typed build-file front-end (pure helper, no ctx).
 */
import type { BuildSpec } from "./types";

/**
 * Validates and returns a typed build spec — the TS front-end equivalent of
 * a *.moku.yaml file, and the generation target for `compose --emit script`.
 *
 * @param _spec - Build spec literal.
 * @example
 * ```ts
 * export default defineBuild({ version: 1, name: "demo", items: [] });
 * ```
 */
export function defineBuild(_spec: BuildSpec): BuildSpec {
  throw new Error("not implemented");
}
