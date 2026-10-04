/**
 * @file buildfile zod schema — the single source of truth for the BuildSpec IR.
 */
import { z } from "zod";

/** Hint shown when an item puts `params` inside `input` instead of next to it. */
const PARAMS_INSIDE_INPUT_MESSAGE =
  "params go next to input, not inside it; move input.params to params";

/** Hint shown when an item id holds braces that are not one trailing nine-slice hint. */
const LABEL_HINT_MESSAGE = "only a trailing {nine=l,t,r,b} hint with whole-pixel insets is allowed";

/** The only id shape allowed to contain braces: a label, then one `{nine=l,t,r,b}` hint. */
const NINE_SLICE_ID = /^[^{}]+\{nine=\d+,\d+,\d+,\d+\}$/;

/**
 * Tells whether an item id carries an invalid label hint.
 *
 * @param id - The item id, or `undefined` when the item has none.
 * @returns `true` when the id contains `{` or `}` but is not `<label>{nine=l,t,r,b}`.
 * @example
 * ```ts
 * hasInvalidLabelHint("button{nine=12,12,12,12}"); // => false
 * hasInvalidLabelHint("button{nine=1.5,2,3,4}"); // => true
 * hasInvalidLabelHint("s01.key"); // => false
 * ```
 */
function hasInvalidLabelHint(id: string | undefined): boolean {
  if (id === undefined) return false;
  const hasBraces = id.includes("{") || id.includes("}");
  return hasBraces && !NINE_SLICE_ID.test(id);
}

/**
 * Zod schema for one build item.
 *
 * Refuses `input.params`: the runner builds the request as
 * `{ ...input, params }`, so a `params` key inside `input` would be
 * silently dropped. Refuses braces in `id` unless they form one trailing
 * nine-slice hint, `<label>{nine=l,t,r,b}` with whole-pixel insets; the
 * hint stays in the exported file name and the engine reads it there.
 * Both checks are runtime-only; the generated JSON Schema does not
 * express them.
 */
export const buildItemSchema = z
  .object({
    task: z.string(),
    id: z.string().optional(),
    provider: z.string().optional(),
    input: z.record(z.string(), z.unknown()),
    params: z.record(z.string(), z.unknown()).optional(),
    pack: z.object({ name: z.string(), version: z.string() }).optional()
  })
  .superRefine((item, refinement) => {
    if (hasInvalidLabelHint(item.id)) {
      refinement.addIssue({ code: "custom", path: ["id"], message: LABEL_HINT_MESSAGE });
    }

    const isMisplacedInInput = Object.hasOwn(item.input, "params");
    if (!isMisplacedInInput) return;

    refinement.addIssue({
      code: "custom",
      path: ["input", "params"],
      message: PARAMS_INSIDE_INPUT_MESSAGE
    });
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
