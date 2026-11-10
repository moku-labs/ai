/**
 * @file elevenlabs dialogue handler — implements the task-owned contract
 * (`../../dialogue/contract.ts`). Checks the scene, POSTs it to
 * `/v1/text-to-dialogue/with-timestamps` in one request, and cuts the mix
 * into one file per line from the response's voice segments. Shares the
 * client, formats, prices and errors through the plugin root — per-task
 * submodules never import each other (spec/10).
 */
import type {
  DialogueHandler,
  DialogueLineTiming,
  DialogueRequest,
  DialogueResult
} from "../../dialogue/contract";
import type { ElevenlabsRequestOptions } from "../client";
import { elevenlabsJsonRequest } from "../client";
import { languageCodeOf } from "../formats";
import { characterPriceOf, resolvePrices } from "../prices";
import { redactedFailureOf, resolveApiKey } from "../support";
import type { ElevenlabsContext } from "../types";
import type { LineCut } from "./cut";
import { cutDialogue } from "./cut";
import { readDialogueResponse } from "./response";
import type { CheckedDialogue } from "./validate";
import { checkDialogue } from "./validate";

/** Milliseconds per second. */
const MS_PER_SECOND = 1000;

/**
 * The scene's cost: characters × the model's per-character price.
 *
 * @param ctx - Plugin context (for the effective price table).
 * @param model - The resolved model id.
 * @param characters - Characters over every line.
 * @returns The cost in US dollars.
 * @throws {TerminalProviderError} Status 400 when the model has no price row.
 */
function costOf(ctx: ElevenlabsContext, model: string, characters: number): number {
  return characters * characterPriceOf(resolvePrices(ctx), model);
}

/**
 * Builds the dialogue body: `inputs` (text + voice_id only), `model_id`, then
 * the optional `language_code`, `settings` (`stability` / `similarity`, the
 * keys set) and `seed`, and the request's `params` spread last.
 *
 * @param request - The dialogue request.
 * @param model - The resolved model id.
 * @returns The JSON request body.
 * @example
 * ```ts
 * buildRequestBody({ lines: [{ text: "Hi.", voice: "v1" }], language: "ru", seed: 7 }, "eleven_v4");
 * // => { inputs: [{ text: "Hi.", voice_id: "v1" }], model_id: "eleven_v4", language_code: "ru", seed: 7 }
 * ```
 */
function buildRequestBody(request: DialogueRequest, model: string): Record<string, unknown> {
  const languageCode = languageCodeOf(model, request.language);
  const { stability, similarity } = request.settings ?? {};
  const settings = {
    ...(stability === undefined ? {} : { stability }),
    ...(similarity === undefined ? {} : { similarity })
  };
  return {
    inputs: request.lines.map(line => ({ text: line.text, voice_id: line.voice })),
    model_id: model,
    ...(languageCode === undefined ? {} : { language_code: languageCode }),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    ...request.params
  };
}

/**
 * Builds the request options: endpoint, key, body and timeout of the one POST.
 *
 * @param ctx - Plugin context (for the base URL and the dialogue timeout).
 * @param request - The dialogue request.
 * @param checked - What the check learned (model and output format).
 * @param apiKey - The API key, read just now.
 * @param signal - The caller's abort signal, if any.
 * @returns The options for `elevenlabsJsonRequest`.
 */
function requestOptionsOf(
  ctx: ElevenlabsContext,
  request: DialogueRequest,
  checked: CheckedDialogue,
  apiKey: string,
  signal: AbortSignal | undefined
): ElevenlabsRequestOptions {
  return {
    baseUrl: ctx.config.baseUrl,
    path: `/v1/text-to-dialogue/with-timestamps?output_format=${checked.format.code}`,
    apiKey,
    body: buildRequestBody(request, checked.model),
    timeoutMs: ctx.config.dialogueTimeoutMs,
    ...(signal === undefined ? {} : { signal })
  };
}

