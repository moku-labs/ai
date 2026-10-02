/**
 * @file runToolLoop — the tool loop: model turns and their tool calls, each
 * one a step of the caller's journal, until the model answers without tools,
 * a limit stops it, the run is aborted or the model asks the person.
 *
 * Every budget decision runs inside the work of the step it guards. The
 * journal never stores a work that throws, so a replayed step is never
 * checked again, even when the outside spend has grown since.
 */
import type {
  ChatMessage,
  PromptGenRequest,
  PromptGenResult,
  ToolCall,
  ToolDefinition
} from "../contract";
import {
  assistantMessage,
  NO_TEXT,
  notRunAnswers,
  summaryOf,
  textOrNull,
  toolMessage,
  withFinishNote,
  withoutOldImages
} from "./history";
import {
  answerWithText,
  type CallPlan,
  planCall,
  runTool,
  type ToolAnswer,
  toolDefinitions
} from "./tools";
import type { LoopEvent, RunToolLoopOptions, RunToolLoopResult, ToolSpec } from "./types";

/** Assistant turns whose tool-result images stay in the request by default. */
const DEFAULT_KEEP_IMAGES = 2;

/** The answer to a second `ask` call in one turn: only the first one waits for the person. */
const ONE_QUESTION = "Ask one question at a time.";

/** Why the loop stopped. */
type StopReason = RunToolLoopResult["stoppedBy"];

/** Stops that answer the calls they leave open, so the history stays valid to resume from. */
const ANSWERS_OPEN_CALLS: ReadonlySet<StopReason> = new Set(["budget", "steps", "cancel"]);

/**
 * The journaled value of a `model:<n>` step: the model answer and, when
 * finish mode started before this call, the spend at that point. A replay
 * puts the finish note at the same place in the history.
 */
type ModelStep = {
  /** The model answer. */
  result: PromptGenResult;
  /** Set when finish mode started before this call. */
  finish?: { spentUsd: number };
};

/** One run of the loop: its options, the tool definitions and the progress so far. */
type Loop = {
  /** The caller's options. */
  options: RunToolLoopOptions;
  /** The tool definitions every request carries. */
  definitions: ToolDefinition[];
  /** The history: the given messages, then this run's turns. */
  messages: ChatMessage[];
  /** Cost of every step so far, replayed ones included. */
  stepCostUsd: number;
  /** Model calls so far, replayed ones included. */
  steps: number;
  /** The last model text. */
  finalText: string | null;
  /** Finish mode has started. */
  finishing: boolean;
  /** The input of the turn's first `ask` call, held for the person. */
  asked: { input: unknown } | undefined;
};

/**
 * Thrown inside a step's work when the budget cannot pay for the step. The
 * journal does not store a work that throws; the loop turns it into a
 * `"budget"` stop.
 */
class BudgetStop extends Error {
  /** The spend when the check failed. */
  readonly spentUsd: number;

  /**
   * Creates the stop at the spend that failed the check.
   *
   * @param spentUsd - The spend when the check failed.
   */
  constructor(spentUsd: number) {
    super("[ai] runToolLoop budget reached.\n  The loop stops before this step.");
    this.name = "BudgetStop";
    this.spentUsd = spentUsd;
  }
}

/**
 * Sets up a run: copies the given messages and builds the tool definitions.
 *
 * @param options - The caller's options.
 * @returns The loop, before its first step.
 */
function startLoop(options: RunToolLoopOptions): Loop {
  return {
    options,
    definitions: toolDefinitions(options.tools),
    messages: [...options.messages],
    stepCostUsd: 0,
    steps: 0,
    finalText: NO_TEXT,
    finishing: false,
    asked: undefined
  };
}

/**
 * Reports one event to the caller's `onStep`.
 *
 * @param loop - The loop.
 * @param event - The event.
 */
function report(loop: Loop, event: LoopEvent): void {
  loop.options.onStep?.(event);
}

