/**
 * @file runToolLoop — unit tests with a scripted `generate` and a Map-backed
 * journal that records step keys and replays stored values.
 */
/* eslint-disable unicorn/no-null -- ChatMessage.content, LoopEvent.text and finalText are `string | null` in the contract */
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import type { ChatMessage, PromptGenRequest, PromptGenResult, ToolCall } from "../../contract";
import { runToolLoop } from "../../loop/run";
import type { LoopEvent, RunToolLoopOptions, ToolOutput, ToolSpec } from "../../loop/types";

/** A journaled step value with its cost, as a real journal stores it. */
type Stored = { value: unknown; costUsd: number };

const USAGE = { promptTokens: 10, completionTokens: 2, cachedTokens: 0, cacheWriteTokens: 0 };
const NOTE = "The budget is nearly spent. Finish with what you have.";
const USER: ChatMessage = { role: "user", content: "Check shot 3." };

/** A journal double: runs work once per key, replays a structured clone afterwards. */
function createJournal(
  stored = new Map<string, Stored>(),
  signal: AbortSignal = new AbortController().signal
) {
  const keys: string[] = [];
  async function step<T>(
    key: string,
    work: (signal: AbortSignal) => Promise<{ value: T; costUsd: number }>
  ): Promise<T> {
    keys.push(key);
    const hit = stored.get(key);
    if (hit !== undefined) return hit.value as T;
    const done = await work(signal);
    stored.set(key, structuredClone(done));
    return done.value;
  }
  return { step, keys, stored };
}

/** A model answer. */
function answer(text: string, toolCalls: ToolCall[] = [], costUsd = 0): PromptGenResult {
  return {
    text,
    costUsd,
    toolCalls,
    finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    usage: { ...USAGE }
  };
}

/** A tool call. */
function call(id: string, name: string, input: unknown): ToolCall {
  return { id, name, input };
}

/** A scripted `generate`: returns the answers in order and records every request. */
function scriptModel(answers: PromptGenResult[]) {
  const requests: PromptGenRequest[] = [];
  const generate = vi.fn(async (request: PromptGenRequest, _signal: AbortSignal) => {
    requests.push(structuredClone(request));
    const next = answers[requests.length - 1];
    if (next === undefined) throw new Error("no scripted answer");
    return next;
  });
  return { generate, requests };
}

/** A text-only tool output. */
function textOut(text: string, costUsd = 0): ToolOutput {
  return { value: text, content: [{ type: "text", text }], costUsd };
}

/** The `read_frame` tool around a run function. */
function readFrame(
  run: (input: { shot: number }, signal: AbortSignal) => Promise<ToolOutput> = async ({ shot }) =>
    textOut(`Frame of shot ${shot}.`)
): ToolSpec<{ shot: number }> {
  return {
    name: "read_frame",
    description: "Return one frame of a shot.",
    schema: z.object({ shot: z.number() }),
    run
  };
}

/** The `render_shot` tool: costed, with start and wait halves. */
function renderShot(
  start: (input: { shot: number }) => Promise<{ started: unknown; rows?: string[] }>,
  wait: (started: unknown) => Promise<ToolOutput>,
  estimate = 0.5
): ToolSpec<{ shot: number }> {
  return {
    name: "render_shot",
    description: "Render one shot.",
    schema: z.object({ shot: z.number() }),
    estimateUsd: () => estimate,
    run: async () => {
      throw new Error("run is not called for a start/wait tool");
    },
    start,
    wait
  };
}

/** The `ask` tool: never run by the loop. */
const askTool: ToolSpec<{ question: string }> = {
  name: "ask",
  description: "Ask the person a question.",
  schema: z.object({ question: z.string() }),
  run: async () => {
    throw new Error("ask is never run");
  }
};

/** Loop options with defaults for everything a test does not set. */
function loopOptions(
  overrides: Partial<RunToolLoopOptions> & Pick<RunToolLoopOptions, "generate" | "step">
): RunToolLoopOptions {
  return {
    model: "anthropic/claude-opus-5.5",
    system: "You review frames.",
    messages: [USER],
    tools: [readFrame()],
    budget: { usd: 10, finishAt: 0.8 },
    maxSteps: 10,
    signal: new AbortController().signal,
    ...overrides
  };
}

/** The tool messages of a history, by call id. */
function toolContent(
  messages: ChatMessage[],
  toolCallId: string
): ChatMessage["content"] | undefined {
  return messages.find(message => message.role === "tool" && message.toolCallId === toolCallId)
    ?.content;
}

/** A user message as the default cache mode sends its mark target: one marked text part. */
function markedUser(text: string): ChatMessage {
  return { role: "user", content: [{ type: "text", text, cache: true }] };
}

/** The text of a message, whether it is sent as a string or as text parts. */
function textOf(message: ChatMessage): string | null {
  if (!Array.isArray(message.content)) return message.content;
  return message.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("");
}

/** A tool with no content. */
async function silent(): Promise<ToolOutput> {
  return { value: 0, content: [], costUsd: 0 };
}

/** A tool that fails on its own. */
async function broken(): Promise<ToolOutput> {
  throw new Error("frame store offline");
}

