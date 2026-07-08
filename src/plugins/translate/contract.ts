/**
 * @file translate capability contract — task-owned; providers implement this.
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
 *
 */
export type TranslateResult = {
  text: string;
  detectedSourceLang?: string;
  costUsd: number;
  /** Token counts, model — metadata only. */
  meta?: Record<string, unknown>;
};

/**
 *
 */
export type TranslateHandler = {
  estimate(request: TranslateRequest): { usd: number };
  execute(request: TranslateRequest, opts: { signal?: AbortSignal }): Promise<TranslateResult>;
};