/**
 * Reports a budget event.
 *
 * @param loop - The loop.
 * @param spentUsd - The spend that fired it.
 * @param mode - `"finish"` when finish mode starts, `"stop"` when the breaker stops the loop.
 */
function reportBudget(loop: Loop, spentUsd: number, mode: "finish" | "stop"): void {
  report(loop, { kind: "budget", spentUsd, limitUsd: loop.options.budget.usd, mode });
}

/**
 * The spend the budget checks: spend before the run, every step's cost, and
 * the caller's outside spend.
 *
 * @param loop - The loop.
 * @returns The spend in USD.
 */
async function spentNow(loop: Loop): Promise<number> {
  const { budget } = loop.options;
  const outsideUsd = (await budget.spent?.()) ?? 0;
  return (budget.spentUsd ?? 0) + loop.stepCostUsd + outsideUsd;
}

/**
 * The request of a model call: the history with old tool images dropped, the
 * tools, a cached system text and the reasoning when set.
 *
 * @param loop - The loop.
 * @param history - The history to send.
 * @returns The request.
 */
function modelRequest(loop: Loop, history: readonly ChatMessage[]): PromptGenRequest {
  const { options } = loop;
  const request: PromptGenRequest = {
    prompt: "",
    system: options.system,
    model: options.model,
    messages: withoutOldImages(history, options.keepImages ?? DEFAULT_KEEP_IMAGES),
    tools: loop.definitions,
    cacheSystem: true
  };
  if (options.reasoning === undefined) return request;
  return { ...request, params: { reasoning: options.reasoning } };
}

/**
 * The work of a `model:<n>` step: the budget gate, the finish decision, then
 * the model call. Both decisions live in the step, so a replay never makes them again.
 *
 * @param loop - The loop.
 * @param signal - The journal's signal for the call.
 * @returns The step value and its cost.
 * @throws {BudgetStop} When spend has reached the limit.
 */
async function askModel(
  loop: Loop,
  signal: AbortSignal
): Promise<{ value: ModelStep; costUsd: number }> {
  // The model call itself costs: no call once spend reaches the limit.
  const spentUsd = await spentNow(loop);
  if (spentUsd >= loop.options.budget.usd) throw new BudgetStop(spentUsd);

  // Finish mode starting now ends this request's history with the finish note.
  const { finishAt, usd } = loop.options.budget;
  const isFinishStarting = !loop.finishing && spentUsd >= finishAt * usd;
  const history = isFinishStarting
    ? withFinishNote(loop.messages, loop.options.finishNote)
    : loop.messages;

  const result = await loop.options.generate(modelRequest(loop, history), signal);
  const value: ModelStep = isFinishStarting ? { result, finish: { spentUsd } } : { result };
  return { value, costUsd: result.costUsd };
}

/**
 * Starts finish mode as a model step recorded it: the note joins the history
 * before that step's answer, and the start is reported.
 *
 * @param loop - The loop.
 * @param spentUsd - The spend when finish mode started.
 */
function startFinish(loop: Loop, spentUsd: number): void {
  loop.finishing = true;
  loop.messages = withFinishNote(loop.messages, loop.options.finishNote);
  reportBudget(loop, spentUsd, "finish");
}

/**
 * One model call as the `model:<n>` step; its answer joins the history and is reported.
 *
 * @param loop - The loop.
 * @returns The model answer, live or replayed.
 */
async function callModel(loop: Loop): Promise<PromptGenResult> {
  const turn = loop.steps + 1;
  const { result, finish } = await loop.options.step(`model:${turn}`, signal =>
    askModel(loop, signal)
  );

  // Finish mode started before this call: its note comes before the answer.
  if (finish !== undefined) startFinish(loop, finish.spentUsd);

  // The answer joins the history; its text is the latest final text.
  loop.steps = turn;
  loop.stepCostUsd += result.costUsd;
  loop.messages.push(assistantMessage(result));
  loop.finalText = textOrNull(result.text);

  report(loop, {
    kind: "model",
    step: turn,
    text: loop.finalText,
    toolCalls: result.toolCalls,
    costUsd: result.costUsd,
    usage: result.usage
  });
  return result;
}

