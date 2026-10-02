/**
 * @file fal prompt-gen handler — estimate + execute over the sync chat
 * endpoint (`chat.ts`). The prompt-gen contract has no job form: a chat
 * answer comes back in one POST.
 */
import type { PromptGenHandler, PromptGenRequest, PromptGenResult } from "../../promptGen/contract";
import { createRequestLog } from "../log";
import type { FalContext } from "../types";
import { planChat, runChat } from "./chat";
import { estimateInputTokens, estimateUsd } from "./tokens";

/**
 * Creates the fal prompt-gen handler registered under `("prompt-gen", "fal")`.
 * `estimate` is an upper bound with no network and no key: the system and
 * prompt tokens (with messages: all their text, plus 1 000 tokens per image
 * part) in, `max_tokens` out, at the model's price. `execute` posts once,
 * retrying only a 5xx or a timeout.
 *
 * @param ctx - Plugin context (config, state, env, log).
 * @returns The handler: estimate and execute.
 */
export function createPromptGenHandler(ctx: FalContext): PromptGenHandler {
  const requestLog = createRequestLog(ctx);
  return {
    estimate: (request: PromptGenRequest): { usd: number } => {
      const plan = planChat(ctx, request);
      return { usd: estimateUsd(plan.price, estimateInputTokens(request), plan.maxTokens) };
    },
    execute: (
      request: PromptGenRequest,
      opts: { signal?: AbortSignal }
    ): Promise<PromptGenResult> => runChat(ctx, requestLog, request, opts.signal)
  };
}
