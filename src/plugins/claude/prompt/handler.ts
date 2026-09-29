/**
 * @file claude prompt-gen handler — implements the task-owned contract
 * (`../../promptGen/contract.ts`). Each call owns a temp dir under
 * `config.workDir` (or `os.tmpdir()`): images are copied in, `claude -p`
 * runs there with the prompt on stdin, the JSON result is read back, and the
 * dir is removed in `finally`.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PromptGenHandler, PromptGenRequest, PromptGenResult } from "../../promptGen/contract";
import { buildClaudeArguments, runClaude } from "../cli";
import type { ClaudeContext } from "../types";
import { copyImages } from "./files";
import { effortFor, mapModel } from "./model";
import type { PromptParameters } from "./params";
import { readParameters } from "./params";
import { buildClaudePrompt } from "./prompt";
import type { ClaudeAnswer } from "./result";
import { parseClaudeResult, parseSchemaAnswer } from "./result";

/** Prefix of every per-call temp dir. */
const CALL_DIR_PREFIX = "moku-claude-";

/**
 * Creates the per-call temp dir under `workDirectory`, or `os.tmpdir()` when it
 * is empty. Outside the repo, so claude loads no project CLAUDE.md.
 *
 * @param workDirectory - `config.workDir`.
 * @returns Absolute path of the new dir.
 * @example
 * ```ts
 * await createCallDirectory(""); // => "/tmp/moku-claude-Ab12Cd"
 * ```
 */
async function createCallDirectory(workDirectory: string): Promise<string> {
  const root = workDirectory === "" ? tmpdir() : path.resolve(workDirectory);
  await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, CALL_DIR_PREFIX));
}

/**
 * Runs claude inside `dir` and reads its answer.
 *
 * @param ctx - Plugin context (bin, timeout).
 * @param request - The prompt-gen request.
 * @param call - Validated params, mapped model, call dir and abort signal.
 * @param call.params - Validated request params.
 * @param call.model - Mapped `--model`, if any.
 * @param call.dir - Per-call temp dir.
 * @param call.signal - Caller abort signal, if any.
 * @returns The answer text, list price and token usage.
 */
async function answerIn(
  ctx: ClaudeContext,
  request: PromptGenRequest,
  call: { params: PromptParameters; model: string | undefined; dir: string; signal?: AbortSignal }
): Promise<ClaudeAnswer> {
  const imageNames = await copyImages(call.params.images, call.dir);
  const prompt = buildClaudePrompt({
    prompt: request.prompt,
    imageNames,
    schemaText: call.params.schema?.text
  });
  const args = buildClaudeArguments({
    system: request.system,
    withImages: imageNames.length > 0,
    model: call.model,
    effort: effortFor(call.params.reasoning)
  });

  const run = await runClaude({
    bin: ctx.config.bin,
    args,
    cwd: call.dir,
    stdin: prompt,
    timeoutMs: ctx.config.timeoutMs,
    ...(call.signal === undefined ? {} : { signal: call.signal })
  });
  return parseClaudeResult(run);
}

/**
 * Result meta: provider, mapped model, the requested id when it differs,
 * the CLI's list price, token usage, and ignored request fields.
 *
 * @param request - The prompt-gen request.
 * @param model - Mapped `--model`, if any.
 * @param answer - The parsed answer.
 * @returns The `meta` record.
 * @example
 * ```ts
 * buildMeta({ prompt: "p" }, undefined, { text: "ok", listCostUsd: 0.1, inputTokens: 1, outputTokens: 1 });
 * // => { provider: "claude", listCostUsd: 0.1, usage: { inputTokens: 1, outputTokens: 1 } }
 * ```
 */
function buildMeta(
  request: PromptGenRequest,
  model: string | undefined,
  answer: ClaudeAnswer
): Record<string, unknown> {
  return {
    provider: "claude",
    ...(model === undefined ? {} : { model }),
    ...(request.model === undefined ? {} : { modelRequested: request.model }),
    listCostUsd: answer.listCostUsd,
    usage: { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens },
    ...(request.temperature === undefined ? {} : { ignored: ["temperature"] })
  };
}

/**
 * Creates the claude prompt-gen handler: `estimate()` validates params and
 * returns $0 (plan-billed); `execute()` runs `claude -p` in a fresh temp dir.
 * `temperature` is ignored and listed in `meta.ignored`. Logs
 * `claude:prompt:done` with the model and the text length only.
 *
 * @param ctx - Plugin context (config, log).
 * @returns The `PromptGenHandler` registered under the "prompt-gen" task.
 */
export function createPromptGenHandler(ctx: ClaudeContext): PromptGenHandler {
  return {
    estimate: (request: PromptGenRequest): { usd: number } => {
      readParameters(request.params);
      return { usd: 0 };
    },

    execute: async (
      request: PromptGenRequest,
      opts: { signal?: AbortSignal }
    ): Promise<PromptGenResult> => {
      const params = readParameters(request.params);
      const model = mapModel(ctx.config, request.model);
      const dir = await createCallDirectory(ctx.config.workDir);

      try {
        const call = { params, model, dir, ...(opts.signal ? { signal: opts.signal } : {}) };
        const answer = await answerIn(ctx, request, call);
        const text =
          params.schema === undefined
            ? answer.text
            : parseSchemaAnswer(answer.text, params.schema.validator);

        ctx.log.info("claude:prompt:done", { model: model ?? "default", textLength: text.length });
        return { text, costUsd: 0, meta: buildMeta(request, model, answer) };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  };
}
