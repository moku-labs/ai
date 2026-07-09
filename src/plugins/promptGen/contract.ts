/**
 * @file prompt-gen capability contract — task-owned; providers implement this.
 */

/**
 * A one-off text-generation request. Providers map/clamp `temperature` and
 * `params` as needed for their own API.
 *
 * @example
 * ```ts
 * const request: PromptGenRequest = { prompt: "Describe a sunset over the ocean." };
 * ```
 */
export type PromptGenRequest = {
  prompt: string;
  system?: string;
  model?: string;
  /** Provider maps/clamps as needed. */
  temperature?: number;
  params?: Record<string, unknown>;
};

/**
 * The result of a prompt-gen request: the generated text and its cost, plus
 * optional provider metadata.
 *
 * @example
 * ```ts
 * const result: PromptGenResult = { text: "A fiery orange sunset.", costUsd: 0.0002 };
 * ```
 */
export type PromptGenResult = {
  text: string;
  costUsd: number;
  /** Token counts, model — metadata only. */
  meta?: Record<string, unknown>;
};

/**
 * The handler contract a prompt-gen provider plugin registers with
 * `registry` under the `"prompt-gen"` task. Provider plugins `import type`
 * this to implement it; `promptGen` performs the one audited cast to this
 * type at its own `resolve()` call site (spec/09 R9).
 *
 * @example
 * ```ts
 * const handler: PromptGenHandler = {
 *   estimate: request => ({ usd: request.prompt.length * 0.00001 }),
 *   execute: async request => ({ text: request.prompt, costUsd: 0 })
 * };
 * ```
 */
export type PromptGenHandler = {
  /**
   * Estimates the cost of executing `request`, without performing it.
   *
   * @param request - The prompt-gen request to estimate.
   * @returns The estimated cost in USD.
   */
  estimate(request: PromptGenRequest): { usd: number };
  /**
   * Executes `request` against the provider.
   *
   * @param request - The prompt-gen request to execute.
   * @param opts - Execution options.
   * @param opts.signal - Optional abort signal to cancel the request.
   * @returns The generated result.
   */
  execute(request: PromptGenRequest, opts: { signal?: AbortSignal }): Promise<PromptGenResult>;
};
