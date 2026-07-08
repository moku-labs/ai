/**
 * @file buildfile plugin — type definitions (BuildSpec = z.infer of the schema).
 */
import type { z } from "zod";
import type { buildItemSchema, buildSpecSchema } from "./schema";

/**
 *
 */
export type BuildItem = z.infer<typeof buildItemSchema>;
/**
 *
 */
export type BuildSpec = z.infer<typeof buildSpecSchema>;

/**
 *
 */
export type Config = {
  /** Glob used when no explicit pattern is given. */
  defaultGlob: string;
  /** Where `moku new` writes the generated JSON Schema. */
  schemaPath: string;
};

/**
 *
 */
export type CompiledBuild = { file: string; spec: BuildSpec };
/**
 *
 */
export type BuildfileSource = { path: string } | { text: string; lang: "yaml" };

/**
 *
 */
export type BuildfileApi = {
  compile(source: BuildfileSource): Promise<CompiledBuild>;
  loadGlob(pattern?: string): Promise<CompiledBuild[]>;
  jsonSchema(): Record<string, unknown>;
  template(opts: { name: string }): string;
};