/** Three turns, each reading one frame image, then a final answer. */
function imageRun() {
  const model = scriptModel([
    answer("", [call("c1", "read_frame", { shot: 1 })]),
    answer("", [call("c2", "read_frame", { shot: 2 })]),
    answer("", [call("c3", "read_frame", { shot: 3 })]),
    answer("Done.")
  ]);
  const tool = readFrame(async ({ shot }) => ({
    value: shot,
    content: [
      { type: "text", text: `Frame ${shot}.` },
      { type: "image", path: `frames/f${shot}.png`, mimeType: "image/png", hash: `h${shot}` }
    ],
    costUsd: 0
  }));
  return { model, tool };
}

/** The image or its dropped text in the tool message of a request. */
function imagePart(messages: ChatMessage[] | undefined, toolCallId: string): unknown {
  const content = toolContent(messages ?? [], toolCallId);
  return Array.isArray(content) ? content[1] : content;
}

describe("runToolLoop — the turn loop", () => {
  it("runs the tool the model calls and stops with the model's final answer", async () => {
    const { generate } = scriptModel([
      answer("", [call("c1", "read_frame", { shot: 3 })], 0.25),
      answer("Shot 3 is cut at the chin.", [], 0.125)
    ]);
    const run = vi.fn(async ({ shot }: { shot: number }) => textOut(`Frame of shot ${shot}.`, 0.5));
    const journal = createJournal();

    const result = await runToolLoop(
      loopOptions({ generate, step: journal.step, tools: [readFrame(run)] })
    );

    expect(result).toEqual({
      stoppedBy: "done",
      spentUsd: 0.875,
      steps: 2,
      finalText: "Shot 3 is cut at the chin.",
      messages: [
        USER,
        { role: "assistant", content: null, toolCalls: [call("c1", "read_frame", { shot: 3 })] },
        { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "Frame of shot 3." }] },
        { role: "assistant", content: "Shot 3 is cut at the chin." }
      ]
    });
    expect(journal.keys).toEqual(["model:1", "tool:c1", "model:2"]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toEqual({ shot: 3 });
  });

  it("sends every model call as a cached messages request with the tools' input schemas", async () => {
    const { generate, requests } = scriptModel([answer("Fine.")]);
    const tool: ToolSpec<{ shot: number; take: number }> = {
      name: "read_frame",
      description: "Return one frame of a shot.",
      schema: z.object({ shot: z.number(), take: z.number().default(1) }),
      run: async () => textOut("frame")
    };

    await runToolLoop(
      loopOptions({ generate, step: createJournal().step, tools: [tool], reasoning: "low" })
    );

    expect(requests[0]).toEqual({
      prompt: "",
      system: "You review frames.",
      model: "anthropic/claude-opus-5.5",
      messages: [markedUser("Check shot 3.")],
      tools: [
        {
          name: "read_frame",
          description: "Return one frame of a shot.",
          inputSchema: {
            type: "object",
            properties: { shot: { type: "number" }, take: { default: 1, type: "number" } },
            required: ["shot"]
          }
        }
      ],
      cacheSystem: true,
      params: { reasoning: "low" }
    });
  });

  it("sends no params without reasoning and never changes the caller's messages", async () => {
    const { generate, requests } = scriptModel([
      answer("", [call("c1", "read_frame", { shot: 3 })]),
      answer("Done.")
    ]);
    const messages: ChatMessage[] = [USER];

    const result = await runToolLoop(
      loopOptions({ generate, step: createJournal().step, messages })
    );

    expect(requests[0]).not.toHaveProperty("params");
    expect(messages).toEqual([USER]);
    expect(result.messages).not.toBe(messages);
  });

  it("passes images of tool results to the next request", async () => {
    const image = {
      type: "image" as const,
      path: "frames/s3-012.png",
      mimeType: "image/png",
      hash: "9f2c"
    };
    const { generate, requests } = scriptModel([
      answer("", [call("c1", "read_frame", { shot: 3 })]),
      answer("Done.")
    ]);
    const run = async (): Promise<ToolOutput> => ({
      value: 12,
      content: [{ type: "text", text: "Frame 12." }, image],
      costUsd: 0
    });

    await runToolLoop(
      loopOptions({ generate, step: createJournal().step, tools: [readFrame(run)] })
    );

    expect(requests[1]?.messages?.[2]).toEqual({
      role: "tool",
      toolCallId: "c1",
      content: [{ type: "text", text: "Frame 12." }, image]
    });
  });

  it("answers a tool with no content with (no output)", async () => {
    const { generate } = scriptModel([
      answer("", [call("c1", "read_frame", { shot: 3 })]),
      answer("Done.")
    ]);
    const result = await runToolLoop(
      loopOptions({ generate, step: createJournal().step, tools: [readFrame(silent)] })
    );

    expect(toolContent(result.messages, "c1")).toBe("(no output)");
  });

  it("sets finalText to null when the last model text is empty", async () => {
    const { generate } = scriptModel([answer("")]);

    const result = await runToolLoop(loopOptions({ generate, step: createJournal().step }));

    expect(result).toMatchObject({ stoppedBy: "done", finalText: null, steps: 1 });
    expect(result.messages.at(-1)).toEqual({ role: "assistant", content: null });
  });

  it("propagates a generate rejection when the run is not aborted", async () => {
    const generate = vi.fn(async () => {
      throw new Error("[ai] fal prompt-gen failed.");
    });

    await expect(
      runToolLoop(loopOptions({ generate, step: createJournal().step }))
    ).rejects.toThrow("[ai] fal prompt-gen failed.");
  });
});

