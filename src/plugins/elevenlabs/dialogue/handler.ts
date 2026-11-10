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
import { checkDialogue } from "./validate";

/** Milliseconds per second. */
const MS_PER_SECOND = 1000;

/**
 * The model of `request`: its own `model`, else `config.defaultDialogueModel`.
 *
 * @param ctx - Plugin context (for `config.defaultDialogueModel`).
 * @param request - The dialogue request.
 * @returns The resolved model id.
 */
function resolveModel(ctx: ElevenlabsContext, request: DialogueRequest): string {
  return request.model ?? ctx.config.defaultDialogueModel;
}

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
 * @example
 * ```ts
 * registry.register("dialogue", "elevenlabs", createDialogueHandler(ctx));
 * ```
 */
export function createDialogueHandler(ctx: ElevenlabsContext): DialogueHandler {
  return {
    /**
     * Estimates the cost of `request` without executing it; refuses an
     * invalid scene or an unpriced model before any spend.
     *
     * @param request - The dialogue request to estimate.
     * @returns The estimated cost in US dollars.
     * @throws {TerminalProviderError} Status 400 for an invalid scene or a model with no price.
     */
    estimate(request: DialogueRequest): { usd: number } {
      const { characters } = checkDialogue(request, ctx.config.dialogueMaxChars);
      return { usd: costOf(ctx, resolveModel(ctx, request), characters) };
    },
    /**
     * Executes `request`: one POST to the dialogue endpoint, then the cuts.
     *
     * @param request - The dialogue request to execute.
     * @param opts - Execution options.
     * @param opts.signal - Abort signal for cancelling the in-flight request.
     * @returns The mix, one output per line with speech, the timings and the cost.
     * @throws {TerminalProviderError} Status 400 for an invalid scene or a model with no price; any other 4xx.
     * @throws {RetryableProviderError} On HTTP 5xx/429, a timeout, a network failure, or an unreadable response.
     * @throws {FlaggedProviderError} On a content-policy rejection.
     * @throws {LocalFailureError} When the response audio cannot be cut.
     */
    async execute(
      request: DialogueRequest,
      opts: { signal?: AbortSignal }
    ): Promise<DialogueResult> {
      const checked = checkDialogue(request, ctx.config.dialogueMaxChars);
      const model = resolveModel(ctx, request);
      const costUsd = costOf(ctx, model, checked.characters);
      const apiKey = resolveApiKey(ctx);
      if (checked.ignoredKeys.length > 0) {
        ctx.log.warn("elevenlabs:dialogue:line-fields-ignored", { keys: checked.ignoredKeys });
      }
      const options: ElevenlabsRequestOptions = {
        baseUrl: ctx.config.baseUrl,
        path: `/v1/text-to-dialogue/with-timestamps?output_format=${checked.format.code}`,
        apiKey,
        body: buildRequestBody(request, model),
        timeoutMs: ctx.config.dialogueTimeoutMs,
        ...(opts.signal === undefined ? {} : { signal: opts.signal })
      };

      try {
        const { audio, segments } = readDialogueResponse(await elevenlabsJsonRequest(options));
        const { cuts, missing } = cutDialogue(
          audio,
          checked.format.code,
          segments,
          request.lines.length
        );
        if (missing.length > 0) ctx.log.warn("elevenlabs:dialogue:lines-missing", { missing });
        ctx.log.info("elevenlabs:dialogue:done", { model, format: checked.format.code });
        const { mimeType } = checked.format;
        return {
          audio,
          mimeType,
          costUsd,
          ...outputsOf(request, audio, mimeType, cuts),
          meta: {
            model,
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
