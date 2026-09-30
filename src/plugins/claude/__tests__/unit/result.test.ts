import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PromptGenUnavailableError } from "../../../promptGen/contract";
import { TerminalProviderError } from "../../errors";
import { parseClaudeResult, parseSchemaAnswer, schemaAnswerOf } from "../../prompt/result";
import { claudeJson, NOT_LOGGED_IN_STDOUT, SUCCESS_STDOUT } from "./fixtures";

const NOT_LOGGED_IN =
  "[ai] Claude CLI is not logged in.\n  Run claude and /login, or use another provider.";
const LIMIT =
  "[ai] Claude CLI hit its plan or rate limit.\n  Wait for the reset, or use another provider.";

/**
 * A finished run.
 *
 * @param stdout - Captured stdout.
 * @param code - Exit code.
 * @param stderr - Captured stderr tail.
 * @returns The run record.
 */
function run(stdout: string, code: number | null = 0, stderr = "") {
  // eslint-disable-next-line unicorn/no-null -- a run killed by a signal has no exit code
  return { code, exitSignal: code === null ? "SIGKILL" : null, stdout, stderr };
}

/**
 * The error `parseClaudeResult` throws for `value`.
 *
 * @param value - The run to parse.
 * @returns The thrown value.
 */
function failureOf(value: ReturnType<typeof run>): unknown {
  try {
    parseClaudeResult(value);
  } catch (error) {
    return error;
  }
  throw new Error("expected parseClaudeResult to throw");
}

describe("parseClaudeResult", () => {
  it("reads the answer, list price and token usage from the success sample", () => {
    expect(parseClaudeResult(run(SUCCESS_STDOUT))).toEqual({
      text: "ok",
      listCostUsd: 0.114_22,
      inputTokens: 12,
      outputTokens: 3
    });
  });

  it("trusts valid JSON over a non-zero exit code", () => {
    expect(parseClaudeResult(run(claudeJson({ result: "fine" }), 1)).text).toBe("fine");
  });

  it("maps the captured not-logged-in sample (exit 1) to unavailable 'auth'", () => {
    const error = failureOf(run(NOT_LOGGED_IN_STDOUT, 1));

    expect(error).toBeInstanceOf(PromptGenUnavailableError);
    expect((error as PromptGenUnavailableError).reason).toBe("auth");
    expect((error as Error).message).toBe(NOT_LOGGED_IN);
  });

  it("maps api_error_status 401 and 403 and 'invalid api key' to 'auth'", () => {
    for (const fields of [
      { is_error: true, result: "API Error", api_error_status: 401 },
      { is_error: true, result: "API Error", api_error_status: 403 },
      { is_error: true, result: "Invalid API key · Fix external API key" }
    ]) {
      expect((failureOf(run(claudeJson(fields), 1)) as PromptGenUnavailableError).reason).toBe(
        "auth"
      );
    }
  });

  it("maps limit wording and api_error_status 429 to unavailable 'limit'", () => {
    for (const fields of [
      { is_error: true, result: "Claude AI usage limit reached|1760000000" },
      { is_error: true, result: "You've hit your limit · resets 5pm" },
      { is_error: true, result: "Request rejected (429)", api_error_status: 429 }
    ]) {
      const error = failureOf(run(claudeJson(fields), 1));
      expect(error).toBeInstanceOf(PromptGenUnavailableError);
      expect((error as PromptGenUnavailableError).reason).toBe("limit");
      expect((error as Error).message).toBe(LIMIT);
    }
  });

  it("maps any other reported error to a terminal error with its first line, max 200 chars", () => {
    const error = failureOf(
      run(claudeJson({ is_error: true, result: `Overloaded.\n${"x".repeat(50)}` }), 1)
    );
    const long = failureOf(run(claudeJson({ is_error: true, result: "y".repeat(300) }), 1));

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toBe(
      "[ai] Claude returned an error: Overloaded.\n  Run the same claude -p by hand to see the full output."
    );
    expect((long as Error).message).toContain(`error: ${"y".repeat(200)}.\n`);
  });

  it("maps a reported error without text to a terminal error", () => {
    const error = failureOf(run(claudeJson({ is_error: true, result: "" }), 1));

    expect((error as Error).message).toMatch(/^\[ai] Claude returned an error: no message\.\n/);
  });

  it("maps non-JSON stdout with a non-zero exit to the last stderr line", () => {
    const error = failureOf(run("", 2, "starting\nfatal: bad flag.\n"));

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toBe(
      "[ai] Claude exited with code 2: fatal: bad flag.\n  Run the same claude -p by hand to see the full output."
    );
  });

  it("names the signal and omits an empty stderr", () => {
    // eslint-disable-next-line unicorn/no-null -- a run killed by a signal has no exit code
    expect((failureOf(run("", null)) as Error).message).toBe(
      "[ai] Claude exited with signal SIGKILL.\n  Run the same claude -p by hand to see the full output."
    );
  });

  it("classifies stderr login and limit wording when stdout is not JSON", () => {
    const auth = failureOf(run("", 1, "Error: not logged in\n"));
    const limit = failureOf(run("not json", 1, "rate limit exceeded\n"));

    expect((auth as PromptGenUnavailableError).reason).toBe("auth");
    expect((limit as PromptGenUnavailableError).reason).toBe("limit");
  });

  it("rejects exit 0 without a JSON result as terminal", () => {
    const error = failureOf(run("plain text"));

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toBe(
      "[ai] Claude printed no JSON result.\n  Run the same claude -p by hand to see the full output."
    );
  });

  it("rejects an empty answer as terminal", () => {
    const error = failureOf(run(claudeJson({ result: "  " })));

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toBe(
      "[ai] Claude wrote no answer.\n  Run the same claude -p by hand to see the full output."
    );
  });

  it("defaults missing cost and usage to 0", () => {
    const stdout = JSON.stringify({ is_error: false, result: "ok" });

    expect(parseClaudeResult(run(stdout))).toEqual({
      text: "ok",
      listCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0
    });
  });
});

