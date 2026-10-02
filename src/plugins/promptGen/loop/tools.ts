/**
 * @file runToolLoop — the tools: their definitions in the request, the input
 * check, and one journaled run (one step, or two for a start/wait tool).
 */
import { z } from "zod";
import type { ToolCall, ToolDefinition } from "../contract";
import type { RunToolLoopOptions, ToolOutput, ToolSpec } from "./types";

/** The name of the tool whose call stops the loop for the person's answer. */
const ASK_TOOL = "ask";

/**
 * The caller's journal, as the loop options pass it.
 *
 * @example
 * ```ts
 * const step: JournalStep = (key, work) => agentJournal.step(`agent-7/${key}`, work);
 * ```
 */
export type JournalStep = RunToolLoopOptions["step"];

/** The result of the input check: the parsed input, or the text the model reads instead. */
type InputCheck = { ok: true; input: unknown } | { ok: false; text: string };

/**
 * What the loop does with one tool call: answer it with a text (unknown tool,
 * invalid input), hold it for the person (`ask`), or run the tool.
 *
 * @example
 * ```ts
 * const plan: CallPlan = { kind: "text", text: 'Unknown tool "zoom".' };
 * ```
 */
export type CallPlan =
  | { kind: "text"; text: string }
  | { kind: "ask"; input: unknown }
  | { kind: "run"; tool: ToolSpec; input: unknown };

/**
 * One tool call's answer: the output and the ids of the outside work it started.
 *
 * @example
 * ```ts
 * const answer: ToolAnswer = { output: { value: "job-3", content: [{ type: "text", text: "Rendered." }], costUsd: 0.4 }, rows: ["row-3"] };
 * ```
 */
export type ToolAnswer = { output: ToolOutput; rows: string[] };

/**
 * How one tool call runs: the caller's journal, the loop's abort signal, and
 * the breaker checked inside the call's first step.
 *
 * @example
 * ```ts
 * const context: CallContext = { step, signal: controller.signal, breaker: async () => {} };
 * ```
 */
export type CallContext = {
  /** The caller's journal. */
  step: JournalStep;
  /** The loop's abort signal; an abort between the halves of a start/wait tool stops before `wait`. */
  signal: AbortSignal;
  /**
   * Runs inside the work of the call's first step (`tool:<id>` or `tool:<id>:start`),
   * before the tool. Throws to stop the loop before the tool runs; a replayed step never runs it.
   */
  breaker: () => Promise<void>;
};

/** The journaled value of a start half: the handle `wait` gets, and the rows it started. */
type StartedWork = { started: unknown; rows: string[] };

/** A tool with both halves, so a restart after `start` only waits. */
type HalvedTool = ToolSpec & Required<Pick<ToolSpec, "start" | "wait">>;

/**
 * The JSON schema of a tool's input as the request carries it: the input side
 * of the zod schema, without the `$schema` key.
 *
 * @param schema - The tool's zod schema.
 * @returns The JSON schema.
 * @example
 * ```ts
 * inputSchemaOf(z.object({ shot: z.number() })); // { type: "object", properties: { shot: { type: "number" } }, required: ["shot"] }
 * ```
 */
function inputSchemaOf(schema: ToolSpec["schema"]): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, { io: "input" });
  return Object.fromEntries(Object.entries(jsonSchema).filter(([key]) => key !== "$schema"));
}

/**
 * The tool definitions of every model request.
 *
 * @param tools - The caller's tools.
 * @returns One definition per tool, in order.
 * @example
 * ```ts
 * toolDefinitions([readFrame]); // [{ name: "read_frame", description: "Return one frame.", inputSchema: { type: "object", ... } }]
 * ```
 */
export function toolDefinitions(tools: readonly ToolSpec[]): ToolDefinition[] {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: inputSchemaOf(tool.schema)
  }));
}

/**
 * A tool output that is only text: the answer to a call the loop does not run.
 *
 * @param text - The text the model reads.
 * @returns The output, cost 0.
 * @example
 * ```ts
 * textOutput('Unknown tool "zoom".'); // { value: 'Unknown tool "zoom".', content: [{ type: "text", text: 'Unknown tool "zoom".' }], costUsd: 0 }
 * ```
 */
function textOutput(text: string): ToolOutput<string> {
  return { value: text, content: [{ type: "text", text }], costUsd: 0 };
}

/**
 * Checks a call's input against the tool's zod schema.
 *
 * @param tool - The called tool.
 * @param input - The input the model sent.
 * @returns The parsed input, or `Invalid input for <name>: <zod error>`.
 * @example
 * ```ts
 * checkInput(readFrame, { shot: "three" }); // { ok: false, text: "Invalid input for read_frame: ✖ Invalid input: expected number, received string\n  → at shot" }
 * ```
 */
function checkInput(tool: ToolSpec, input: unknown): InputCheck {
  const parsed = tool.schema.safeParse(input);
  if (parsed.success) return { ok: true, input: parsed.data };
  return { ok: false, text: `Invalid input for ${tool.name}: ${z.prettifyError(parsed.error)}` };
}

