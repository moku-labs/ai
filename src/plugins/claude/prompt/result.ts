/**
 * @file claude result parsing — pure. Reads the `--output-format json`
 * result of a finished run, maps every failure to the right error class
 * (unavailable vs terminal), and validates a schema answer: the
 * `structured_output` of a `--json-schema` run, or else the answer text.
 */
import type { ZodType } from "zod";
import { z } from "zod";
import type { PromptGenUsage } from "../../promptGen/contract";
import { PromptGenUnavailableError } from "../../promptGen/contract";
import type { ClaudeRun } from "../cli";
import { TerminalProviderError } from "../errors";

/** The answer of a successful run, with the CLI's own accounting. */
export type ClaudeAnswer = {
  /** The answer text (`result`). */
  text: string;
  /** The schema answer (`structured_output`) of a `--json-schema` run; undefined otherwise. */
  structured: unknown;
  /** The CLI's list-price figure (`total_cost_usd`); the plan bills $0. */
  listCostUsd: number;
  /** Input tokens (`usage.input_tokens`). */
  inputTokens: number;
  /** Output tokens (`usage.output_tokens`). */
  outputTokens: number;
  /** Input tokens served from the prompt cache (`usage.cache_read_input_tokens`). */
  cacheReadTokens: number;
  /** Input tokens written to the prompt cache (`usage.cache_creation_input_tokens`). */
  cacheWriteTokens: number;
};

/** The fields of claude's JSON result this plugin reads; the rest is ignored. */
const claudeOutputSchema = z.object({
  is_error: z.boolean(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  api_error_status: z.number().nullable().optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional()
    })
    .optional()
});

/** claude's JSON result, as read. */
type ClaudeOutput = z.infer<typeof claudeOutputSchema>;

/** Why a provider cannot serve now. */
type UnavailableReason = "auth" | "limit";

/** Result or stderr wording that means "not logged in". */
const AUTH_PATTERN = /not logged in|\/login|invalid api key/i;

/** Result or stderr wording that means "plan or rate limit". */
const LIMIT_PATTERN = /usage limit|limit reached|hit your limit|rate limit/i;

/** HTTP statuses of an auth failure. */
const AUTH_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/** HTTP status of a rate limit. */
const LIMIT_STATUS = 429;

/** Longest excerpt of a reported error kept in the message. */
const ERROR_EXCERPT_CHARS = 200;

/** Second line of every "look at it by hand" error. */
const BY_HAND = "Run the same claude -p by hand to see the full output.";

/** Message per unavailable reason; two lines, never the prompt. */
const UNAVAILABLE_MESSAGES: Record<UnavailableReason, string> = {
  auth: "[ai] Claude CLI is not logged in.\n  Run claude and /login, or use another provider.",
  limit:
    "[ai] Claude CLI hit its plan or rate limit.\n  Wait for the reset, or use another provider."
};

/** Prefix of every schema-mismatch error. */
const SCHEMA_MISMATCH = "[ai] Claude answer does not match params.responseSchema.";

/** One ```json (or bare ```) fence around the whole answer. */
const FENCE_PATTERN = /^```(?:json)?[^\S\n]*\n([\s\S]*)\n```$/;

/**
 * The unavailable reason for an error text and API status, if any.
 *
 * @param text - Result text or stderr.
 * @param status - `api_error_status`, when known.
 * @returns "auth", "limit", or undefined for an ordinary failure.
 * @example
 * ```ts
 * unavailableReason("Not logged in · Please run /login", null); // => "auth"
 * ```
 */
function unavailableReason(text: string, status?: number | null): UnavailableReason | undefined {
  const isAuth =
    AUTH_PATTERN.test(text) || (typeof status === "number" && AUTH_STATUSES.has(status));
  if (isAuth) return "auth";

  const isLimit = LIMIT_PATTERN.test(text) || status === LIMIT_STATUS;
  return isLimit ? "limit" : undefined;
}

