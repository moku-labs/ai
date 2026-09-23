/**
 * Standard tier — YAML + defineBuild() → one zod-validated BuildSpec IR;
 * JSON Schema + `moku new` templates from the same source.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { createBuildfileApi } from "./api";
import type { Config } from "./types";

const defaultConfig: Config = {
  defaultGlob: "**/*.moku.yaml",
  schemaPath: ".moku/build.schema.json"
};

/**
 * buildfile — Standard tier plugin. Build-file front-end + zod IR.
 *
 * @see README.md
 */
export const buildfilePlugin = createPlugin("buildfile", {
  config: defaultConfig,
  api: createBuildfileApi
});

export { defineBuild } from "./define";
export { collectReferences, isFileValue, isReferenceValue } from "./references";
