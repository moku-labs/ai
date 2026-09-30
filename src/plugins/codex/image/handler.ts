/**
 * @file codex image handler — implements the task-owned contract
 * (`../../image/contract.ts`). Each call owns a temp dir under
 * `config.workDir` (`os.tmpdir()` when it is ""): refs are copied in,
 * `codex exec` runs there, the image it wrote is read back, and the dir is
 * removed in `finally`.
 */
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { ImageHandler, ImageRequest, ImageResult } from "../../image/contract";
import { buildCodexArguments, runCodex } from "../cli";
import { TerminalProviderError } from "../errors";
import { priceOf } from "../prices";
import type { CodexContext } from "../types";
import { createCallDirectory } from "../workdir";
import { copyReferences, findResultImage, mimeForFile } from "./files";
import { buildImagePrompt } from "./prompt";

/** MIME type used when the result file extension is not recognised. */
const DEFAULT_MIME = "image/png";

/**
 * Model for `request`: its own `model`, else `config.model`.
 *
 * @param ctx - Plugin context (for `config.model`).
 * @param request - The image request.
 * @returns The model id.
 */
function resolveModel(ctx: CodexContext, request: ImageRequest): string {
  return request.model ?? ctx.config.model;
}

/**
 * Runs codex inside `dir` and reads back the image it wrote.
 *
 * @param ctx - Plugin context (bin, effort, timeout).
 * @param request - The image request.
 * @param model - Resolved model id.
 * @param dir - Per-call temp dir.
 * @param signal - Caller abort signal, if any.
 * @returns The image bytes and MIME type.
 * @throws {TerminalProviderError} When codex exits 0 without writing an image.
 */
async function generateIn(
  ctx: CodexContext,
  request: ImageRequest,
  model: string,
  dir: string,
  signal: AbortSignal | undefined
): Promise<{ image: Uint8Array; mimeType: string }> {
  // Stage refs and build the prompt
  const refPaths = await copyReferences(request.refs ?? [], dir);
  const prompt = buildImagePrompt({
    prompt: request.prompt,
    negative: request.negative,
    aspect: request.aspect,
    refNames: refPaths.map(refPath => path.basename(refPath))
  });

  // Run codex
  const args = buildCodexArguments({
    model,
    reasoningEffort: ctx.config.reasoningEffort,
    dir,
    refPaths,
    prompt
  });
  await runCodex({
    bin: ctx.config.bin,
    args,
    cwd: dir,
    timeoutMs: ctx.config.timeoutMs,
    ...(signal === undefined ? {} : { signal })
  });

  // Read the image back
  const resultPath = await findResultImage(dir);
  if (resultPath === undefined) {
    throw new TerminalProviderError(
      "[ai] Codex finished without writing an image.\n  Check that the codex model can generate images, then retry."
    );
  }
  const image = new Uint8Array(await readFile(resultPath));
  return { image, mimeType: mimeForFile(resultPath) ?? DEFAULT_MIME };
}

/**
 * Creates the codex image handler: `estimate()` returns the model's
 * per-image price; `execute()` runs `codex exec` in a fresh temp dir.
 *
 * @param ctx - Plugin context (config, state, log).
 * @returns The `ImageHandler` registered under the "image" task.
 */
export function createImageHandler(ctx: CodexContext): ImageHandler {
  return {
    /**
     * Price of `request` without running it.
     *
     * @param request - The image request.
     * @returns The price in US dollars.
     * @throws {Error} When the model has no price.
     */
    estimate(request: ImageRequest): { usd: number } {
      return { usd: priceOf(ctx, resolveModel(ctx, request)) };
    },
    /**
     * Generates one image with the codex CLI. Never logs the prompt.
     *
     * @param request - The image request.
     * @param opts - Execution options.
     * @param opts.signal - Abort signal; aborting kills codex and rethrows its reason.
     * @returns The generated image, its MIME type, price and meta.
     * @throws {PromptGenUnavailableError} CLI missing ("missing"), not logged in ("auth") or out of plan or rate limit ("limit"); the runner treats it as terminal.
     * @throws {TerminalProviderError} Any other non-zero exit, or no image written.
     * @throws {RetryableProviderError} With kind "timeout" after `timeoutMs`.
     */
    async execute(request: ImageRequest, opts: { signal?: AbortSignal }): Promise<ImageResult> {
      const model = resolveModel(ctx, request);
      const costUsd = priceOf(ctx, model);
      const dir = await createCallDirectory(ctx.config.workDir);

      try {
        const { image, mimeType } = await generateIn(ctx, request, model, dir, opts.signal);
        ctx.log.info("codex:image:done", { model, bytes: image.byteLength });
        return { image, mimeType, costUsd, meta: { model, bytes: image.byteLength } };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  };
}