/**
 * Drops trailing periods, so a message line ends with exactly one.
 *
 * @param text - A message fragment.
 * @returns The fragment without trailing periods.
 * @example
 * ```ts
 * withoutPeriod("fatal: bad flag."); // => "fatal: bad flag"
 * ```
 */
function withoutPeriod(text: string): string {
  let result = text;
  while (result.endsWith(".")) result = result.slice(0, -1);
  return result;
}

/**
 * The stdout JSON result, or undefined when stdout is not one.
 *
 * @param stdout - Full stdout of the run.
 * @returns The parsed result, or undefined.
 * @example
 * ```ts
 * readOutput('{"is_error":false,"result":"ok"}')?.result; // => "ok"
 * ```
 */
function readOutput(stdout: string): ClaudeOutput | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const parsed = claudeOutputSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Error for a JSON result with `is_error` true.
 *
 * @param output - The parsed result.
 * @returns Unavailable for auth/limit, else terminal with the first line.
 * @example
 * ```ts
 * reportedError({ is_error: true, result: "Overloaded." }).message; // => "[ai] Claude returned an error: Overloaded.\n  …"
 * ```
 */
function reportedError(output: ClaudeOutput): Error {
  const text = output.result ?? "";
  const reason = unavailableReason(text, output.api_error_status);
  if (reason !== undefined)
    return new PromptGenUnavailableError(UNAVAILABLE_MESSAGES[reason], reason);

  const firstLine = text.split("\n").find(line => line.trim() !== "") ?? "";
  const excerpt = withoutPeriod(firstLine.trim()).slice(0, ERROR_EXCERPT_CHARS);
  const detail = excerpt === "" ? "no message" : excerpt;
  return new TerminalProviderError(`[ai] Claude returned an error: ${detail}.\n  ${BY_HAND}`);
}

/**
 * Error for a run whose stdout is not a JSON result.
 *
 * @param run - The finished run.
 * @returns Unavailable when stderr says so, else terminal.
 * @example
 * ```ts
 * exitError({ code: 2, exitSignal: null, stdout: "", stderr: "boom\n" }).message; // => "[ai] Claude exited with code 2: boom.\n  …"
 * ```
 */
function exitError(run: ClaudeRun): Error {
  if (run.code === 0) {
    return new TerminalProviderError(`[ai] Claude printed no JSON result.\n  ${BY_HAND}`);
  }

  const reason = unavailableReason(run.stderr);
  if (reason !== undefined)
    return new PromptGenUnavailableError(UNAVAILABLE_MESSAGES[reason], reason);

  const how = run.code === null ? `signal ${run.exitSignal ?? "unknown"}` : `code ${run.code}`;
  const lastLine = run.stderr
    .split("\n")
    .map(line => line.trim())
    .findLast(line => line !== "");
  const detail = lastLine === undefined ? "" : `: ${withoutPeriod(lastLine)}`;
  return new TerminalProviderError(`[ai] Claude exited with ${how}${detail}.\n  ${BY_HAND}`);
}

/**
 * Reads a finished run. stdout JSON is parsed first, even on a non-zero
 * exit: the not-logged-in result exits 1 with valid JSON.
 *
 * @param run - The finished run.
 * @returns The answer text, the structured output if any, list price and token usage (cache tokens included).
 * @throws {PromptGenUnavailableError} With reason "auth" or "limit" when claude cannot serve.
 * @throws {TerminalProviderError} For a reported error, a failed exit, or a blank answer without structured output.
 * @example
 * ```ts
 * parseClaudeResult({ code: 0, exitSignal: null, stdout: '{"is_error":false,"result":"ok"}', stderr: "" }).text; // => "ok"
 * ```
 */
export function parseClaudeResult(run: ClaudeRun): ClaudeAnswer {
  const output = readOutput(run.stdout);
  if (output === undefined) throw exitError(run);
  if (output.is_error) throw reportedError(output);

  const text = output.result ?? "";
  const structured = output.structured_output;
  if (text.trim() === "" && structured === undefined)
    throw new TerminalProviderError(`[ai] Claude wrote no answer.\n  ${BY_HAND}`);

  return {
    text,
    structured,
    listCostUsd: output.total_cost_usd ?? 0,
    inputTokens: output.usage?.input_tokens ?? 0,
    outputTokens: output.usage?.output_tokens ?? 0,
    cacheReadTokens: output.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: output.usage?.cache_creation_input_tokens ?? 0
  };
}

