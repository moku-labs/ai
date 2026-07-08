/**
 * @file compose emitters — validated BuildSpec → YAML build file or defineBuild() script.
 */
import type { BuildSpec } from "../buildfile/types";

/**
 * Emits a validated build spec as *.moku.yaml text.
 *
 * @param _spec - Validated build spec.
 * @example
 * ```ts
 * const yamlText = emitYaml(spec);
 * ```
 */
export function emitYaml(_spec: BuildSpec): string {
  throw new Error("not implemented");
}

/**
 * Emits a validated build spec as a defineBuild() TypeScript script.
 *
 * @param _spec - Validated build spec.
 * @example
 * ```ts
 * const scriptText = emitScript(spec);
 * ```
 */
export function emitScript(_spec: BuildSpec): string {
  throw new Error("not implemented");
}
