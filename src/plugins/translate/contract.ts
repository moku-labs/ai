/**
 * @file translate capability contract — task-owned; providers implement this.
 */

/**
 * A request to translate `text` into `targetLang`. Providers may support
 * additional per-provider knobs via `params`.
 *
 * @example
 * ```ts
 * const request: TranslateRequest = { text: "Hello, world!", targetLang: "es" };
 * ```
 */
export type TranslateRequest = {
  text: string;
  /** Target language, BCP-47. */
  targetLang: string;
  /** Source language; omitted = auto-detect. */
  sourceLang?: string;
  model?: string;
  params?: Record<string, unknown>;
};

/**
 * The result of a translation: the translated text and its cost, plus the
 * optional detected source language and provider metadata.
 *
 * @example
 * ```ts
 * const result: TranslateResult = { text: "Hola, mundo!", costUsd: 0.0004 };
 * ```
 */
export type TranslateResult = {
  text: string;
  detectedSourceLang?: string;
  costUsd: number;
  /** Token counts, model — metadata only. */
  meta?: Record<string, unknown>;
};

/**
 * The handler contract a translate provider plugin registers with `registry`
 * under the `"translate"` task. Provider plugins `import type` this to
 * implement it; `translate` performs the one audited cast to this type at
 * its own `resolve()` call site (spec/09 R9).
 *
 * @example
 * ```ts
 * const handler: TranslateHandler = {
 *   estimate: request => ({ usd: request.text.length * 0.00001 }),
 *   execute: async request => ({ text: request.text, costUsd: 0 })
 * };
 * ```
 */
export type TranslateHandler = {
  /**
   * Estimates the cost of executing `request`, without performing it.
   *
   * @param request - The translate request to estimate.
   * @returns The estimated cost in USD.
   */
  estimate(request: TranslateRequest): { usd: number };
  /**
   * Executes `request` against the provider.
   *
   * @param request - The translate request to execute.
   * @param opts - Execution options.
   * @param opts.signal - Optional abort signal to cancel the request.
   * @returns The translation result.
   */
  execute(request: TranslateRequest, opts: { signal?: AbortSignal }): Promise<TranslateResult>;
};
