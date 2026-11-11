/**
 * @file The `moku call` command: one provider endpoint
 * through the normal run path. stdout holds exactly one JSON line (`CallOutput`) on every path;
 * everything human goes to stderr through the branded console.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CompiledBuild } from "../../buildfile/types";
import type { ItemRow } from "../../journal/types";
import type { RunEvent, RunResult } from "../../runner/types";
import type { CallError, CallOutput, CommandContext, CommandFlags } from "../types";
import { EXIT_CODES } from "../types";

/** The `runId` of an output for which no run started (JSON `null`). */
// eslint-disable-next-line unicorn/no-null -- the CallOutput contract says `runId: null` for a usage error
const NO_RUN = null;

/** The `paused` error message: the same command again adopts the submitted job. */
const PAUSED_MESSAGE =
  "[ai] The call was paused.\n  Run the same command again: a submitted job is adopted, not paid twice.";

/** The `run` error message for a run that ended with neither an answer nor a reason. */
const NO_ANSWER_MESSAGE = "[ai] The call ended without an answer.";

/** The outcome of one parsing step: a value, or the usage message to print. */
type Step<T> = { ok: true; value: T } | { ok: false; message: string };

/** What the drained `runner.events()` stream said about the one item. */
type Records = {
  /** True once an `item:dispatching` record was seen: a provider call really started. */
  dispatched: boolean;
  /** The terminal failure of the item (`item:failed` or `item:flagged`), if any. */
  failure: CallError | undefined;
};

/** What the run left behind: its result and what its stream recorded. */
type Finished = { result: RunResult; records: Records };

/** One command outcome: the line to print and the exit code. */
type Outcome = { output: CallOutput; code: number };

/**
 * Replaces the log sinks with one that sends `warn` and `error` entries to
 * stderr through the branded console and drops `info` and `debug`. The default
 * sink prints every entry with `console.log`, which would break the one-line stdout.
 *
 * @param context - CommandContext (branded console + log).
 * @example
 * ```ts
 * routeLogsToStderr(context);
 * ```
 */
function routeLogsToStderr(context: CommandContext): void {
  context.log.clearSinks();
  context.log.addSink({
    write: entry => {
      if (entry.level === "warn") context.ui.warn(entry.event);
      if (entry.level === "error") context.ui.error(entry.event);
    }
  });
}

/**
 * Reads the text of `--input`: stdin for `-`, the file for `@<path>`, else the value itself.
 *
 * @param context - CommandContext (stdin reader).
 * @param raw - The raw `--input` value.
 * @returns The JSON text, or the usage message for an unreadable file.
 * @example
 * ```ts
 * await readInputText(context, "@body.json"); // { ok: true, value: "{…}" }
 * ```
 */
async function readInputText(context: CommandContext, raw: string): Promise<Step<string>> {
  if (raw === "-") return { ok: true, value: await context.readIn() };
  if (!raw.startsWith("@")) return { ok: true, value: raw };

  const file = raw.slice(1);
  try {
    return { ok: true, value: await readFile(file, "utf8") };
  } catch {
    return { ok: false, message: `cannot read --input file "${file}"` };
  }
}

/**
 * Parses `--input` text into a plain JSON object.
 *
 * @param text - The JSON text.
 * @returns The object, or the usage message for invalid JSON or a non-object value.
 * @example
 * ```ts
 * parseInputObject('{"a":1}'); // { ok: true, value: { a: 1 } }
 * ```
 */
function parseInputObject(text: string): Step<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: "--input is not valid JSON" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: "--input must be a JSON object" };
  }
  return { ok: true, value: Object.fromEntries(Object.entries(parsed)) };
}

/**
 * Reads and validates the endpoint input from `--input`.
 *
 * @param context - CommandContext (stdin reader).
 * @param raw - The raw `--input` value, if given.
 * @returns The input object, or the usage message.
 * @example
 * ```ts
 * await readInput(context, "-");
 * ```
 */
