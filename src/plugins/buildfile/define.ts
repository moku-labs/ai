/**
 * @file defineBuild — typed build-file front-end (pure helper, no ctx).
 */
import { buildSpecSchema, firstIssueMessage } from "./schema";
import type { BuildSpec } from "./types";

/**
 * Validates a build spec literal through the same zod schema the YAML
 * loader uses, so a `defineBuild()` TS build file and a `*.moku.yaml` file
 * can never drift. This is the typed generation target for `compose --emit
 * script`; a TS build file's default export must be this function's
 * result. Pure factory — no ctx, no lifecycle, no side effects.
 *
 * @param spec - Build spec literal (author it inline or assign to a `const`).
 * @returns The same spec, validated by the schema.
 * @throws {Error} `[ai] Build file "<inline>" is invalid.` when `spec` fails validation.
 * @example
 * ```ts
 * export default defineBuild({ version: 1, name: "demo", items: [] });
 * ```
 */
export function defineBuild(spec: BuildSpec): BuildSpec {
  const result = buildSpecSchema.safeParse(spec);
  if (!result.success) {
    throw new Error(
      `[ai] Build file "<inline>" is invalid.\n  ${firstIssueMessage(result.error)}.`
    );
  }
  return result.data;
}
