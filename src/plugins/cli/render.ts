/**
 * @file cli render — branded console composition (the MC1 seam).
 */

import type { BrandConsole } from "@moku-labs/common/cli";
import { createBrandConsole } from "@moku-labs/common/cli";

/**
 * Composes the branded console for the `moku` CLI. Every command renders
 * exclusively through the returned console (MC1) — no hand-rolled ANSI
 * escapes, box-drawing, or spinner animations anywhere in the plugin.
 *
 * @param plain - Disable ANSI color/spinners (already resolved by the caller
 *   from `config.plain`, TTY detection, and `NO_COLOR`).
 * @returns The branded console, colorized unless `plain` is true.
 * @example
 * ```ts
 * const ui = createCliConsole(false);
 * ui.lockup({ wordmark: "moku ai" });
 * ```
 */
export function createCliConsole(plain: boolean): BrandConsole {
  return createBrandConsole({ color: !plain });
}
