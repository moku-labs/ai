/**
 * @file codex prompt-gen handler — implements the task-owned contract
 * (`../../promptGen/contract.ts`). Each call owns a temp dir under
 * `config.workDir` (`os.tmpdir()` when it is ""): images are copied in,
 * `codex exec` runs read-only there, the answer is read from
 * `last-message.txt`, and the dir is removed in `finally`. A response schema
 * goes in the prompt and the answer is checked with zod (see `./answer.ts`).
 * Plan-billed: every result costs $0.
 */
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { PromptGenHandler, PromptGenRequest, PromptGenResult } from "../../promptGen/contract";
import { buildCodexPromptArguments, LAST_MESSAGE_FILE, runCodex } from "../cli";
import { TerminalProviderError } from "../errors";
import { copyReferences } from "../image/files";
import type { CodexContext } from "../types";
import { createCallDirectory } from "../workdir";
import { parseSchemaAnswer, schemaBlock } from "./answer";
import { mapModel } from "./model";
import type { PromptParameters } from "./params";
import { readPromptParameters } from "./params";

/** What one call runs: the full prompt, the codex model and the read params. */
type PromptPlan = {
  /** Prompt text, system text prepended and schema block appended. */
  prompt: string;
  /** Codex model, or undefined for codex's own default. */
  model: string | undefined;
  /** Validated params. */
  params: PromptParameters;
};

/** `meta` of every codex prompt-gen result. */
type CodexPromptMeta = {
  provider: "codex";
  model?: string;
  modelRequested?: string;
  reasoningEffort: string;
  ignored?: string[];
};

/**
 * Prompt text codex receives: codex has no system flag, so the system text
 * comes first, then the prompt, then the schema block when a schema is set.
 * Blocks are separated by a blank line.
 *
 * @param request - The prompt-gen request.
 * @param schemaText - The schema as compact JSON, when the request has one.
 * @returns The prompt text.
 * @example
 * ```ts
 * promptTextOf({ prompt: "Say ok", system: "Be terse." }, undefined); // => "Be terse.\n\nSay ok"
 * ```
 */
function promptTextOf(request: PromptGenRequest, schemaText: string | undefined): string {
  const hasSystem = request.system !== undefined && request.system !== "";
  const blocks = hasSystem ? [request.system, request.prompt] : [request.prompt];
  if (schemaText !== undefined) blocks.push(schemaBlock(schemaText));

  return blocks.join("\n\n");
}

/**
 * Whether a read failed because the file is not there.
 *
 * @param error - The rejection of `readFile`.
 * @returns True for ENOENT.
 * @example
 * ```ts
 * isMissingFile(Object.assign(new Error("gone"), { code: "ENOENT" })); // => true
 * ```
 */
function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Reads codex's final answer from `<dir>/last-message.txt`, trimmed.
 *
 * @param dir - Per-call temp dir.
 * @returns The answer text.
 * @throws {TerminalProviderError} When the file is missing or blank.
 * @example
 * ```ts
 * await readAnswer("/work/codex-1"); // => "ok"
 * ```
 */
async function readAnswer(dir: string): Promise<string> {
  const raw = await readFile(path.join(dir, LAST_MESSAGE_FILE), "utf8").catch((error: unknown) => {
    if (isMissingFile(error)) return "";
    throw error;
  });

  const text = raw.trim();
  if (text === "") {
    throw new TerminalProviderError(
      "[ai] Codex wrote no answer.\n  Run the same codex exec by hand to see the full output."
    );
  }
  return text;
}

/**
 * Runs codex inside `dir` and reads back its answer.
 *
 * @param ctx - Plugin context (bin, timeout).
 * @param plan - Prompt, model and params.
 * @param dir - Per-call temp dir.
 * @param signal - Caller abort signal, if any.
 * @returns The answer text; with a schema, the validated JSON.
 * @throws {TerminalProviderError} When codex writes no answer, or an answer off the schema.
 */
async function answerIn(
  ctx: CodexContext,
  plan: PromptPlan,
  dir: string,
  signal: AbortSignal | undefined
): Promise<string> {
  // Stage the reference images in the call dir
  const imagePaths = await copyReferences(plan.params.images, dir);

  // Run codex read-only in the call dir
  const args = buildCodexPromptArguments({
    model: plan.model,
    reasoningEffort: plan.params.reasoningEffort,
    dir,
    imagePaths,
    prompt: plan.prompt
  });
  await runCodex({
    bin: ctx.config.bin,
    args,
    cwd: dir,
    timeoutMs: ctx.config.timeoutMs,
    ...(signal === undefined ? {} : { signal })
  });

  // Read the answer and check it against the schema, if any
  const text = await readAnswer(dir);
  const { schema } = plan.params;
  return schema === undefined ? text : parseSchemaAnswer(text, schema.validator);
}

/**
 * Result meta: provider, the models when known, the effort, and what was ignored.
 *
 * @param request - The prompt-gen request.
 * @param plan - The plan that ran.
 * @returns The meta object.
 * @example
 * ```ts
 * metaOf({ prompt: "p" }, { prompt: "p", model: undefined, params: { images: [], schema: undefined, reasoningEffort: "low", ignored: [] } }); // => { provider: "codex", reasoningEffort: "low" }
 * ```
 */
function metaOf(request: PromptGenRequest, plan: PromptPlan): CodexPromptMeta {
  return {
    provider: "codex",
    ...(plan.model === undefined ? {} : { model: plan.model }),
    ...(request.model === undefined ? {} : { modelRequested: request.model }),
    reasoningEffort: plan.params.reasoningEffort,
    ...(plan.params.ignored.length === 0 ? {} : { ignored: plan.params.ignored })
  };
}

/**
 * Creates the codex prompt-gen handler: `estimate()` validates the params
 * and returns $0; `execute()` runs `codex exec` read-only in a fresh temp
 * dir and returns the answer at $0 with meta. Never logs the prompt or the
 * answer. Both throw `Error` when `images`, `responseSchema` or `reasoning`
 * has a bad shape. `execute()` also throws `PromptGenUnavailableError` when
 * the CLI is missing, not logged in, or out of plan or rate limit;
 * `TerminalProviderError` on a non-zero exit, no answer, or an answer that
 * does not match the schema; `RetryableProviderError` with kind "timeout" after
 * `timeoutMs`; and the caller's `signal.reason`, unchanged, on abort.
 *
 * @param ctx - Plugin context (config, log).
 * @returns The `PromptGenHandler` registered under the "prompt-gen" task.
 */
export function createPromptGenHandler(ctx: CodexContext): PromptGenHandler {
  return {
    estimate: (request: PromptGenRequest): { usd: number } => {
      readPromptParameters(request, ctx.config.reasoningEffort);
      return { usd: 0 };
    },

    execute: async (
      request: PromptGenRequest,
      opts: { signal?: AbortSignal }
    ): Promise<PromptGenResult> => {
      // Validate params and map the model
      const params = readPromptParameters(request, ctx.config.reasoningEffort);
      const plan: PromptPlan = {
        prompt: promptTextOf(request, params.schema?.text),
        model: mapModel(ctx.config, request.model),
        params
      };

      // Run in a fresh call dir, always cleaned up
      const dir = await createCallDirectory(ctx.config.workDir);
      try {
        const text = await answerIn(ctx, plan, dir, opts.signal);
        ctx.log.info("codex:prompt-gen:done", {
          model: plan.model ?? "default",
          chars: text.length
        });
        return { text, costUsd: 0, meta: metaOf(request, plan) };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  };
}
