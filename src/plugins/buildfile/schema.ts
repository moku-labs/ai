/**
 * @file buildfile zod schema — the single source of truth for the BuildSpec IR.
 */
import { z } from "zod";

/** Zod schema for one build item. */
export const buildItemSchema = z.object({
  task: z.string(),
  id: z.string().optional(),
  provider: z.string().optional(),
  input: z.record(z.string(), z.unknown()),
  params: z.record(z.string(), z.unknown()).optional(),
  pack: z.object({ name: z.string(), version: z.string() }).optional()
});

/** Zod schema for a whole build file (IR). */
export const buildSpecSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  defaults: z
    .object({ provider: z.string().optional(), maxAttempts: z.number().optional() })
    .optional(),
  items: z.array(buildItemSchema),
  itemsFrom: z.string().optional()
});

/**
 * Formats the first issue of a failed {@link buildSpecSchema} or
 * {@link buildItemSchema} parse as `"<dotted path>: <message>"` — the
 * detail half of the project's pinned two-line build-file error format
 * (`[ai] Build file "<path>" is invalid.\n  <detail>.`). Callers append
 * their own closing period; this never adds one.
 *
 * @param error - The zod validation error from a failed `safeParse`.
 * @returns The first issue's dotted path (or `"(root)"` for a top-level
 *   issue) followed by its message.
 * @example
 * ```ts
 * const result = buildSpecSchema.safeParse(raw);
 * if (!result.success) {
 *   throw new Error(`[ai] Build file "build.yaml" is invalid.\n  ${firstIssueMessage(result.error)}.`);
 * }
 * ```
 */
export function firstIssueMessage(error: z.ZodError): string {
  const [issue] = error.issues;
  if (!issue) return "(unknown validation issue)";
  const issuePath = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return `${issuePath}: ${issue.message}`;
}
