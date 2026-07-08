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