describe("parseSchemaAnswer", () => {
  const validator = z.fromJSONSchema({
    type: "object",
    properties: { score: { type: "number" } },
    required: ["score"]
  });

  it("returns the validated JSON re-stringified", () => {
    expect(parseSchemaAnswer('{ "score": 7 }', validator)).toBe('{"score":7}');
  });

  it("strips one surrounding json code fence", () => {
    expect(parseSchemaAnswer('```json\n{"score": 7}\n```', validator)).toBe('{"score":7}');
    expect(parseSchemaAnswer('\n```\n{"score": 8}\n```\n', validator)).toBe('{"score":8}');
  });

  it("throws terminal with the first zod issue when the answer is off-schema", () => {
    const error = (() => {
      try {
        return parseSchemaAnswer('{"score":"high"}', validator);
      } catch (error_) {
        return error_;
      }
    })();

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).not.toBeInstanceOf(PromptGenUnavailableError);
    expect((error as Error).message).toBe(
      "[ai] Claude answer does not match params.responseSchema.\n  score: Invalid input: expected number, received string."
    );
  });

  it("throws terminal when the answer is not JSON", () => {
    expect(() => parseSchemaAnswer("Seven out of ten.", validator)).toThrow(
      "[ai] Claude answer does not match params.responseSchema.\n  The answer is not valid JSON."
    );
  });

  it("names the root when the whole value is wrong", () => {
    expect(() => parseSchemaAnswer("[1]", validator)).toThrow(/\n {2}\(root\): /);
  });
});

describe("parseClaudeResult — structured_output", () => {
  it("keeps structured_output of a --json-schema run", () => {
    const stdout = claudeJson({ result: '{"score":7}', structured_output: { score: 7 } });

    expect(parseClaudeResult(run(stdout)).structured).toEqual({ score: 7 });
  });

  it("accepts a blank result when structured_output is there", () => {
    const stdout = claudeJson({ result: "", structured_output: { score: 7 } });

    expect(parseClaudeResult(run(stdout)).structured).toEqual({ score: 7 });
  });

  it("leaves structured undefined without structured_output", () => {
    expect(parseClaudeResult(run(SUCCESS_STDOUT)).structured).toBeUndefined();
  });
});

describe("schemaAnswerOf", () => {
  const validator = z.fromJSONSchema({
    type: "object",
    properties: { score: { type: "number" } },
    required: ["score"]
  });
  const base = { text: "", listCostUsd: 0, inputTokens: 0, outputTokens: 0 };

  it("checks structured_output first and stringifies it compactly", () => {
    const answer = { ...base, text: "ignored", structured: { score: 7 } };

    expect(schemaAnswerOf(answer, validator)).toBe('{"score":7}');
  });

  it("throws terminal when structured_output is off-schema", () => {
    const answer = { ...base, structured: { score: "high" } };

    expect(() => schemaAnswerOf(answer, validator)).toThrow(
      /^\[ai] Claude answer does not match params\.responseSchema\.\n {2}score: /
    );
  });

  it("falls back to the answer text without structured_output", () => {
    const answer = { ...base, text: '```json\n{"score":8}\n```', structured: undefined };

    expect(schemaAnswerOf(answer, validator)).toBe('{"score":8}');
  });
});