/**
 * Builds the result from the mix and the cuts: `outputs[0]` is the mix, then
 * one output per cut line (`name` only for a line with an id).
 *
 * @param request - The dialogue request.
 * @param mix - The whole scene audio.
 * @param mimeType - The audio's mime type.
 * @param cuts - The cuts, in line order.
 * @returns The outputs and the timing of each cut line.
 */
function outputsOf(
  request: DialogueRequest,
  mix: Uint8Array,
  mimeType: string,
  cuts: readonly LineCut[]
): Pick<DialogueResult, "outputs" | "lines"> {
  const outputs: DialogueResult["outputs"] = [{ bytes: mix, mimeType }];
  const lines: DialogueLineTiming[] = [];
  for (const { index, piece } of cuts) {
    const id = request.lines[index]?.id;
    outputs.push({ bytes: piece.bytes, mimeType, ...(id === undefined ? {} : { name: id }) });
    lines.push({
      index,
      ...(id === undefined ? {} : { id }),
      startMs: Math.round(piece.startSeconds * MS_PER_SECOND),
      endMs: Math.round(piece.endSeconds * MS_PER_SECOND)
    });
  }
  return { outputs, lines };
}

/**
 * Creates the ElevenLabs dialogue handler: `estimate()` checks the scene and
 * prices its characters; `execute()` checks it, sends it in one request, and
 * returns the mix plus one file per line.
 *
 * @param ctx - Plugin context (config + state + env + log).
 * @returns The `DialogueHandler` registered under the "dialogue" task.
 */
export function createDialogueHandler(ctx: ElevenlabsContext): DialogueHandler {
  return {
    /**
     * Prices `request` after checking it (contract and errors: `DialogueHandler`).
     *
     * @param request - The dialogue request to estimate.
     * @returns The estimated cost in US dollars.
     */
    estimate(request: DialogueRequest): { usd: number } {
      const { model, characters } = checkDialogue(request, ctx.config.dialogueMaxChars);
      return { usd: costOf(ctx, model, characters) };
    },
    /**
     * Sends `request` in one POST, then cuts the mix (contract and errors: `DialogueHandler`).
     *
     * @param request - The dialogue request to execute.
     * @param opts - Execution options.
     * @param opts.signal - Abort signal for cancelling the in-flight request.
     * @returns The mix, one output per line with speech, the timings and the cost.
     */
    async execute(
      request: DialogueRequest,
      opts: { signal?: AbortSignal }
    ): Promise<DialogueResult> {
      // Check: refuse a bad scene, an unnamed model or an unpriced one before the key is read.
      const checked = checkDialogue(request, ctx.config.dialogueMaxChars);
      const costUsd = costOf(ctx, checked.model, checked.characters);
      const apiKey = resolveApiKey(ctx);
      if (checked.ignoredKeys.length > 0) {
        ctx.log.warn("elevenlabs:dialogue:line-fields-ignored", { keys: checked.ignoredKeys });
      }

      // Send: one request speaks the whole scene; a failure is logged redacted and rethrown unchanged.
      const options = requestOptionsOf(ctx, request, checked, apiKey, opts.signal);
      try {
        const { audio, segments } = readDialogueResponse(await elevenlabsJsonRequest(options));

        // Cut: one file per line from the voice segments; a line with no segment gets none.
        const { cuts, missing } = cutDialogue(
          audio,
          checked.format.code,
          segments,
          request.lines.length
        );
        if (missing.length > 0) ctx.log.warn("elevenlabs:dialogue:lines-missing", { missing });

        // Report: the mix first, then the cuts, with the cost and the metadata.
        const { mimeType } = checked.format;
        ctx.log.info("elevenlabs:dialogue:done", {
          model: checked.model,
          format: checked.format.code
        });
        return {
          audio,
          mimeType,
          costUsd,
          ...outputsOf(request, audio, mimeType, cuts),
          meta: {
            model: checked.model,
            characters: checked.characters,
            voices: checked.voices,
            ...(missing.length > 0 ? { missingLines: missing } : {})
          }
        };
      } catch (error) {
        ctx.log.warn("elevenlabs:dialogue:failed", redactedFailureOf(error));
        throw error;
      }
    }
  };
}
