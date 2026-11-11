import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LogSink } from "@moku-labs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildfileSource, CompiledBuild } from "../../../../buildfile/types";
import type { ErrorClass, ItemRow } from "../../../../journal/types";
import type { RunEvent, RunOptions, RunResult, RunResultStatus } from "../../../../runner/types";
import { runCallCommand } from "../../../commands/call";
import type { CallOutput, CommandFlags } from "../../../types";
import { EXIT_CODES } from "../../../types";
import { createFakeCommandContext, createItemRow, ZERO_TOTALS } from "../fixtures";

/** What one fake run produces: the run result, the journal item, the stream records and the stored bytes. */
type Scenario = {
  status?: RunResultStatus;
  error?: string;
  item?: ItemRow | undefined;
  events?: RunEvent[];
  answer?: string;
  /** `run()` rejects with this error after it announced its run id (cap reached, journal locked). */
  rejectWith?: Error;
  /** The stream never ends, like a stream whose run was never closed. */
  endlessStream?: boolean;
};

/** An event stream that yields nothing and never ends. */
const ENDLESS_STREAM: AsyncIterable<RunEvent> = {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) })
};

// eslint-disable-next-line unicorn/no-null -- the usage output's runId is JSON null
const NO_RUN = null;

const ANSWER_TEXT = '{"masks": [1,  2],\n "score":0.5}';

/**
 * Yields the given stream records, then ends (the runner closes its stream when no run is left).
 *
 * @param events - The records to yield.
 * @yields {RunEvent} Each record in order.
 */
async function* streamOf(events: RunEvent[]): AsyncIterable<RunEvent> {
  for (const event of events) yield event;
}

/** A compiled build whose spec is the JSON the command handed to `compile` (JSON is valid YAML). */
function compileFake(source: BuildfileSource): Promise<CompiledBuild> {
  if (!("text" in source)) throw new Error("call compiles inline text only");
  return Promise.resolve({ file: "<inline>", spec: JSON.parse(source.text) });
}

/** Builds a fake context whose runner, journal and store play one {@link Scenario}. */
function createCallContext(scenario: Scenario = {}) {
  const runCalls: Array<{ options: RunOptions; signal: AbortSignal | undefined }> = [];
  const order: string[] = [];
  const hasItem = !("item" in scenario);
  const item = hasItem ? createItemRow() : scenario.item;
  const fake = createFakeCommandContext({
    buildfile: { compile: vi.fn(compileFake) },
    runner: {
      run: (options, runOptions): Promise<RunResult> => {
        order.push("run");
        runCalls.push({ options: options ?? {}, signal: runOptions?.signal });
        runOptions?.onStart?.("run-1");
        if (scenario.rejectWith) return Promise.reject(scenario.rejectWith);
        const result: RunResult = {
          runId: "run-1",
          status: scenario.status ?? "done",
          totals: ZERO_TOTALS,
          ...(scenario.error === undefined ? {} : { error: scenario.error })
        };
        return Promise.resolve(result);
      },
      // Like the real runner: a run filter keeps only that run's records.
      events: opts => {
        if (scenario.endlessStream) return ENDLESS_STREAM;
        const events = scenario.events ?? [
          { type: "item:dispatching", runId: "run-1", itemId: "item-1" }
        ];
        return streamOf(events.filter(event => !opts?.runId || event.runId === opts.runId));
      }
    },
    journal: { listItems: () => (item === undefined ? [] : [item]) },
    store: {
      read: () => Promise.resolve(new TextEncoder().encode(scenario.answer ?? ANSWER_TEXT))
    },
    log: {
      clearSinks: () => {
        order.push("clearSinks");
      }
    }
  });
  return { ...fake, runCalls, order };
}

/** Parses the single stdout line the command wrote. */
function outputOf(stdout: string[]): CallOutput {
  expect(stdout).toHaveLength(1);
  const [line] = stdout;
  expect(line?.endsWith("\n")).toBe(true);
  expect(line?.slice(0, -1)).not.toContain("\n");
  return JSON.parse(line ?? "");
}

/**
 * The items of the one build the command handed to the runner.
 *
 * @param calls - The recorded `runner.run` calls.
 * @returns The build's items.
 */
function ranItem(calls: Array<{ options: RunOptions }>): unknown {
  const builds = calls[0]?.options.builds;
  expect(builds).toHaveLength(1);
  return builds?.[0]?.spec.items;
}

/**
 * An `item:failed` stream record with a class and an optional message.
 *
 * @param errorClass - The journal error class.
 * @param message - The record's message, if any.
 * @returns The stream record.
 */
function failedEvent(errorClass: ErrorClass, message?: string): RunEvent {
  return {
    type: "item:failed",
    runId: "run-1",
    itemId: "item-1",
    label: "ep",
    errorClass,
    ...(message === undefined ? {} : { message })
  };
}