describe("runToolLoop — journal replay", () => {
  it("replays a start/wait tool after its start step: wait runs, start never twice", async () => {
    const stored = new Map<string, Stored>();
    const start = vi.fn(async ({ shot }: { shot: number }) => ({
      started: `job-${shot}`,
      rows: [`row-${shot}`]
    }));
    const crash = vi.fn(async (): Promise<ToolOutput> => {
      throw new Error("process died");
    });
    const firstModel = scriptModel([answer("", [call("c1", "render_shot", { shot: 3 })], 0.25)]);

    await expect(
      runToolLoop(
        loopOptions({
          generate: firstModel.generate,
          step: createJournal(stored).step,
          tools: [renderShot(start, crash)]
        })
      )
    ).rejects.toThrow("process died");

    const wait = vi.fn(async (started: unknown) => textOut(`Rendered ${String(started)}.`, 0.5));
    const secondModel = scriptModel([answer("Rendered.", [], 0.125)]);
    const journal = createJournal(stored);
    const events: LoopEvent[] = [];

    const result = await runToolLoop(
      loopOptions({
        generate: secondModel.generate,
        step: journal.step,
        tools: [renderShot(start, wait)],
        onStep: event => events.push(event)
      })
    );

    expect(start).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait.mock.calls[0]?.[0]).toBe("job-3");
    expect(journal.keys).toEqual(["model:1", "tool:c1:start", "tool:c1:wait", "model:2"]);
    expect(secondModel.generate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ stoppedBy: "done", spentUsd: 0.875, steps: 2 });
    expect(events.filter(event => event.kind === "tool")).toEqual([
      {
        kind: "tool",
        step: 1,
        name: "render_shot",
        callId: "c1",
        costUsd: 0.5,
        summary: "Rendered job-3.",
        rows: ["row-3"]
      }
    ]);
  });

  it("replays a full journal without calling the model or any tool, with the same result", async () => {
    const stored = new Map<string, Stored>();
    const { generate } = scriptModel([
      answer("Looking.", [call("c1", "read_frame", { shot: 3 })], 0.25),
      answer("", [call("c2", "render_shot", { shot: 3 })], 0.25),
      answer("Done.", [], 0.125)
    ]);
    const tools = [
      readFrame(async () => textOut("Frame.", 0.125)),
      renderShot(
        async () => ({ started: "job-3" }),
        async () => ({ ...textOut("Rendered.", 0.25), rows: ["row-3"] })
      )
    ];
    const firstEvents: LoopEvent[] = [];
    const options = {
      tools,
      budget: { usd: 2, finishAt: 0.25 },
      finishNote: NOTE
    };

    const first = await runToolLoop(
      loopOptions({
        ...options,
        generate,
        step: createJournal(stored).step,
        onStep: event => firstEvents.push(event)
      })
    );

    const deadModel = vi.fn(async (): Promise<PromptGenResult> => {
      throw new Error("the model is not called on a replay");
    });
    const deadRun = vi.fn(async (): Promise<ToolOutput> => {
      throw new Error("no tool runs on a replay");
    });
    const deadStart = vi.fn(async () => ({ started: "never" }));
    const replayEvents: LoopEvent[] = [];

    const replay = await runToolLoop(
      loopOptions({
        ...options,
        tools: [readFrame(deadRun), renderShot(deadStart, deadRun)],
        generate: deadModel,
        step: createJournal(stored).step,
        onStep: event => replayEvents.push(event)
      })
    );

    expect(replay).toEqual(first);
    expect(replayEvents).toEqual(firstEvents);
    expect(deadModel).not.toHaveBeenCalled();
    expect(deadRun).not.toHaveBeenCalled();
    expect(deadStart).not.toHaveBeenCalled();
    expect(replay.messages.filter(message => message.content === NOTE)).toHaveLength(1);
  });
});

