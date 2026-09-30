/**
 * @file claude params reader — pure. Validates the `params` a prompt-gen
 * request may carry (`images`, `responseSchema`, `reasoning`) and throws
 * the pinned param errors before anything is spawned. Other params are
 * ignored.
 */
import type { ZodType } from "zod";
import { z } from "zod";
import type { ImageFile } from "../../image/contract";
import type { Reasoning } from "../types";

/** A response schema: its `--json-schema` text and the validator built from it. */
export type AnswerSchema = {
  /** The schema as compact JSON without a top-level `$schema`, passed as `--json-schema`. */
  text: string;
  /** Zod validator built with `z.fromJSONSchema`. */
  validator: ZodType;
};

/** The params the claude handler reads, validated. */
export type PromptParameters = {
  /** Images to copy into the call dir; empty when none. */
  images: ImageFile[];
  /** The response schema, when the request has one. */
  schema: AnswerSchema | undefined;
  /** The reasoning level, when the request has one. */
  reasoning: Reasoning | undefined;
};

/** A JSON-schema object as `z.fromJSONSchema` accepts it. */
type JsonSchemaObject = z.core.JSONSchema.JSONSchema;

/** Shape of one image file (the image contract's `ImageFile`). */
const imageFileSchema = z.object({ path: z.string(), mimeType: z.string(), hash: z.string() });

/** `params.images`: one image file or an array of them. */
const imagesSchema = z.union([imageFileSchema, z.array(imageFileSchema)]);

/** `params.reasoning` levels. */
const reasoningSchema = z.enum(["off", "low", "medium", "high"]);

/** Thrown for a bad `params.images`. */
const IMAGES_ERROR =
  "[ai] Claude params.images must be image files.\n  Pass { path, mimeType, hash } for every image.";

/** Thrown for a bad `params.responseSchema`. */
const SCHEMA_ERROR =
  "[ai] Claude params.responseSchema must be a JSON schema object.\n  Pass the schema as a plain object.";

/**
 * Whether `value` is a plain object (not null, not an array).
 *
 * @param value - Any param value.
 * @returns True for a plain object.
 * @example
 * ```ts
 * isSchemaObject({ type: "object" }); // => true
 * ```
 */
function isSchemaObject(value: unknown): value is JsonSchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates `params.images`.
 *
 * @param value - The raw `params.images`.
 * @returns The image files, in order; empty when absent.
 * @throws {Error} When it is not an image file or an array of them.
 * @example
 * ```ts
 * readImages({ path: "/f.png", mimeType: "image/png", hash: "h" }).length; // => 1
 * ```
 */
function readImages(value: unknown): ImageFile[] {
  if (value === undefined) return [];

  const parsed = imagesSchema.safeParse(value);
  if (!parsed.success) throw new Error(IMAGES_ERROR);
  return Array.isArray(parsed.data) ? parsed.data : [parsed.data];
}

/**
 * Validates `params.responseSchema` and builds its validator. The flag text
 * drops a top-level `$schema`, which `--json-schema` rejects (its validator
 * does not know the draft URI, checked live 2026-09-30), and is compact,
 * because it is one argv entry.
 *
 * @param value - The raw `params.responseSchema`.
 * @returns The flag text and validator; undefined when absent.
 * @throws {Error} When it is not a plain object, or zod cannot read it as a JSON schema.
 * @example
 * ```ts
 * readSchema({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "number" })?.text; // => '{"type":"number"}'
 * ```
 */
function readSchema(value: unknown): AnswerSchema | undefined {
  if (value === undefined) return value;
  if (!isSchemaObject(value)) throw new Error(SCHEMA_ERROR);

  const flagSchema = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$schema"));
  try {
    return { text: JSON.stringify(flagSchema), validator: z.fromJSONSchema(value) };
  } catch {
    throw new Error(SCHEMA_ERROR);
  }
}

/**
 * Validates `params.reasoning`.
 *
 * @param value - The raw `params.reasoning`.
 * @returns The level; undefined when absent.
 * @throws {Error} When it is not off, low, medium or high.
 * @example
 * ```ts
 * readReasoning("medium"); // => "medium"
 * ```
 */
function readReasoning(value: unknown): Reasoning | undefined {
  if (value === undefined) return value;

  const parsed = reasoningSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `[ai] Claude params.reasoning must be off, low, medium or high.\n  Got "${String(value)}".`
    );
  }
  return parsed.data;
}

/**
 * Validates the request params the claude handler reads.
 *
 * @param params - The request's `params`, if any.
 * @returns Images, schema and reasoning, validated.
 * @throws {Error} The pinned param error for a bad `images`, `responseSchema` or `reasoning`.
 * @example
 * ```ts
 * readParameters({ reasoning: "off" }); // => { images: [], schema: undefined, reasoning: "off" }
 * ```
 */
export function readParameters(params: Record<string, unknown> | undefined): PromptParameters {
  return {
    images: readImages(params?.images),
    schema: readSchema(params?.responseSchema),
    reasoning: readReasoning(params?.reasoning)
  };
}