const dispatching: RunEvent = { type: "item:dispatching", runId: "run-1", itemId: "item-1" };

describe("runCallCommand — build handed to the runner", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-cli-call-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  const expectedItems = [{ task: "call", id: "ep", input: { endpoint: "ep", input: { a: 1 } } }];

  it("passes one build with one call item for an inline JSON body", async () => {
    const { context, runCalls } = createCallContext();

    await runCallCommand(context, { input: '{"a":1}' }, ["ep"]);

    expect(ranItem(runCalls)).toEqual(expectedItems);
  });

  it("compiles the item as version 1 inline yaml named call, with no provider", async () => {
    const { context } = createCallContext();

    await runCallCommand(context, { input: '{"a":1}' }, ["ep"]);

    const source = vi.mocked(context.buildfile.compile).mock.calls[0]?.[0];
    expect(source).toMatchObject({ lang: "yaml" });
    const spec = JSON.parse(source && "text" in source ? source.text : "{}");
    expect(spec).toEqual({ version: 1, name: "call", items: expectedItems });
  });

  it("gives the same item for --input @file as for the inline form", async () => {
    await writeFile(path.join(tempDir, "body.json"), '{"a":1}', "utf8");
    const { context, runCalls } = createCallContext();

    await runCallCommand(context, { input: "@body.json" }, ["ep"]);

    expect(ranItem(runCalls)).toEqual(expectedItems);
  });

  it("gives the same item for --input - as for the inline form, reading stdin once", async () => {
    const readIn = vi.fn(() => Promise.resolve('{"a":1}'));
    const { context, runCalls } = createCallContext();
    context.readIn = readIn;

    await runCallCommand(context, { input: "-" }, ["ep"]);

    expect(ranItem(runCalls)).toEqual(expectedItems);
    expect(readIn).toHaveBeenCalledTimes(1);
  });

  it("does not read stdin for an inline body", async () => {
    const readIn = vi.fn(() => Promise.resolve("{}"));
    const { context } = createCallContext();
    context.readIn = readIn;

    await runCallCommand(context, { input: '{"a":1}' }, ["ep"]);

    expect(readIn).not.toHaveBeenCalled();
  });

  it("hands the runner the SIGINT-wired signal", async () => {
    const controller = new AbortController();
    const { context, runCalls } = createCallContext();
    context.runWithAbort = action => action(controller.signal);

    await runCallCommand(context, { input: "{}" }, ["ep"]);

    expect(runCalls[0]?.signal).toBe(controller.signal);
  });
});

describe("runCallCommand — stdout holds one line", () => {
  it("writes one parseable line for a done item and nothing through the console", async () => {
    const { context, stdout, lines } = createCallContext();

    const code = await runCallCommand(context, { input: "{}" }, ["fal-ai/x"]);

    expect(code).toBe(EXIT_CODES.ok);
    expect(outputOf(stdout)).toEqual({
      ok: true,
      endpoint: "fal-ai/x",
      costUsd: 0.005,
      reused: false,
      runId: "run-1",
      result: { masks: [1, 2], score: 0.5 }
    });
    expect(lines).toEqual([]);
  });

  it("resolves only after writeOut resolved", async () => {
    let flushed = false;
    const { context } = createCallContext();
    context.writeOut = () =>
      new Promise(resolve => {
        setTimeout(() => {
          flushed = true;
          resolve();
        }, 30);
      });

    const code = await runCallCommand(context, { input: "{}" }, ["ep"]);

    expect(code).toBe(EXIT_CODES.ok);
    expect(flushed).toBe(true);
  });

  it("clears the log sinks before the run and sends warn and error entries to stderr only", async () => {
    let sink: LogSink | undefined;
    const { context, order, lines, errorLines } = createCallContext();
    context.log.addSink = added => {
      order.push("addSink");
      sink = added;
    };

    await runCallCommand(context, { input: "{}" }, ["ep"]);

    expect(order).toEqual(["clearSinks", "addSink", "run"]);
    const now = Date.now();
    sink?.write({ level: "warn", event: "fal:call:units-unknown", ts: now });
    sink?.write({ level: "error", event: "runner:item:failed", ts: now });
    sink?.write({ level: "info", event: "runner:item:done", ts: now });
    sink?.write({ level: "debug", event: "fal:call:submitted", ts: now });
    expect(errorLines.join("\n")).toContain("fal:call:units-unknown");
    expect(errorLines.join("\n")).toContain("runner:item:failed");
    expect(errorLines.join("\n")).not.toContain("runner:item:done");
    expect(errorLines.join("\n")).not.toContain("fal:call:submitted");
    expect(lines).toEqual([]);
  });
});

