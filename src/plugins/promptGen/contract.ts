/**
 * @file prompt-gen capability contract — task-owned; providers implement this.
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
 *
 */
export type PromptGenResult = {
  text: string;
  costUsd: number;
  /** Token counts, model — metadata only. */
  meta?: Record<string, unknown>;
};

/**
 *
 */
export type PromptGenHandler = {
  estimate(request: PromptGenRequest): { usd: number };
  execute(request: PromptGenRequest, opts: { signal?: AbortSignal }): Promise<PromptGenResult>;
};
