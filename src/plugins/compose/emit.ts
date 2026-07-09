/**
 * @file compose emitters — validated BuildSpec → YAML build file or defineBuild() script.
 */
import { stringify as stringifyYaml } from "yaml";
import type { BuildSpec } from "../buildfile/types";

const DEFINE_BUILD_IMPORT = 'import { defineBuild } from "@moku-labs/ai";';
const MODELINE_PATTERN = /^# yaml-language-server: \$schema=(.+)$/;

/**
 * Extracts the `$schema=<path>` target from a rendered buildfile template
 * (`BuildfileApi.template()`'s first line, the yaml-language-server
 * modeline). Lets compose's own YAML emission point at whatever schema path
 * `buildfile` is actually configured with, without duplicating that config
 * onto compose's own `Config` (see `src/plugins/buildfile/api.ts`'s
 * `renderTemplate` for the format this reads).
 *
 * @param templateText - Any text rendered by `BuildfileApi.template()`.
 * @returns The schema path from the modeline's `$schema=` target.
 * @throws {Error} When `templateText` doesn't start with the expected modeline.
 * @example
 * ```ts
 * schemaPathFromTemplate(buildfile.template({ name: "demo" })); // ".moku/build.schema.json"
 * ```
 */
export function schemaPathFromTemplate(templateText: string): string {
  const [modeline] = templateText.split("\n");
  const match = modeline === undefined ? undefined : MODELINE_PATTERN.exec(modeline);

  if (match?.[1] === undefined) {
    throw new Error(
      "[ai] Compose could not derive a schema path from buildfile.template().\n  Ensure buildfile.template() still starts with the yaml-language-server modeline."
    );
  }

  return match[1];
}

/**
 * Emits a validated build spec as `*.moku.yaml` text: the
 * yaml-language-server modeline, the `$schema:` key, then the spec body —
 * the same conventions `buildfile.template()` uses for `moku new`.
 *
 * @param spec - Validated build spec.
 * @param schemaPath - Schema path for the modeline and `$schema:` key (see {@link schemaPathFromTemplate}).
 * @returns The build-file YAML text.
 * @example
 * ```ts
 * const yamlText = emitYaml(spec, ".moku/build.schema.json");
 * ```
 */
export function emitYaml(spec: BuildSpec, schemaPath: string): string {
  const modeline = `# yaml-language-server: $schema=${schemaPath}`;
  const schemaKey = `$schema: ${schemaPath}`;
  const body = stringifyYaml(spec).trimEnd();

  return `${modeline}\n${schemaKey}\n${body}\n`;
}

/**
 * Emits a validated build spec as a `defineBuild()` TypeScript module — the
 * typed generation target for `compose --emit script`.
 *
 * @param spec - Validated build spec.
 * @returns The build-file TypeScript module text.
 * @example
 * ```ts
 * const scriptText = emitScript(spec);
 * ```
 */
export function emitScript(spec: BuildSpec): string {
  const specLiteral = JSON.stringify(spec, undefined, 2);

  return `${DEFINE_BUILD_IMPORT}\n\nexport default defineBuild(${specLiteral});\n`;
}