describe("runToolLoop — replay against a grown outside spend", () => {
  it("replays a paid start step after a crash: wait runs, the budget is not checked again", async () => {
    const stored = new Map<string, Stored>();
    let billedUsd = 0;
    const budget = { usd: 2, finishAt: 1, spent: async () => billedUsd };
    const start = vi.fn(async () => {
      billedUsd = 0.4;
      return { started: "job-3", rows: ["row-3"] };
    });
    const crash = vi.fn(async (): Promise<ToolOutput> => {
      throw new Error("process died");
    });
    const firstModel = scriptModel([answer("", [call("c1", "render_shot", { shot: 3 })], 1.25)]);

    await expect(
      runToolLoop(
        loopOptions({
          generate: firstModel.generate,
          step: createJournal(stored).step,
          tools: [renderShot(start, crash, 0.4)],
          budget
        })
      )
    ).rejects.toThrow("process died");

    const wait = vi.fn(async () => textOut("Rendered."));
    const secondModel = scriptModel([answer("Rendered.")]);
    const journal = createJournal(stored);
    const events: LoopEvent[] = [];

    const result = await runToolLoop(
      loopOptions({
        generate: secondModel.generate,
        step: journal.step,
        tools: [renderShot(start, wait, 0.4)],
        budget,
        onStep: event => events.push(event)
      })
    );

    expect(result.stoppedBy).toBe("done");
    expect(start).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(journal.keys).toEqual(["model:1", "tool:c1:start", "tool:c1:wait", "model:2"]);
    expect(toolContent(result.messages, "c1")).toEqual([{ type: "text", text: "Rendered." }]);
    expect(events.some(event => event.kind === "budget")).toBe(false);
  });

  it("replays journaled model steps when the outside spend has passed the limit since", async () => {
    const stored = new Map<string, Stored>();
    const { generate } = scriptModel([
      answer("", [call("c1", "read_frame", { shot: 3 })], 0.5),
      answer("Done.", [], 0.25)
    ]);
    const firstEvents: LoopEvent[] = [];
    const first = await runToolLoop(
      loopOptions({
        generate,
        step: createJournal(stored).step,
        budget: { usd: 1, finishAt: 1 },
        onStep: event => firstEvents.push(event)
      })
    );
    const deadModel = vi.fn(async (): Promise<PromptGenResult> => {
      throw new Error("the model is not called on a replay");
    });
    const replayEvents: LoopEvent[] = [];

    const replay = await runToolLoop(
      loopOptions({
        generate: deadModel,
        step: createJournal(stored).step,
        budget: { usd: 1, finishAt: 1, spent: async () => 1.5 },
        onStep: event => replayEvents.push(event)
      })
    );

    expect(replay).toEqual({ ...first, spentUsd: 2.25 });
    expect(replayEvents).toEqual(firstEvents);
    expect(deadModel).not.toHaveBeenCalled();
  });

  it("puts the finish note at the same place on a replay, whatever the outside spend is now", async () => {
    const stored = new Map<string, Stored>();
    const { generate, requests } = scriptModel([
      answer("", [call("c1", "read_frame", { shot: 3 })], 0.25),
      answer("", [call("c2", "read_frame", { shot: 4 })], 0.25),
      answer("Done.", [], 0.25)
    ]);
    const firstEvents: LoopEvent[] = [];
    const first = await runToolLoop(
      loopOptions({
        generate,
        step: createJournal(stored).step,
        budget: { usd: 1, finishAt: 0.5 },
        finishNote: NOTE,
        onStep: event => firstEvents.push(event)
      })
    );
    const deadModel = vi.fn(async (): Promise<PromptGenResult> => {
      throw new Error("the model is not called on a replay");
    });
    const replayEvents: LoopEvent[] = [];

    const replay = await runToolLoop(
      loopOptions({
        generate: deadModel,
        step: createJournal(stored).step,
        budget: { usd: 1, finishAt: 0.5, spent: async () => 0.375 },
        finishNote: NOTE,
        onStep: event => replayEvents.push(event)
      })
    );

    expect(requests[2]?.messages?.at(-1)).toEqual(markedUser(NOTE));
    expect(first.messages.at(-2)).toEqual({ role: "user", content: NOTE });
    expect(replay.messages).toEqual(first.messages);
    expect(replayEvents).toEqual(firstEvents);
    expect(firstEvents.filter(event => event.kind === "budget")).toEqual([
      { kind: "budget", spentUsd: 0.5, limitUsd: 1, mode: "finish" }
    ]);
  });
});