/**
 * Decides what the loop does with one call: an unknown name or an input that
 * fails the schema is answered with a text; a checked `ask` is held for the
 * person (only when the caller defined an `ask` tool); any other checked call runs.
 *
 * @param tools - The caller's tools.
 * @param call - The model's tool call.
 * @returns The plan for the call.
 * @example
 * ```ts
 * planCall([readFrame], { id: "c1", name: "zoom", input: {} }); // { kind: "text", text: 'Unknown tool "zoom".' }
 * ```
 */
export function planCall(tools: readonly ToolSpec[], call: ToolCall): CallPlan {
  const tool = tools.find(candidate => candidate.name === call.name);
  if (tool === undefined) return { kind: "text", text: `Unknown tool "${call.name}".` };

  const checked = checkInput(tool, call.input);
  if (!checked.ok) return { kind: "text", text: checked.text };
  if (tool.name === ASK_TOOL) return { kind: "ask", input: checked.input };
  return { kind: "run", tool, input: checked.input };
}

/**
 * Tells whether a tool runs as two halves.
 *
 * @param tool - A tool.
 * @returns True when it has both `start` and `wait`.
 * @example
 * ```ts
 * isHalved(readFrame); // false: it only has run
 * ```
 */
function isHalved(tool: ToolSpec): tool is HalvedTool {
  return tool.start !== undefined && tool.wait !== undefined;
}

/**
 * Runs a two-halved tool as two steps: the start half journals the started
 * work, so a replay never starts it twice; the wait half journals the output.
 * The breaker runs inside the start half only. An abort between the halves
 * throws, so the wait never begins.
 *
 * @param context - The journal, the abort signal and the breaker.
 * @param tool - The tool, with both halves.
 * @param callId - Id of the tool call.
 * @param input - The checked input.
 * @returns The output and the start half's rows.
 */
async function runHalves(
  context: CallContext,
  tool: HalvedTool,
  callId: string,
  input: unknown
): Promise<ToolAnswer> {
  const { step, signal, breaker } = context;

  // The start half: the breaker, then the start; its value is the handle and the rows, at no cost.
  const work = await step(`tool:${callId}:start`, async stepSignal => {
    await breaker();
    const begun = await tool.start(input, stepSignal);
    const value: StartedWork = { started: begun.started, rows: begun.rows ?? [] };
    return { value, costUsd: 0 };
  });
  signal.throwIfAborted();

  // The wait half: its value is the tool output, at the output's cost.
  const output = await step(`tool:${callId}:wait`, async stepSignal => {
    const waited = await tool.wait(work.started, stepSignal);
    return { value: waited, costUsd: waited.costUsd };
  });
  const rows = work.rows.length > 0 ? work.rows : (output.rows ?? []);
  return { output, rows };
}

/**
 * Runs one checked tool call through the journal: one `tool:<id>` step, or
 * `tool:<id>:start` and `tool:<id>:wait` for a tool with both halves. The
 * breaker runs inside the first step, before the tool.
 *
 * @param context - The journal, the abort signal and the breaker.
 * @param tool - The called tool.
 * @param callId - Id of the tool call.
 * @param input - The checked input.
 * @returns The output and the rows of the outside work it started.
 * @example
 * ```ts
 * await runTool({ step, signal, breaker: async () => {} }, readFrame, "c1", { shot: 3 }); // { output: { value: 3, content: [{ type: "text", text: "Frame of shot 3." }], costUsd: 0 }, rows: [] }
 * ```
 */
export async function runTool(
  context: CallContext,
  tool: ToolSpec,
  callId: string,
  input: unknown
): Promise<ToolAnswer> {
  if (isHalved(tool)) return runHalves(context, tool, callId, input);

  const output = await context.step(`tool:${callId}`, async stepSignal => {
    await context.breaker();
    const ran = await tool.run(input, stepSignal);
    return { value: ran, costUsd: ran.costUsd };
  });
  return { output, rows: output.rows ?? [] };
}

/**
 * Answers a call the loop does not run (unknown tool, invalid input, a second
 * ask) with a text result, journaled as one `tool:<id>` step at no cost.
 *
 * @param step - The caller's journal.
 * @param callId - Id of the tool call.
 * @param text - The text the model reads.
 * @returns The output, with no rows.
 * @example
 * ```ts
 * await answerWithText(step, "c1", 'Unknown tool "zoom".'); // { output: { value: 'Unknown tool "zoom".', content: [{ type: "text", text: 'Unknown tool "zoom".' }], costUsd: 0 }, rows: [] }
 * ```
 */
export async function answerWithText(
  step: JournalStep,
  callId: string,
  text: string
): Promise<ToolAnswer> {
  const output = await step(`tool:${callId}`, async () => ({
    value: textOutput(text),
    costUsd: 0
  }));
  return { output, rows: [] };
}