describe("runCallCommand — answer", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-cli-call-out-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("--out writes the stored bytes to the file and prints out, not result", async () => {
    const { context, stdout } = createCallContext();

    const code = await runCallCommand(context, { input: "{}", out: "mask/s03.json" }, ["ep"]);

    expect(code).toBe(EXIT_CODES.ok);
    const output = outputOf(stdout);
    const expectedPath = path.join(process.cwd(), "mask", "s03.json");
    expect(output).toEqual({
      ok: true,
      endpoint: "ep",
      costUsd: 0.005,
      reused: false,
      runId: "run-1",
      out: expectedPath
    });
    expect(output).not.toHaveProperty("result");
    expect(await readFile(expectedPath, "utf8")).toBe(ANSWER_TEXT);
  });

  it("a done item with no item:dispatching record is reused and costs 0", async () => {
    const { context, stdout } = createCallContext({
      events: [],
      item: createItemRow({ actualCostUsd: 0 })
    });

    await runCallCommand(context, { input: "{}" }, ["ep"]);

    expect(outputOf(stdout)).toMatchObject({ ok: true, reused: true, costUsd: 0 });
  });

  it("a done item whose journal cost is null prints costUsd 0", async () => {
    const { context, stdout } = createCallContext({
      events: [dispatching],
      // eslint-disable-next-line unicorn/no-null -- ItemRow.actualCostUsd is nullable
      item: createItemRow({ actualCostUsd: null })
    });

    await runCallCommand(context, { input: "{}" }, ["ep"]);

    expect(outputOf(stdout)).toMatchObject({ ok: true, reused: false, costUsd: 0 });
  });
});

describe("runCallCommand — failures", () => {
  it("an item:failed record in a run that ends done gives exit 1 and ok:false with its class and message", async () => {
    const { context, stdout, errorLines } = createCallContext({
      status: "done",
      item: createItemRow({ status: "failed", actualCostUsd: 0 }),
      events: [dispatching, failedEvent("http-4xx", "[ai] fal rejected the request (HTTP 422).")]
    });

    const code = await runCallCommand(context, { input: "{}" }, ["ep"]);

    expect(code).toBe(EXIT_CODES.failure);
    expect(outputOf(stdout)).toEqual({
      ok: false,
      endpoint: "ep",
      costUsd: 0,
      runId: "run-1",
      error: { class: "http-4xx", message: "[ai] fal rejected the request (HTTP 422)." }
    });
    expect(errorLines.join("\n")).toContain("fal rejected the request");
  });

  it("an item:failed record with no message uses the class as the message", async () => {
    const { context, stdout } = createCallContext({
      item: createItemRow({ status: "failed" }),
      events: [dispatching, failedEvent("timeout")]
    });

    await runCallCommand(context, { input: "{}" }, ["ep"]);

    expect(outputOf(stdout)).toMatchObject({ error: { class: "timeout", message: "timeout" } });
  });

  it("an item:flagged record gives exit 1, class content-policy and its message", async () => {
    const { context, stdout } = createCallContext({
      item: createItemRow({ status: "flagged" }),
      events: [
        dispatching,
        { type: "item:flagged", runId: "run-1", itemId: "item-1", message: "blocked by policy" }
      ]
    });

    const code = await runCallCommand(context, { input: "{}" }, ["ep"]);

    expect(code).toBe(EXIT_CODES.failure);
    expect(outputOf(stdout)).toMatchObject({
      ok: false,
      error: { class: "content-policy", message: "blocked by policy" }
    });
  });

  it("an item:flagged record with no message uses content-policy as the message", async () => {
    const { context, stdout } = createCallContext({
      item: createItemRow({ status: "flagged" }),
      events: [{ type: "item:flagged", runId: "run-1", itemId: "item-1" }]
    });

    await runCallCommand(context, { input: "{}" }, ["ep"]);

    expect(outputOf(stdout)).toMatchObject({
      error: { class: "content-policy", message: "content-policy" }
    });
  });

  it("a failed run with an error and no item gives exit 1, class run and that message", async () => {
    const message =
      '[ai] No price for fal endpoint "x/y".\n  Add "call:x/y" to fal.priceOverrides.';
    const { context, stdout, errorLines } = createCallContext({
      status: "failed",
      error: message,
      item: undefined,
      events: []
    });

    const code = await runCallCommand(context, { input: "{}" }, ["x/y"]);

    expect(code).toBe(EXIT_CODES.failure);
    expect(outputOf(stdout)).toEqual({
      ok: false,
      endpoint: "x/y",
      costUsd: 0,
      runId: "run-1",
      error: { class: "run", message }
    });
    expect(errorLines.join("\n")).toContain("call:x/y");
  });

  it("a run that ends with no item and no error still prints one ok:false line", async () => {
    const { context, stdout } = createCallContext({
      status: "failed",
      item: undefined,
      events: []
    });

    const code = await runCallCommand(context, { input: "{}" }, ["ep"]);

    expect(code).toBe(EXIT_CODES.failure);
    expect(outputOf(stdout)).toMatchObject({ ok: false, error: { class: "run" } });
  });

  it("a rejected run prints one line with class run and exits 1", async () => {
    const { context, stdout, errorLines } = createCallContext({
      rejectWith: new Error("database is locked"),
      endlessStream: true
    });

    const code = await runCallCommand(context, { input: "{}" }, ["ep"]);

    expect(code).toBe(EXIT_CODES.failure);
    expect(outputOf(stdout)).toEqual({
      ok: false,
      endpoint: "ep",
      costUsd: 0,
      runId: NO_RUN,
      error: { class: "run", message: "database is locked" }
    });
    expect(errorLines.join("\n")).toContain("database is locked");
  });

  it("an item:failed of another run is not taken as this call's failure", async () => {
    const { context, stdout } = createCallContext({
      events: [
        dispatching,
        {
          type: "item:failed",
          runId: "run-2",
          itemId: "item-9",
          label: "other",
          errorClass: "http-4xx",
          message: "other run failed"
        }
      ]
    });

    const code = await runCallCommand(context, { input: "{}" }, ["ep"]);

    expect(code).toBe(EXIT_CODES.ok);
    expect(outputOf(stdout)).toMatchObject({ ok: true, reused: false });
  });

  it("an aborted signal gives exit 4, class paused and the rerun hint", async () => {
    const controller = new AbortController();
    controller.abort();
    const { context, stdout, errorLines } = createCallContext({
      status: "paused",
      item: undefined,
      events: []
    });
    context.runWithAbort = action => action(controller.signal);

    const code = await runCallCommand(context, { input: "{}" }, ["ep"]);

    expect(code).toBe(EXIT_CODES.paused);
    expect(outputOf(stdout)).toEqual({
      ok: false,
      endpoint: "ep",
      costUsd: 0,
      runId: "run-1",
      error: {
        class: "paused",
        message:
          "[ai] The call was paused.\n  Run the same command again: a submitted job is adopted, not paid twice."
      }
    });
    expect(errorLines.join("\n")).toContain("The call was paused");
  });
});