describe("runToolLoop — budget", () => {
  it("stops before a tool whose estimate would pass the limit and answers the open calls", async () => {
    const { generate } = scriptModel([
      answer(
        "",
        [
          call("c1", "read_frame", { shot: 3 }),
          call("c2", "render_shot", { shot: 3 }),
          call("c3", "read_frame", { shot: 4 })
        ],
        0.75
      )
    ]);
    const start = vi.fn(async () => ({ started: "job" }));
    const wait = vi.fn(async () => textOut("Rendered."));
    const events: LoopEvent[] = [];

    const result = await runToolLoop(
      loopOptions({
        generate,
        step: createJournal().step,
        tools: [readFrame(), renderShot(start, wait)],
        budget: { usd: 1, finishAt: 1 },
        onStep: event => events.push(event)
      })
    );

    expect(result).toMatchObject({ stoppedBy: "budget", spentUsd: 0.75, steps: 1 });
    expect(start).not.toHaveBeenCalled();
    expect(toolContent(result.messages, "c1")).toEqual([
      { type: "text", text: "Frame of shot 3." }
    ]);
    expect(toolContent(result.messages, "c2")).toBe("Not run: budget.");
    expect(toolContent(result.messages, "c3")).toBe("Not run: budget.");
    expect(events.at(-1)).toEqual({ kind: "budget", spentUsd: 0.75, limitUsd: 1, mode: "stop" });
  });

  it("runs a costed tool whose estimate fits the limit", async () => {
    const { generate } = scriptModel([
      answer("", [call("c1", "render_shot", { shot: 3 })], 0.25),
      answer("Done.")
    ]);
    const wait = vi.fn(async () => textOut("Rendered.", 0.5));

    const result = await runToolLoop(
      loopOptions({
        generate,
        step: createJournal().step,
        tools: [renderShot(async () => ({ started: "job" }), wait)],
        budget: { usd: 1, finishAt: 1 }
      })
    );

    expect(result).toMatchObject({ stoppedBy: "done", spentUsd: 0.75 });
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("stops before a model call once the step costs reach the limit", async () => {
    const { generate } = scriptModel([
      answer("", [call("c1", "read_frame", { shot: 3 })], 0.5),
      answer("never")
    ]);
    const events: LoopEvent[] = [];

    const result = await runToolLoop(
      loopOptions({
        generate,
        step: createJournal().step,
        tools: [readFrame(async () => textOut("Frame.", 0.5))],
        budget: { usd: 1, finishAt: 1 },
        onStep: event => events.push(event)
      })
    );

    expect(result).toMatchObject({ stoppedBy: "budget", spentUsd: 1, steps: 1 });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(toolContent(result.messages, "c1")).toEqual([{ type: "text", text: "Frame." }]);
    expect(events.filter(event => event.kind === "budget")).toEqual([
      { kind: "budget", spentUsd: 1, limitUsd: 1, mode: "stop" }
    ]);
  });

  it("counts the spend before the run and the external spend", async () => {
    const { generate } = scriptModel([answer("never")]);
    const spent = vi.fn(async () => 0.75);
    const journal = createJournal();

    const result = await runToolLoop(
      loopOptions({
        generate,
        step: journal.step,
        budget: { usd: 1, spentUsd: 0.25, finishAt: 1, spent }
      })
    );

    expect(result).toEqual({
      stoppedBy: "budget",
      spentUsd: 1,
      steps: 0,
      finalText: null,
      messages: [USER]
    });
    expect(generate).not.toHaveBeenCalled();
    expect(spent).toHaveBeenCalled();
    expect(journal.keys).toEqual(["model:1"]);
    expect(journal.stored.size).toBe(0);
  });

  it("adds the external spend to the breaker estimate", async () => {
    const { generate } = scriptModel([answer("", [call("c1", "render_shot", { shot: 3 })])]);
    const start = vi.fn(async () => ({ started: "job" }));

    const result = await runToolLoop(
      loopOptions({
        generate,
        step: createJournal().step,
        tools: [renderShot(start, async () => textOut("Rendered."))],
        budget: { usd: 1, finishAt: 1, spent: async () => 0.625 }
      })
    );

    expect(result.stoppedBy).toBe("budget");
    expect(start).not.toHaveBeenCalled();
  });
});

describe("runToolLoop — finish mode", () => {
  it("adds the finish note once, before the next model call, and emits one finish event", async () => {
    const { generate, requests } = scriptModel([
      answer("", [call("c1", "read_frame", { shot: 3 })], 0.25),
      answer("", [call("c2", "read_frame", { shot: 4 })], 0.125),
      answer("Done.", [], 0.125)
    ]);
    const events: LoopEvent[] = [];

    const result = await runToolLoop(
      loopOptions({
        generate,
        step: createJournal().step,
        tools: [readFrame(async () => textOut("Frame.", 0.25))],
        budget: { usd: 1, finishAt: 0.5 },
        finishNote: NOTE,
        onStep: event => events.push(event)
      })
    );

    expect(requests[1]?.messages?.slice(-2)).toEqual([
      { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "Frame." }] },
      markedUser(NOTE)
    ]);
    expect(requests[2]?.messages?.filter(message => textOf(message) === NOTE)).toHaveLength(1);
    expect(result.messages.filter(message => message.content === NOTE)).toHaveLength(1);
    expect(events.map(event => event.kind)).toEqual([
      "model",
      "tool",
      "budget",
      "model",
      "tool",
      "model"
    ]);
    expect(events[2]).toEqual({ kind: "budget", spentUsd: 0.5, limitUsd: 1, mode: "finish" });
  });

  it("does not add the note again when the history already has it", async () => {
    const { generate, requests } = scriptModel([
      answer("", [call("c1", "read_frame", { shot: 3 })], 0.75),
      answer("Done.")
    ]);
    const events: LoopEvent[] = [];

    const result = await runToolLoop(
      loopOptions({
        generate,
        step: createJournal().step,
        messages: [USER, { role: "user", content: NOTE }],
        budget: { usd: 1, finishAt: 0.5 },
        finishNote: NOTE,
        onStep: event => events.push(event)
      })
    );

    expect(requests[1]?.messages?.filter(message => textOf(message) === NOTE)).toHaveLength(1);
    expect(result.messages.filter(message => message.content === NOTE)).toHaveLength(1);
    expect(events.filter(event => event.kind === "budget")).toHaveLength(1);
  });

  it("adds the note before the first call when the run starts past the finish point", async () => {
    const { generate, requests } = scriptModel([answer("Done.")]);

    await runToolLoop(
      loopOptions({
        generate,
        step: createJournal().step,
        budget: { usd: 1, spentUsd: 0.75, finishAt: 0.5 },
        finishNote: NOTE
      })
    );

    expect(requests[0]?.messages).toEqual([USER, markedUser(NOTE)]);
  });

  it("emits the finish event without a note when no finishNote is set", async () => {
    const { generate, requests } = scriptModel([
      answer("", [call("c1", "read_frame", { shot: 3 })], 0.75),
      answer("Done.")
    ]);
    const events: LoopEvent[] = [];

    await runToolLoop(
      loopOptions({
        generate,
        step: createJournal().step,
        budget: { usd: 1, finishAt: 0.5 },
        onStep: event => events.push(event)
      })
    );

    expect(requests[1]?.messages?.at(-1)?.role).toBe("tool");
    expect(events.filter(event => event.kind === "budget")).toEqual([
      { kind: "budget", spentUsd: 0.75, limitUsd: 1, mode: "finish" }
    ]);
  });
});