async function readInput(
  context: CommandContext,
  raw: string | undefined
): Promise<Step<Record<string, unknown>>> {
  if (raw === undefined)
    return { ok: false, message: "moku call requires --input <json | @file | ->" };

  const text = await readInputText(context, raw);
  return text.ok ? parseInputObject(text.value) : text;
}

/**
 * Compiles the one-item `call` build. The item id is the endpoint, so the
 * journal label groups spend per endpoint. JSON is valid YAML. No `provider`:
 * the first one registered for `call` runs it.
 *
 * @param context - CommandContext (buildfile).
 * @param endpoint - The endpoint id.
 * @param input - The endpoint's own input.
 * @returns The compiled build, or the compiler's message as a usage error.
 * @example
 * ```ts
 * await compileCall(context, "fal-ai/sam-3/image", { prompt: "wall" });
 * ```
 */
async function compileCall(
  context: CommandContext,
  endpoint: string,
  input: Record<string, unknown>
): Promise<Step<CompiledBuild>> {
  const spec = {
    version: 1,
    name: "call",
    items: [{ task: "call", id: endpoint, input: { endpoint, input } }]
  };

  try {
    return {
      ok: true,
      value: await context.buildfile.compile({ lang: "yaml", text: JSON.stringify(spec) })
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Folds one stream record into the item's records: a dispatch marks the call
 * as paid for, a failed or flagged record is its terminal failure.
 *
 * @param records - The records so far (mutated).
 * @param event - The stream record.
 * @example
 * ```ts
 * recordEvent(records, { type: "item:dispatching", runId: "r", itemId: "i" });
 * ```
 */
function recordEvent(records: Records, event: RunEvent): void {
  if (event.type === "item:dispatching") records.dispatched = true;
  if (event.type === "item:failed") {
    records.failure = { class: event.errorClass, message: event.message ?? event.errorClass };
  }
  if (event.type === "item:flagged") {
    records.failure = { class: "content-policy", message: event.message ?? "content-policy" };
  }
}

/**
 * Starts the run and drains its event stream, which is opened synchronously
 * right after `run()` (the `moku run` pattern).
 *
 * @param context - CommandContext (runner).
 * @param build - The compiled one-item build.
 * @param signal - The SIGINT-wired abort signal.
 * @returns The run result and the records its stream held.
 * @example
 * ```ts
 * const { result, records } = await runBuild(context, build, signal);
 * ```
 */
async function runBuild(
  context: CommandContext,
  build: CompiledBuild,
  signal: AbortSignal
): Promise<Finished> {
  const running = context.runner.run({ builds: [build] }, { signal });
  const records: Records = { dispatched: false, failure: undefined };
  for await (const event of context.runner.events()) {
    recordEvent(records, event);
  }
  return { result: await running, records };
}

/**
 * Builds the success output of a done item: fal's answer parsed into `result`,
 * or, with `--out`, written byte for byte to the file whose absolute path is `out`.
 *
 * @param context - CommandContext (store).
 * @param outFile - The `--out` value, if given.
 * @param endpoint - The endpoint id.
 * @param item - The done journal item (with its content hash).
 * @param finished - The run result and its stream records.
 * @returns The `ok: true` output.
 * @example
 * ```ts
 * const output = await answerOf(context, undefined, "ep", item, finished);
 * ```
 */
async function answerOf(
  context: CommandContext,
  outFile: string | undefined,
  endpoint: string,
  item: ItemRow & { contentHash: string },
  finished: Finished
): Promise<CallOutput> {
  const base = {
    ok: true as const,
    endpoint,
    costUsd: item.actualCostUsd ?? 0,
    reused: !finished.records.dispatched,
    runId: finished.result.runId
  };
  const bytes = await context.store.read(item.contentHash);
  if (outFile === undefined)
    return { ...base, result: JSON.parse(new TextDecoder().decode(bytes)) };

  const out = path.resolve(outFile);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, bytes);
  return { ...base, out };
}

/**
 * Builds the `ok: false` output with exit code for an error.
 *
 * @param endpoint - The endpoint id.
 * @param runId - The run id, or null when no run started.
 * @param error - Why the call did not end ok.
 * @param code - The exit code.
 * @returns The outcome.
 * @example
 * ```ts
 * failure("ep", NO_RUN, { class: "usage", message: "…" }, EXIT_CODES.usage);
 * ```
 */
function failure(endpoint: string, runId: string | null, error: CallError, code: number): Outcome {
  return { output: { ok: false, endpoint, costUsd: 0, runId, error }, code };
}

/**
 * Maps a finished run to the outcome: a failed or flagged item first, then a
 * done item with its answer, then a drained run, else a run that failed
 * before an item ran (its own error message).
 *
 * @param context - CommandContext (journal, store).
 * @param flags - Parsed command flags (`out`).
 * @param endpoint - The endpoint id.
 * @param finished - The run result and its stream records.
 * @returns The outcome to print.
 * @example
 * ```ts
 * const { output, code } = await settle(context, flags, "ep", finished);
 * ```
 */
async function settle(
  context: CommandContext,
  flags: CommandFlags,
  endpoint: string,
  finished: Finished
): Promise<Outcome> {
  const { result, records } = finished;
  if (records.failure) return failure(endpoint, result.runId, records.failure, EXIT_CODES.failure);

  const item = context.journal.listItems(result.runId)[0];
  if (item?.status === "done" && item.contentHash !== null) {
    const output = await answerOf(
      context,
      flags.out,
      endpoint,
      { ...item, contentHash: item.contentHash },
      finished
    );
    return { output, code: EXIT_CODES.ok };
  }

  if (result.status === "paused") {
    return failure(
      endpoint,
      result.runId,
      { class: "paused", message: PAUSED_MESSAGE },
      EXIT_CODES.paused
    );
  }
  const message = result.error ?? NO_ANSWER_MESSAGE;
  return failure(endpoint, result.runId, { class: "run", message }, EXIT_CODES.failure);
}

/**
 * Prints the one stdout line and returns the exit code. A failed outcome also
 * prints its message to stderr (a pause as a warning). The write is awaited:
 * `bin.ts` exits right after, and an unflushed pipe loses what is past 64 KiB.
 *
 * @param context - CommandContext (branded console, stdout writer).
 * @param outcome - The line and exit code.
 * @returns The exit code.
 * @example
 * ```ts
 * return await finish(context, outcome);
 * ```
 */
async function finish(context: CommandContext, outcome: Outcome): Promise<number> {
  const { output } = outcome;
  if (!output.ok && output.error.class === "paused") context.ui.warn(output.error.message);
  if (!output.ok && output.error.class !== "paused") context.ui.error(output.error.message);

  await context.writeOut(`${JSON.stringify(output)}\n`);
  return outcome.code;
}

/**
 * Runs the `call` command: one endpoint with a JSON input through the runner
 * (so cost, retries, lanes, the journal and the content cache apply), then one
 * JSON line on stdout. Exit codes: `0` done, `1` failed, flagged or run failed,
 * `3` usage (no run starts), `4` paused.
 *
 * @param context - CommandContext (branded console + required plugin APIs).
 * @param flags - Parsed command flags (`input`, `out`).
 * @param positionals - Positional args; `positionals[0]` is the endpoint.
 * @returns The exit code.
 * @example
 * ```ts
 * const code = await runCallCommand(context, { input: '{"prompt":"wall"}' }, ["fal-ai/sam-3/image"]);
 * ```
 */
export async function runCallCommand(
  context: CommandContext,
  flags: CommandFlags,
  positionals: string[]
): Promise<number> {
  routeLogsToStderr(context);

  const endpoint = positionals[0] ?? "";
  const usage = (message: string): Promise<number> =>
    finish(context, failure(endpoint, NO_RUN, { class: "usage", message }, EXIT_CODES.usage));

  if (endpoint === "") return usage("moku call requires an <endpoint> argument");

  const input = await readInput(context, flags.input);
  if (!input.ok) return usage(input.message);

  const build = await compileCall(context, endpoint, input.value);
  if (!build.ok) return usage(build.message);

  const finished = await context.runWithAbort(signal => runBuild(context, build.value, signal));
  return finish(context, await settle(context, flags, endpoint, finished));
}