describe("runCallCommand — usage errors", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-cli-call-usage-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  const cases: Array<{
    name: string;
    flags: CommandFlags;
    positionals: string[];
    message: string;
  }> = [
    {
      name: "no endpoint",
      flags: { input: "{}" },
      positionals: [],
      message: "moku call requires an <endpoint> argument"
    },
    {
      name: "no --input",
      flags: {},
      positionals: ["ep"],
      message: "moku call requires --input <json | @file | ->"
    },
    {
      name: "an unreadable @file",
      flags: { input: "@missing.json" },
      positionals: ["ep"],
      message: 'cannot read --input file "missing.json"'
    },
    {
      name: "invalid JSON",
      flags: { input: "{nope" },
      positionals: ["ep"],
      message: "--input is not valid JSON"
    },
    {
      name: "a JSON array",
      flags: { input: "[1,2]" },
      positionals: ["ep"],
      message: "--input must be a JSON object"
    },
    {
      name: "JSON null",
      flags: { input: "null" },
      positionals: ["ep"],
      message: "--input must be a JSON object"
    },
    {
      name: "a JSON string",
      flags: { input: '"text"' },
      positionals: ["ep"],
      message: "--input must be a JSON object"
    }
  ];

  it.each(cases)("$name: exit 3, class usage, one line, no run", async ({
    flags,
    positionals,
    message
  }) => {
    const { context, stdout, errorLines, runCalls } = createCallContext();

    const code = await runCallCommand(context, flags, positionals);

    expect(code).toBe(EXIT_CODES.usage);
    expect(runCalls).toEqual([]);
    expect(outputOf(stdout)).toEqual({
      ok: false,
      endpoint: positionals[0] ?? "",
      costUsd: 0,
      runId: NO_RUN,
      error: { class: "usage", message }
    });
    expect(errorLines.join("\n")).toContain(message);
  });

  it("a build the compiler rejects is a usage error and no run starts", async () => {
    const { context, stdout, runCalls } = createCallContext();
    context.buildfile.compile = () => Promise.reject(new Error("items.0.id: too long"));

    const code = await runCallCommand(context, { input: "{}" }, ["ep"]);

    expect(code).toBe(EXIT_CODES.usage);
    expect(runCalls).toEqual([]);
    expect(outputOf(stdout)).toMatchObject({
      ok: false,
      runId: NO_RUN,
      error: { class: "usage", message: "items.0.id: too long" }
    });
  });
});
