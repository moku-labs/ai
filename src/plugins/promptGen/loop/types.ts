/**
 * @file runToolLoop — public types: the tool a caller defines, what a tool
 * returns, the loop's events, its options and its result.
 */
import type { z } from "zod";
import type {
  ChatMessage,
  ContentPart,
  PromptGenRequest,
  PromptGenResult,
  PromptGenUsage,
  ToolCall
} from "../contract";

/**
 * What one tool call returns: a value for the caller, the content the model
 * reads, the cost of the call and the ids of any outside work it started.
 * The loop journals it as the value of the tool's step, so it must be JSON-safe.
 *
 * @example
 * ```ts
 * // A frame reader answers with the frame and a caption; reading costs nothing.
 * const output: ToolOutput<{ frame: number }> = {
 *   value: { frame: 12 },
 *   content: [
 *     { type: "text", text: "Frame 12 of shot 3." },
 *     { type: "image", path: "frames/s3-012.png", mimeType: "image/png", hash: "9f2c1a" }
 *   ],
 *   costUsd: 0
 * };
 * ```
 */
export type ToolOutput<O = unknown> = {
  /** The tool's own result, for the caller; the model never sees it. */
  value: O;
  /** What the model reads as the tool result; `[]` is sent as `"(no output)"`. */
  content: ContentPart[];
  /** Cost of the call in USD; counts toward the loop's budget. */
  costUsd: number;
  /** Ids of outside work the tool started (render jobs, queue rows); opaque to the loop. */
  rows?: string[];
};

/**
 * A tool the model may call in {@link runToolLoop}: its name, description and
 * zod input schema, an optional cost estimate for the breaker, and how to run
 * it. A tool that starts outside work and waits for it may define `start` and
 * `wait`: the loop then journals the two halves as two steps, so a restart
 * after `start` only waits and never starts the work twice. A tool named
 * `"ask"` is never run: its call stops the loop with `stoppedBy: "asked"`.
 *
 * @example
 * ```ts
 * // A render tool: start queues a job, wait polls it; the breaker sees 0.40 USD per shot.
 * const renderShot: ToolSpec<{ shot: number }> = {
 *   name: "render_shot",
 *   description: "Render one shot as a video clip.",
 *   schema: z.object({ shot: z.number() }),
 *   estimateUsd: () => 0.4,
 *   run: async ({ shot }, signal) => renders.wait(await renders.queue(shot, signal), signal),
 *   start: async ({ shot }, signal) => ({ started: await renders.queue(shot, signal), rows: [`shot-${shot}`] }),
 *   wait: async (started, signal) => renders.wait(String(started), signal)
 * };
 * ```
 */
export type ToolSpec<I = unknown, O = unknown> = {
  /** Tool name the model calls. */
  name: string;
  /** What the tool does; the model reads it to decide when to call. */
  description: string;
  /** Input schema: checks the model's input and becomes the tool's JSON schema in the request. */
  schema: z.ZodType<I>;
  /**
   * Estimated cost of one call, checked by the breaker before the tool runs.
   * Absent means 0 and no check.
   *
   * @param input - The checked input of the call.
   * @returns The estimated cost in USD.
   */
  estimateUsd?(input: I): number;
  /**
   * Runs the tool. Used when the tool has no `start` and `wait` pair.
   *
   * @param input - The checked input of the call.
   * @param signal - Aborts the call.
   * @returns The tool output.
   */
  run(input: I, signal: AbortSignal): Promise<ToolOutput<O>>;
  /**
   * First half of a two-step tool: starts the outside work.
   *
   * @param input - The checked input of the call.
   * @param signal - Aborts the start.
   * @returns A JSON-safe handle of the started work, and the ids of its rows.
   */
  start?(input: I, signal: AbortSignal): Promise<{ started: unknown; rows?: string[] }>;
  /**
   * Second half of a two-step tool: waits for the started work.
   *
   * @param started - The handle `start` returned, as journaled.
   * @param signal - Aborts the wait.
   * @returns The tool output.
   */
  wait?(started: unknown, signal: AbortSignal): Promise<ToolOutput<O>>;
};

/**
 * Progress of a {@link runToolLoop} run, reported to `onStep`: one `model`
 * event per model call (replayed ones too), one `tool` event per answered
 * tool call, and `budget` events when finish mode starts (just before the
 * `model` event of the first call made in finish mode) or the breaker stops
 * the loop. `step` is the 1-based model turn; a tool event carries the turn of
 * the call it answers.
 *
 * @example
 * ```ts
 * // A plugin that runs an agent logs its progress.
 * const onStep = (event: LoopEvent): void => {
 *   if (event.kind === "tool") ctx.log.info("agent:tool", { step: event.step, name: event.name, rows: event.rows });
 *   if (event.kind === "budget" && event.mode === "stop") ctx.log.warn("agent:budget", { spentUsd: event.spentUsd });
 * };
 * ```
 */
export type LoopEvent =
  | {
      /** Event kind. */
      kind: "model";
      /** The 1-based model turn. */
      step: number;
      /** The model text; `null` when the turn is only tool calls. */
      text: string | null;
      /** Tool calls the model made in this turn. */
      toolCalls: ToolCall[];
      /** Cost of the model call in USD. */
      costUsd: number;
      /** Token usage of the model call. */
      usage: PromptGenUsage;
    }
  | {
      /** Event kind. */
      kind: "tool";
      /** The model turn the call belongs to. */
      step: number;
      /** Name of the called tool. */
      name: string;
      /** Id of the answered tool call. */
      callId: string;
      /** Cost of the call in USD. */
      costUsd: number;
      /** The first text part of the tool result, cut to 200 characters; `""` when none. */
      summary: string;
      /** Ids of outside work the call started: the start half's rows, else `ToolOutput.rows`, else `[]`. */
      rows: string[];
    }
  | {
      /** Event kind. */
      kind: "budget";
      /** Spend when the event fired, in USD. */
      spentUsd: number;
      /** The budget limit, in USD. */
      limitUsd: number;
      /** `"finish"`: spend crossed `finishAt × usd`; `"stop"`: the breaker stopped the loop. */
      mode: "finish" | "stop";
    };

