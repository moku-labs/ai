/**
 * @file cli render — branded console composition (the MC1 seam).
 */
import type { BrandConsole } from "@moku-labs/common/cli";

/**
 * Composes the branded console for the `moku` CLI (respects plain mode,
 * NO_COLOR, and !TTY).
 *
 * @param _plain - Disable ANSI color/spinners.
 * @example
 * ```ts
 * const ui = createCliConsole(false);
 * ```
 */
export function createCliConsole(_plain: boolean): BrandConsole {
  throw new Error("not implemented");
}
