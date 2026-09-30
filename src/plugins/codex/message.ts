/**
 * @file codex message helpers — pure text pieces the error messages of
 * `cli.ts` and `prompt/` share. Private: `errors.ts` is the public
 * `CodexErrors` namespace and holds the error classes only.
 */

/** Second line of every "look at it by hand" error. */
export const BY_HAND = "Run the same codex exec by hand to see the full output.";

/**
 * Drops trailing periods, so a message line ends with exactly one.
 *
 * @param text - A message fragment.
 * @returns The fragment without trailing periods.
 * @example
 * ```ts
 * withoutPeriod("is not permitted."); // => "is not permitted"
 * ```
 */
export function withoutPeriod(text: string): string {
  let result = text;
  while (result.endsWith(".")) result = result.slice(0, -1);
  return result;
}