/**
 * The typed token usage of an answer. claude's `input_tokens` leaves out the
 * cached part, so the prompt tokens are input plus cache reads plus cache
 * writes.
 *
 * @param answer - The parsed run answer.
 * @returns The usage for `PromptGenResult.usage`.
 * @example
 * ```ts
 * usageOf({ text: "ok", structured: undefined, listCostUsd: 0, inputTokens: 5, outputTokens: 2, cacheReadTokens: 900, cacheWriteTokens: 120 });
 * // => { promptTokens: 1025, completionTokens: 2, cachedTokens: 900, cacheWriteTokens: 120 }
 * ```
 */
export function usageOf(answer: ClaudeAnswer): PromptGenUsage {
  return {
    promptTokens: answer.inputTokens + answer.cacheReadTokens + answer.cacheWriteTokens,
    completionTokens: answer.outputTokens,
    cachedTokens: answer.cacheReadTokens,
    cacheWriteTokens: answer.cacheWriteTokens
  };
}

/**
 * Checks a parsed answer against the validator.
 *
 * @param value - The parsed answer.
 * @param validator - Validator built from `params.responseSchema`.
 * @returns The answer, stringified compactly.
 * @throws {TerminalProviderError} When it does not match; never unavailable.
 * @example
 * ```ts
 * checkSchemaValue({ score: 7 }, z.fromJSONSchema({ type: "object" })); // => '{"score":7}'
 * ```
 */
function checkSchemaValue(value: unknown, validator: ZodType): string {
  const parsed = validator.safeParse(value);
  const issue = parsed.error?.issues[0];
  if (issue !== undefined) {
    const where = issue.path.length === 0 ? "(root)" : issue.path.join(".");
    throw new TerminalProviderError(
      `${SCHEMA_MISMATCH}\n  ${where}: ${withoutPeriod(issue.message)}.`
    );
  }
  return JSON.stringify(value);
}

/**
 * Validates a schema answer text: strips one surrounding code fence, parses
 * the JSON, and checks it against the validator.
 *
 * @param text - The answer text.
 * @param validator - Validator built from `params.responseSchema`.
 * @returns The validated JSON, re-stringified compactly.
 * @throws {TerminalProviderError} When the answer is not JSON or does not match; never unavailable.
 * @example
 * ```ts
 * parseSchemaAnswer('```json\n{ "score": 7 }\n```', z.fromJSONSchema({ type: "object" })); // => '{"score":7}'
 * ```
 */
export function parseSchemaAnswer(text: string, validator: ZodType): string {
  const trimmed = text.trim();
  const body = FENCE_PATTERN.exec(trimmed)?.[1] ?? trimmed;

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new TerminalProviderError(`${SCHEMA_MISMATCH}\n  The answer is not valid JSON.`);
  }
  return checkSchemaValue(value, validator);
}

/**
 * The schema answer of a run: `structured_output` when the CLI returned one,
 * else the answer text, both checked with the validator.
 *
 * @param answer - The parsed run answer.
 * @param validator - Validator built from `params.responseSchema`.
 * @returns The validated JSON, stringified compactly.
 * @throws {TerminalProviderError} When the answer is not JSON or does not match; never unavailable.
 * @example
 * ```ts
 * schemaAnswerOf({ text: "", structured: { score: 7 }, listCostUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, z.fromJSONSchema({ type: "object" })); // => '{"score":7}'
 * ```
 */
export function schemaAnswerOf(answer: ClaudeAnswer, validator: ZodType): string {
  return answer.structured === undefined
    ? parseSchemaAnswer(answer.text, validator)
    : checkSchemaValue(answer.structured, validator);
}