describe("runToolLoop — tool answers", () => {
  it("answers a bad input with the zod error and lets the model retry", async () => {
    const { generate } = scriptModel([
      answer("", [call("c1", "read_frame", { shot: "three" })]),
      answer("", [call("c2", "read_frame", { shot: 3 })]),
      answer("Done.")
    ]);
    const run = vi.fn(async (_input: { shot: number }) => textOut("Frame."));
    const journal = createJournal();

    const result = await runToolLoop(
      loopOptions({ generate, step: journal.step, tools: [readFrame(run)] })
    );

    expect(toolContent(result.messages, "c1")).toEqual([
      {
        type: "text",
        text: "Invalid input for read_frame: ✖ Invalid input: expected number, received string\n  → at shot"
      }
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toEqual({ shot: 3 });
    expect(journal.keys).toEqual(["model:1", "tool:c1", "model:2", "tool:c2", "model:3"]);
    expect(result.stoppedBy).toBe("done");
  });

  it("answers an unknown tool by name, in one step", async () => {
    const { generate } = scriptModel([
      answer("", [call("c1", "render_shot", { shot: 3 })]),
      answer("Done.")
    ]);
    const journal = createJournal();
    const events: LoopEvent[] = [];

    const result = await runToolLoop(
      loopOptions({ generate, step: journal.step, onStep: event => events.push(event) })
    );

    expect(toolContent(result.messages, "c1")).toEqual([
      { type: "text", text: 'Unknown tool "render_shot".' }
    ]);
    expect(journal.keys).toEqual(["model:1", "tool:c1", "model:2"]);
    expect(events[1]).toEqual({
      kind: "tool",
      step: 1,
      name: "render_shot",
      callId: "c1",
      costUsd: 0,
      summary: 'Unknown tool "render_shot".',
      rows: []
    });
  });

  it("propagates a tool error when the run is not aborted", async () => {
    const { generate } = scriptModel([answer("", [call("c1", "read_frame", { shot: 3 })])]);
    await expect(
      runToolLoop(loopOptions({ generate, step: createJournal().step, tools: [readFrame(broken)] }))
    ).rejects.toThrow("frame store offline");
  });
});

describe("runToolLoop — keepImages", () => {
  it("drops tool images older than the kept turns in the request only", async () => {
    const { model, tool } = imageRun();

    const result = await runToolLoop(
      loopOptions({
        generate: model.generate,
        step: createJournal().step,
        tools: [tool],
        keepImages: 1
      })
    );

    const lastRequest = model.requests[3]?.messages;
    expect(imagePart(lastRequest, "c1")).toEqual({
      type: "text",
      text: "[image dropped: f1.png]",
      cache: true
    });
    expect(imagePart(lastRequest, "c2")).toEqual({
      type: "text",
      text: "[image dropped: f2.png]",
      cache: true
    });
    expect(imagePart(lastRequest, "c3")).toMatchObject({ type: "image", path: "frames/f3.png" });
    expect(imagePart(result.messages, "c1")).toMatchObject({
      type: "image",
      path: "frames/f1.png"
    });
  });

  it("keeps the images of the last two assistant turns by default", async () => {
    const { model, tool } = imageRun();

    await runToolLoop(
      loopOptions({ generate: model.generate, step: createJournal().step, tools: [tool] })
    );

    const lastRequest = model.requests[3]?.messages;
    expect(imagePart(lastRequest, "c1")).toEqual({
      type: "text",
      text: "[image dropped: f1.png]",
      cache: true
    });
    expect(imagePart(lastRequest, "c2")).toMatchObject({ type: "image" });
    expect(imagePart(lastRequest, "c3")).toMatchObject({ type: "image" });
    expect(imagePart(model.requests[2]?.messages, "c1")).toMatchObject({ type: "image" });
  });
});

describe("runToolLoop — ask", () => {
  it("runs the other calls of the turn, then stops with the ask input and leaves ask open", async () => {
    const { generate } = scriptModel([
      answer("", [
        call("c1", "ask", { question: "Which take?" }),
        call("c2", "read_frame", { shot: 3 })
      ])
    ]);
    const run = vi.fn(async () => textOut("Frame."));
    const journal = createJournal();

    const result = await runToolLoop(
      loopOptions({ generate, step: journal.step, tools: [askTool, readFrame(run)] })
    );

    expect(result).toMatchObject({
      stoppedBy: "asked",
      asked: { input: { question: "Which take?" } },
      steps: 1
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(toolContent(result.messages, "c1")).toBeUndefined();
    expect(result.messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "c2",
      content: [{ type: "text", text: "Frame." }]
    });
    expect(journal.keys).toEqual(["model:1", "tool:c2"]);
  });

  it("answers an ask with a bad input like any tool and goes on", async () => {
    const { generate } = scriptModel([
      answer("", [call("c1", "ask", { question: 7 })]),
      answer("Done.")
    ]);

    const result = await runToolLoop(
      loopOptions({ generate, step: createJournal().step, tools: [askTool] })
    );

    expect(result.stoppedBy).toBe("done");
    expect(result).not.toHaveProperty("asked");
    expect(toolContent(result.messages, "c1")).toEqual([
      {
        type: "text",
        text: "Invalid input for ask: ✖ Invalid input: expected string, received number\n  → at question"
      }
    ]);
  });

  it("treats ask as an unknown tool when the caller defined none", async () => {
    const { generate } = scriptModel([
      answer("", [call("c1", "ask", { question: "Which take?" })]),
      answer("Done.")
    ]);

    const result = await runToolLoop(loopOptions({ generate, step: createJournal().step }));

    expect(result.stoppedBy).toBe("done");
    expect(toolContent(result.messages, "c1")).toEqual([
      { type: "text", text: 'Unknown tool "ask".' }
    ]);
  });

  it("holds only the first ask of a turn and answers a second one", async () => {
    const { generate } = scriptModel([
      answer("", [
        call("c1", "ask", { question: "Which take?" }),
        call("c2", "ask", { question: "Which shot?" }),
        call("c3", "read_frame", { shot: 3 })
      ])
    ]);
    const journal = createJournal();

    const result = await runToolLoop(
      loopOptions({ generate, step: journal.step, tools: [askTool, readFrame()] })
    );

    expect(result).toMatchObject({
      stoppedBy: "asked",
      asked: { input: { question: "Which take?" } }
    });
    expect(toolContent(result.messages, "c1")).toBeUndefined();
    expect(toolContent(result.messages, "c2")).toEqual([
      { type: "text", text: "Ask one question at a time." }
    ]);
    expect(toolContent(result.messages, "c3")).toEqual([
      { type: "text", text: "Frame of shot 3." }
    ]);
    expect(journal.keys).toEqual(["model:1", "tool:c2", "tool:c3"]);
  });

  it("lets a budget stop later in the turn win over ask", async () => {
    const { generate } = scriptModel([
      answer(
        "",
        [call("c1", "ask", { question: "Which take?" }), call("c2", "render_shot", { shot: 3 })],
        0.75
      )
    ]);

    const result = await runToolLoop(
      loopOptions({
        generate,
        step: createJournal().step,
        tools: [
          askTool,
          renderShot(
            async () => ({ started: "job" }),
            async () => textOut("x")
          )
        ],
        budget: { usd: 1, finishAt: 1 }
      })
    );

    expect(result.stoppedBy).toBe("budget");
    expect(toolContent(result.messages, "c1")).toBe("Not run: budget.");
    expect(toolContent(result.messages, "c2")).toBe("Not run: budget.");
  });
});

describe("runToolLoop — step limit", () => {
  it("stops before a model call once maxSteps model calls ran", async () => {
    const { generate } = scriptModel([
      answer("", [call("c1", "read_frame", { shot: 1 })]),
      answer("", [call("c2", "read_frame", { shot: 2 })]),
      answer("never")
    ]);

    const result = await runToolLoop(
      loopOptions({ generate, step: createJournal().step, maxSteps: 2 })
    );

    expect(result).toMatchObject({ stoppedBy: "steps", steps: 2 });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(toolContent(result.messages, "c2")).toEqual([
      { type: "text", text: "Frame of shot 2." }
    ]);
  });

  it("checks the step limit before the budget", async () => {
    const { generate } = scriptModel([answer("", [call("c1", "read_frame", { shot: 1 })], 1)]);
    const events: LoopEvent[] = [];

    const result = await runToolLoop(
      loopOptions({
        generate,
        step: createJournal().step,
        maxSteps: 1,
        budget: { usd: 1, finishAt: 1 },
        onStep: event => events.push(event)
      })
    );

    expect(result.stoppedBy).toBe("steps");
    expect(events.some(event => event.kind === "budget" && event.mode === "stop")).toBe(false);
  });
});

describe("runToolLoop — cancel", () => {
  it("returns cancel after the running tool settles and answers the calls not run", async () => {
    const controller = new AbortController();
    const { generate } = scriptModel([
      answer("", [call("c1", "read_frame", { shot: 3 }), call("c2", "read_frame", { shot: 4 })]),
      answer("never")
    ]);
    const run = vi.fn(async () => {
      controller.abort();
      return textOut("Frame.");
    });

    const result = await runToolLoop(
      loopOptions({
        generate,
        step: createJournal(new Map(), controller.signal).step,
        tools: [readFrame(run)],
        signal: controller.signal
      })
    );

    expect(result).toMatchObject({ stoppedBy: "cancel", steps: 1 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(toolContent(result.messages, "c1")).toEqual([{ type: "text", text: "Frame." }]);
    expect(toolContent(result.messages, "c2")).toBe("Not run: cancel.");
  });

  it("returns cancel when a tool throws because the run was aborted", async () => {
    const controller = new AbortController();
    const { generate } = scriptModel([answer("", [call("c1", "read_frame", { shot: 3 })])]);
    const run = async (): Promise<ToolOutput> => {
      controller.abort();
      throw new Error("aborted");
    };

    const result = await runToolLoop(
      loopOptions({
        generate,
        step: createJournal().step,
        tools: [readFrame(run)],
        signal: controller.signal
      })
    );

    expect(result.stoppedBy).toBe("cancel");
    expect(toolContent(result.messages, "c1")).toBe("Not run: cancel.");
  });

  it("returns cancel when the model call rejects because the run was aborted", async () => {
    const controller = new AbortController();
    const generate = vi.fn(async (): Promise<PromptGenResult> => {
      controller.abort();
      throw new Error("aborted");
    });

    const result = await runToolLoop(
      loopOptions({ generate, step: createJournal().step, signal: controller.signal })
    );

    expect(result).toEqual({
      stoppedBy: "cancel",
      spentUsd: 0,
      steps: 0,
      finalText: null,
      messages: [USER]
    });
  });

  it("returns cancel after a model step that settles once the run was aborted", async () => {
    const controller = new AbortController();
    const generate = vi.fn(async (): Promise<PromptGenResult> => {
      controller.abort();
      return answer("", [call("c1", "read_frame", { shot: 3 })], 0.25);
    });

    const result = await runToolLoop(
      loopOptions({ generate, step: createJournal().step, signal: controller.signal })
    );

    expect(result).toMatchObject({ stoppedBy: "cancel", steps: 1, spentUsd: 0.25 });
    expect(toolContent(result.messages, "c1")).toBe("Not run: cancel.");
  });

  it("returns cancel before any model call when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { generate } = scriptModel([answer("never")]);

    const result = await runToolLoop(
      loopOptions({ generate, step: createJournal().step, signal: controller.signal })
    );

    expect(result.stoppedBy).toBe("cancel");
    expect(generate).not.toHaveBeenCalled();
  });

  it("returns cancel between the start and wait halves", async () => {
    const controller = new AbortController();
    const { generate } = scriptModel([answer("", [call("c1", "render_shot", { shot: 3 })])]);
    const start = vi.fn(async () => {
      controller.abort();
      return { started: "job-3", rows: ["row-3"] };
    });
    const wait = vi.fn(async () => textOut("Rendered."));
    const journal = createJournal();

    const result = await runToolLoop(
      loopOptions({
        generate,
        step: journal.step,
        tools: [renderShot(start, wait)],
        signal: controller.signal
      })
    );

    expect(result.stoppedBy).toBe("cancel");
    expect(wait).not.toHaveBeenCalled();
    expect(journal.keys).toEqual(["model:1", "tool:c1:start"]);
    expect(toolContent(result.messages, "c1")).toBe("Not run: cancel.");
  });
});

describe("runToolLoop — events", () => {
  it("reports model and tool steps with turn numbers, summaries and rows", async () => {
    const { generate } = scriptModel([
      answer("Looking.", [call("c1", "read_frame", { shot: 1 })], 0.25),
      answer("", [call("c2", "read_frame", { shot: 2 })], 0.125),
      answer("Fine.", [], 0.125)
    ]);
    const long = "x".repeat(300);
    const run = async ({ shot }: { shot: number }): Promise<ToolOutput> =>
      shot === 1
        ? { value: 1, content: [{ type: "text", text: long }], costUsd: 0.5, rows: ["row-1"] }
        : {
            value: 2,
            content: [{ type: "image", path: "f.png", mimeType: "image/png", hash: "h" }],
            costUsd: 0
          };
    const events: LoopEvent[] = [];

    await runToolLoop(
      loopOptions({
        generate,
        step: createJournal().step,
        tools: [readFrame(run)],
        onStep: event => events.push(event)
      })
    );

    expect(events).toEqual([
      {
        kind: "model",
        step: 1,
        text: "Looking.",
        toolCalls: [call("c1", "read_frame", { shot: 1 })],
        costUsd: 0.25,
        usage: USAGE
      },
      {
        kind: "tool",
        step: 1,
        name: "read_frame",
        callId: "c1",
        costUsd: 0.5,
        summary: "x".repeat(200),
        rows: ["row-1"]
      },
      {
        kind: "model",
        step: 2,
        text: null,
        toolCalls: [call("c2", "read_frame", { shot: 2 })],
        costUsd: 0.125,
        usage: USAGE
      },
      {
        kind: "tool",
        step: 2,
        name: "read_frame",
        callId: "c2",
        costUsd: 0,
        summary: "",
        rows: []
      },
      { kind: "model", step: 3, text: "Fine.", toolCalls: [], costUsd: 0.125, usage: USAGE }
    ]);
  });

  it("accepts typed tools in the tools list", () => {
    const tools: RunToolLoopOptions["tools"] = [readFrame(), askTool];

    expect(tools.map(tool => tool.name)).toEqual(["read_frame", "ask"]);
  });

  it("types a tool's run input from its schema", () => {
    const shot = z.object({ shot: z.number() });
    const tool: ToolSpec<z.infer<typeof shot>, string> = {
      name: "read_frame",
      description: "Reads one frame.",
      schema: shot,
      run: async input => ({ value: `frame ${input.shot}`, content: [], costUsd: 0 })
    };

    expectTypeOf(tool.run).parameter(0).toEqualTypeOf<{ shot: number }>();
    // @ts-expect-error a schema of another input type does not fit
    const wrong: ToolSpec<{ shot: string }> = { ...tool, schema: shot };
    expect(wrong.name).toBe("read_frame");
  });
});
