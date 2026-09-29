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
import type { ClaudeContext, ClaudePromptMeta, Effort } from "../types";
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

/** Per-call inputs of {@link answerIn}. */
type CallInputs = {
  /** Validated request params. */
  params: PromptParameters;
  /** Mapped `--model`, if any. */
  model: string | undefined;
  /** `--effort` level, if any. */
  effort: Effort | undefined;
  /** Per-call temp dir. */
  dir: string;
  /** Caller abort signal, if any. */
  signal?: AbortSignal;
};

/**
 * Runs claude inside `call.dir` and reads its answer.
 *
 * @param ctx - Plugin context (bin, timeout).
 * @param request - The prompt-gen request.
 * @param call - Validated params, mapped model, effort, call dir and abort signal.
 * @returns The answer text, list price and token usage.
 */
async function answerIn(
  ctx: ClaudeContext,
  request: PromptGenRequest,
  call: CallInputs
): Promise<ClaudeAnswer> {
  // Stage images and build the stdin prompt and argv
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
    effort: call.effort
  });

  // Run the CLI once and parse its JSON result
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
 * Result meta: provider, mapped model, the requested id, the effort passed,
 * the CLI's list price, token usage, and ignored request fields.
 *
 * @param request - The prompt-gen request.
 * @param flags - The `--model` and `--effort` values passed, if any.
 * @param flags.model - Mapped `--model`, if any.
 * @param flags.effort - `--effort` level, if any.
 * @param answer - The parsed answer.
 * @returns The `meta` record.
 * @example
 * ```ts
 * buildMeta({ prompt: "p" }, { model: undefined, effort: "low" }, { text: "ok", listCostUsd: 0.1, inputTokens: 1, outputTokens: 1 });
 * // => { provider: "claude", effort: "low", listCostUsd: 0.1, usage: { inputTokens: 1, outputTokens: 1 } }
 * ```
 */
function buildMeta(
  request: PromptGenRequest,
  flags: { model: string | undefined; effort: Effort | undefined },
  answer: ClaudeAnswer
): ClaudePromptMeta {
  return {
    provider: "claude",
    ...(flags.model === undefined ? {} : { model: flags.model }),
    ...(request.model === undefined ? {} : { modelRequested: request.model }),
    ...(flags.effort === undefined ? {} : { effort: flags.effort }),
    listCostUsd: answer.listCostUsd,
    usage: { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens },
    ...(request.temperature === undefined ? {} : { ignored: ["temperature"] })
  };
}

/**
 * Creates the claude prompt-gen handler: `estimate()` validates params and
 * returns $0 (plan-billed); `execute()` runs `claude -p` in a fresh temp dir.
 * `temperature` is ignored and listed in `meta.ignored`. Logs
 * `claude:prompt-gen:done` with the model and the answer length only.
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
      // Validate params and map the model
      const params = readParameters(request.params);
      const model = mapModel(ctx.config, request.model);
      const effort = effortFor(params.reasoning);

      // Run in a fresh call dir, always cleaned up
      const dir = await createCallDirectory(ctx.config.workDir);
      try {
        const signal = opts.signal ? { signal: opts.signal } : {};
        const answer = await answerIn(ctx, request, { params, model, effort, dir, ...signal });
        const text =
          params.schema === undefined
            ? answer.text
            : parseSchemaAnswer(answer.text, params.schema.validator);

        ctx.log.info("claude:prompt-gen:done", { model: model ?? "default", chars: text.length });
        return { text, costUsd: 0, meta: buildMeta(request, { model, effort }, answer) };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  };
}