/**
 * Options of {@link runToolLoop}: the model call, the conversation, the tools,
 * the budget and step limit, the caller's journal and the abort signal.
 *
 * @example
 * ```ts
 * // A review agent with a 2 USD budget; its own journal keys every step by the agent run.
 * const options: RunToolLoopOptions = {
 *   generate: (request, signal) => app.promptGen.generate(request, { signal, provider: "fal" }),
 *   model: "anthropic/claude-opus-5.5",
 *   system: "You review storyboard frames.",
 *   messages: [{ role: "user", content: "Check the framing of shot 3." }],
 *   tools: [readFrame, renderShot],
 *   budget: { usd: 2, finishAt: 0.8 },
 *   maxSteps: 30,
 *   step: (key, work) => agentJournal.step(`agent-7/${key}`, work),
 *   finishNote: "The budget is nearly spent. Finish with what you have.",
 *   signal: controller.signal
 * };
 * ```
 */
export type RunToolLoopOptions = {
  /** One model call; usually `app.promptGen.generate` with a provider that supports tools (fal). */
  generate: (request: PromptGenRequest, signal: AbortSignal) => Promise<PromptGenResult>;
  /** Provider model id sent with every call. */
  model: string;
  /** Reasoning effort, sent as `params.reasoning` when set. */
  reasoning?: "off" | "low" | "medium" | "high";
  /** System text of every call; marked as a prompt-cache breakpoint. */
  system: string;
  /** The conversation so far; never mutated. */
  messages: ChatMessage[];
  /** Tools the model may call. */
  tools: readonly ToolSpec[];
  /**
   * The budget in USD. Spend = `spentUsd` + the cost of every step + `spent()`.
   * The loop stops before a model call when spend reaches `usd`, and before a
   * tool with `estimateUsd` when spend plus the estimate would exceed it.
   * A model call made with spend at `finishAt × usd` or more starts finish
   * mode, once. Every check runs inside the work of the step it guards
   * (`model:<n>`, `tool:<callId>` or `tool:<callId>:start`), so a replayed
   * step is never checked again.
   */
  budget: {
    /** The limit in USD. */
    usd: number;
    /** Spend before this run, in USD. Default 0. */
    spentUsd?: number;
    /** Fraction of `usd` (0–1) at which finish mode starts. */
    finishAt: number;
    /** Spend outside the loop's steps, such as child rows; read at every check. */
    spent?: () => Promise<number>;
  };
  /** Most model calls, replayed ones included. */
  maxSteps: number;
  /**
   * The caller's own journal: runs `work` once per key and returns the stored
   * value on a replay. Keys are `model:<n>`, `tool:<callId>`,
   * `tool:<callId>:start` and `tool:<callId>:wait`; they start again at
   * `model:1` on every call, so a resumed conversation needs its own key
   * prefix. The value is JSON-safe and carries its cost; a `model:<n>` value
   * is `{ result, finish? }`. `work` may throw: the loop's own budget stop, or
   * a model or tool error. A work that throws must not be journaled, and its
   * error must reach the loop unchanged.
   */
  step: <T>(
    key: string,
    work: (signal: AbortSignal) => Promise<{ value: T; costUsd: number }>
  ) => Promise<T>;
  /** Called with every {@link LoopEvent}. */
  onStep?: (event: LoopEvent) => void;
  /**
   * User text added once when finish mode starts: the last message of that
   * model call's request, and in the history just before its answer. Not added
   * when a user message already has exactly this text.
   */
  finishNote?: string;
  /** Assistant turns whose tool-result images stay in the request. Default 2; older images become text. */
  keepImages?: number;
  /** Aborts the loop: it returns `stoppedBy: "cancel"` after the running step settles. */
  signal: AbortSignal;
};

/**
 * What {@link runToolLoop} returns: why it stopped, the spend, the number of
 * model calls, the full history (a valid history to resume from), the last
 * model text and, when the model called `ask`, that call's input.
 *
 * @example
 * ```ts
 * // The model asked the person; answer its open ask call and go on under a new key prefix.
 * const first = await runToolLoop(options); // { stoppedBy: "asked", asked: { input: { question: "Which take?" } }, ... }
 * const messages: ChatMessage[] = [...first.messages, { role: "tool", toolCallId: "call_9", content: "Take 2." }];
 * const step: RunToolLoopOptions["step"] = (key, work) => agentJournal.step(`agent-7/2/${key}`, work);
 * const second = await runToolLoop({ ...options, messages, step });
 * ```
 */
export type RunToolLoopResult = {
  /**
   * Why the loop stopped: the model answered without tool calls, the budget,
   * the step limit, the abort signal, or the model called `ask`.
   */
  stoppedBy: "done" | "budget" | "steps" | "cancel" | "asked";
  /** Spend at the stop, in USD: `budget.spentUsd` + step costs + `budget.spent()`. */
  spentUsd: number;
  /** Model calls made, replayed ones included. */
  steps: number;
  /** The history after `system`: the given messages, then every turn of this run. */
  messages: ChatMessage[];
  /** The last model text; `null` when it was empty or no model call ran. */
  finalText: string | null;
  /** The checked input of the `ask` call; set only when `stoppedBy` is `"asked"`. */
  asked?: { input: unknown };
};