/**
 * The breaker of a costed tool, run inside the tool's first step: spend plus
 * the tool's estimate must stay within the limit.
 *
 * @param loop - The loop.
 * @param tool - The tool about to run.
 * @param input - Its checked input.
 * @throws {BudgetStop} When the tool would pass the limit.
 */
async function passBreaker(loop: Loop, tool: ToolSpec, input: unknown): Promise<void> {
  if (tool.estimateUsd === undefined) return;

  const estimateUsd = tool.estimateUsd(input);
  const spentUsd = await spentNow(loop);
  if (spentUsd + estimateUsd > loop.options.budget.usd) throw new BudgetStop(spentUsd);
}

/**
 * Puts a tool call's answer into the history and reports it.
 *
 * @param loop - The loop.
 * @param call - The answered call.
 * @param answer - Its output and rows.
 */
function recordAnswer(loop: Loop, call: ToolCall, answer: ToolAnswer): void {
  const { output, rows } = answer;
  loop.stepCostUsd += output.costUsd;
  loop.messages.push(toolMessage(call.id, output.content));

  report(loop, {
    kind: "tool",
    step: loop.steps,
    name: call.name,
    callId: call.id,
    costUsd: output.costUsd,
    summary: summaryOf(output.content),
    rows
  });
}

/**
 * The answer to a call that is not held: the tool's output behind its
 * breaker, or a text the model reads (unknown tool, bad input, a second ask).
 *
 * @param loop - The loop.
 * @param call - The model's tool call.
 * @param plan - What to do with it.
 * @returns The answer, live or replayed.
 * @throws {BudgetStop} When a costed tool would pass the limit.
 */
async function answerPlan(loop: Loop, call: ToolCall, plan: CallPlan): Promise<ToolAnswer> {
  const { step, signal } = loop.options;
  if (plan.kind === "text") return answerWithText(step, call.id, plan.text);
  if (plan.kind === "ask") return answerWithText(step, call.id, ONE_QUESTION);

  const breaker = (): Promise<void> => passBreaker(loop, plan.tool, plan.input);
  return runTool({ step, signal, breaker }, plan.tool, call.id, plan.input);
}

/**
 * Answers one tool call. The turn's first `ask` is held for the person; every
 * other call is answered through the journal.
 *
 * @param loop - The loop.
 * @param call - The model's tool call.
 * @throws {unknown} A {@link BudgetStop}, the tool's error, or the abort reason.
 */
async function answerCall(loop: Loop, call: ToolCall): Promise<void> {
  const plan = planCall(loop.options.tools, call);

  // The turn's first ask is never run: the person answers it after the turn.
  if (plan.kind === "ask" && loop.asked === undefined) {
    loop.asked = { input: plan.input };
    return;
  }

  // The answer joins the history; an abort ends the turn once it settled.
  recordAnswer(loop, call, await answerPlan(loop, call, plan));
  loop.options.signal.throwIfAborted();
}

/**
 * Answers a turn's tool calls in order. A held `ask` stops the loop once the
 * other calls ran.
 *
 * @param loop - The loop.
 * @param calls - The turn's tool calls.
 * @returns `"asked"` when an ask is held, else `undefined`.
 */
async function answerCalls(loop: Loop, calls: ToolCall[]): Promise<StopReason | undefined> {
  for (const call of calls) await answerCall(loop, call);
  return loop.asked === undefined ? undefined : "asked";
}

/**
 * One turn: the checks before the model call, the call, then its tool calls.
 *
 * @param loop - The loop.
 * @returns The stop reason, or `undefined` when the next turn may run.
 */
async function runTurn(loop: Loop): Promise<StopReason | undefined> {
  // Before a model call: an abort, then the step limit. The budget is checked inside the step.
  loop.options.signal.throwIfAborted();
  if (loop.steps >= loop.options.maxSteps) return "steps";

  // The model answers; an abort ends the turn once it settled; no tool calls is the final answer.
  const result = await callModel(loop);
  loop.options.signal.throwIfAborted();
  if (result.toolCalls.length === 0) return "done";

  return answerCalls(loop, result.toolCalls);
}

/**
 * Turns a thrown step into a stop: the budget breaker, or an aborted run.
 *
 * @param loop - The loop.
 * @param error - What the step threw.
 * @returns `"budget"` or `"cancel"`.
 * @throws {unknown} `error` itself when it is neither.
 */
function stopReasonOf(loop: Loop, error: unknown): StopReason {
  if (error instanceof BudgetStop) {
    reportBudget(loop, error.spentUsd, "stop");
    return "budget";
  }
  if (loop.options.signal.aborted) return "cancel";
  throw error;
}

/**
 * The loop's result: a budget, steps or cancel stop first answers the calls
 * it left open; `asked` is set only for an `"asked"` stop.
 *
 * @param loop - The loop.
 * @param stoppedBy - Why it stopped.
 * @returns The result.
 */
async function resultOf(loop: Loop, stoppedBy: StopReason): Promise<RunToolLoopResult> {
  // A budget, steps or cancel stop answers its open calls, so the history can resume.
  if (ANSWERS_OPEN_CALLS.has(stoppedBy)) {
    loop.messages.push(...notRunAnswers(loop.messages, stoppedBy));
  }

  const result: RunToolLoopResult = {
    stoppedBy,
    spentUsd: await spentNow(loop),
    steps: loop.steps,
    messages: loop.messages,
    finalText: loop.finalText
  };
  const asked = stoppedBy === "asked" ? loop.asked : undefined;
  return asked === undefined ? result : { ...result, asked };
}

/**
 * Runs a tool-calling conversation to its end. Each model call is the
 * journal step `model:<n>`, each tool call `tool:<callId>` (or
 * `tool:<callId>:start` and `tool:<callId>:wait` for a tool with both
 * halves), so a restart with the same journal replays every finished step
 * without calling the model or a tool again. The budget checks run inside
 * the step they guard, so a replayed step is never checked again. The loop
 * stops when the model answers without tool calls (`"done"`), the budget or
 * `maxSteps` is reached, the signal is aborted (after the running step
 * settles), or the model calls the caller's `ask` tool (after the other calls
 * of that turn). On a budget, steps or cancel stop the open calls are
 * answered `Not run: <reason>.`, so `messages` is a valid history to resume
 * from. Calls only `options.generate`; a tool's error and a `generate` error
 * propagate unless the run was aborted.
 *
 * @param options - The model call, the conversation, the tools, the budget, the journal and the signal.
 * @returns Why the loop stopped, the spend, the model calls, the history and the last model text.
 * @throws {unknown} A `generate` or tool error, when the run was not aborted.
 * @example
 * ```ts
 * // A review agent on fal with a 2 USD budget, journaled under its agent run.
 * const result = await runToolLoop({
 *   generate: (request, signal) => app.promptGen.generate(request, { signal, provider: "fal" }),
 *   model: "anthropic/claude-opus-5.5", system: "You review storyboard frames.", messages, tools: [readFrame],
 *   budget: { usd: 2, finishAt: 0.8 }, maxSteps: 30, step: (key, work) => agentJournal.step(`agent-7/${key}`, work), signal
 * }); // { stoppedBy: "done", steps: 2, finalText: "Shot 3 cuts the subject at the chin.", ... }
 * ```
 */
export async function runToolLoop(options: RunToolLoopOptions): Promise<RunToolLoopResult> {
  const loop = startLoop(options);

  // Turns run until one stops the loop; a thrown step is a budget stop, a cancel, or an error.
  let stoppedBy: StopReason | undefined;
  try {
    while (stoppedBy === undefined) stoppedBy = await runTurn(loop);
  } catch (error) {
    stoppedBy = stopReasonOf(loop, error);
  }

  return resultOf(loop, stoppedBy);
}
