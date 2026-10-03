/**
 * @file runToolLoop — unit tests of the prompt cache in the loop: the marks of
 * every request, the limit of 4 breakpoints, images, the three modes, a
 * resumed run, the result history and the cached usage fields.
 */
/* eslint-disable unicorn/no-null -- ChatMessage.content is `string | null` in the contract */
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import type {
  ChatMessage,
  ContentPart,
  PromptGenRequest,
  PromptGenResult,
  PromptGenUsage,
  ToolCall
} from "../../contract";
import { MAX_BREAKPOINTS } from "../../loop/cache";
import { runToolLoop } from "../../loop/run";
import type { LoopEvent, RunToolLoopOptions, ToolOutput, ToolSpec } from "../../loop/types";

/** A journaled step value with its cost, as a real journal stores it. */
type Stored = { value: unknown; costUsd: number };

const USAGE: PromptGenUsage = {
  promptTokens: 10,
  completionTokens: 2,
  cachedTokens: 0,
  cacheWriteTokens: 0
};
const NOTE = "The budget is nearly spent. Finish with what you have.";
const SYSTEM = "You review frames.";
const MODEL = "anthropic/claude-opus-5.5";
const USER: ChatMessage = { role: "user", content: "Check shot 3." };
const READ_FRAME = {
  name: "read_frame",
  description: "Return one frame of a shot.",
  inputSchema: { type: "object", properties: { shot: { type: "number" } }, required: ["shot"] }
};

/** An in-memory journal: runs work once per key, replays a structured clone afterwards. */
function createJournal(stored = new Map<string, Stored>()) {
  const { signal } = new AbortController();
  async function step<T>(
    key: string,
    work: (signal: AbortSignal) => Promise<{ value: T; costUsd: number }>
  ): Promise<T> {
    const hit = stored.get(key);
    if (hit !== undefined) return hit.value as T;
    const done = await work(signal);
    stored.set(key, structuredClone(done));
    return done.value;
  }
  return { step, stored };
}

/** A tool call. */
function call(id: string, shot: number): ToolCall {
  return { id, name: "read_frame", input: { shot } };
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

/** The answers of a run that reads one frame per turn for `turns` turns, then stops. */
function frameTurns(turns: number, costUsd = 0): PromptGenResult[] {
  const reads = Array.from({ length: turns }, (_, index) =>
    answer("", [call(`c${index + 1}`, index + 1)], costUsd)
  );
  return [...reads, answer("Done.", [], costUsd)];
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

/** The `read_frame` tool, answering with text only. */
function textTool(costUsd = 0): ToolSpec<{ shot: number }> {
  return {
    name: "read_frame",
    description: "Return one frame of a shot.",
    schema: z.object({ shot: z.number() }),
    run: async ({ shot }): Promise<ToolOutput> => ({
      value: shot,
      content: [{ type: "text", text: `Frame of shot ${shot}.` }],
      costUsd
    })
  };
}

/** The `read_frame` tool, answering with a caption and the frame image. */
function imageTool(): ToolSpec<{ shot: number }> {
  return {
    ...textTool(),
    run: async ({ shot }): Promise<ToolOutput> => ({
      value: shot,
      content: [
        { type: "text", text: `Frame ${shot}.` },
        { type: "image", path: `frames/f${shot}.png`, mimeType: "image/png", hash: `h${shot}` }
      ],
      costUsd: 0
    })
  };
}

/** Loop options with defaults for everything a test does not set. */
function loopOptions(
  overrides: Partial<RunToolLoopOptions> & Pick<RunToolLoopOptions, "generate">
): RunToolLoopOptions {
  return {
    model: MODEL,
    system: SYSTEM,
    messages: [USER],
    tools: [textTool()],
    budget: { usd: 10, finishAt: 0.8 },
    maxSteps: 10,
    step: createJournal().step,
    signal: new AbortController().signal,
    ...overrides
  };
}

/** The messages of a recorded request. */
function messagesOf(request: PromptGenRequest | undefined): ChatMessage[] {
  return request?.messages ?? [];
}

/** The marked parts of messages, as `<message index>:<text>`. */
function marksOf(messages: ChatMessage[]): string[] {
  return messages.flatMap((message, index) =>
    Array.isArray(message.content)
      ? message.content.flatMap(part =>
          part.type === "text" && part.cache === true ? [`${index}:${part.text}`] : []
        )
      : []
  );
}

/** Breakpoints of a request: the system mark and every marked part. */
function breakpoints(request: PromptGenRequest): number {
  return (request.cacheSystem === true ? 1 : 0) + marksOf(messagesOf(request)).length;
}

/** Index of the newest marked message of a request; -1 when it has none. */
function newestMark(request: PromptGenRequest | undefined): number {
  return messagesOf(request).findLastIndex(
    message =>
      Array.isArray(message.content) &&
      message.content.some(part => part.type === "text" && part.cache === true)
  );
}

/** Index of the first tool message of a request that still has an image; the length when none. */
function firstImageResult(request: PromptGenRequest | undefined): number {
  const messages = messagesOf(request);
  const index = messages.findIndex(
    message =>
      message.role === "tool" &&
      Array.isArray(message.content) &&
      message.content.some(part => part.type === "image")
  );
  return index === -1 ? messages.length : index;
}

/**
 * Messages as the provider's cache compares them: no `cache` key, and a
 * string content in its one-text-part form.
 */
function normalise(messages: ChatMessage[]): unknown[] {
  return messages.map(message => {
    if (message.role === "assistant") return message;
    const parts: ContentPart[] =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content;
    const content = parts.map(part =>
      part.type === "text" ? { type: "text", text: part.text } : part
    );
    return { ...message, content };
  });
}

/** The JSON of the first `length` messages of a request, normalised. */
function prefixJson(request: PromptGenRequest | undefined, length: number): string {
  return JSON.stringify(normalise(messagesOf(request).slice(0, length)));
}

/** A user message with `callerMarks` marked brief parts, then an unmarked question. */
function briefed(callerMarks: number): ChatMessage {
  const briefs = Array.from(
    { length: callerMarks },
    (_, index): ContentPart => ({ type: "text", text: `Brief ${index + 1}.`, cache: true })
  );
  return { role: "user", content: [...briefs, { type: "text", text: "Check shot 3." }] };
}

/** Freezes a value and everything in it, so a write to it throws. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const inner of Object.values(value)) deepFreeze(inner);
  return value;
}

/** The assistant turn that reads frame `shot`, and its text-only tool result. */
function textTurn(shot: number): ChatMessage[] {
  return [
    { role: "assistant", content: null, toolCalls: [call(`c${shot}`, shot)] },
    {
      role: "tool",
      toolCallId: `c${shot}`,
      content: [{ type: "text", text: `Frame of shot ${shot}.` }]
    }
  ];
}

/** The assistant turn that reads frame `shot`, and its tool result with the frame image. */
function imageTurn(shot: number): ChatMessage[] {
  return [
    { role: "assistant", content: null, toolCalls: [call(`c${shot}`, shot)] },
    {
      role: "tool",
      toolCallId: `c${shot}`,
      content: [
        { type: "text", text: `Frame ${shot}.` },
        { type: "image", path: `frames/f${shot}.png`, mimeType: "image/png", hash: `h${shot}` }
      ]
    }
  ];
}

/** A run of five image turns with `keepImages: 2`: six requests. */
async function imageRun(overrides: Partial<RunToolLoopOptions> = {}) {
  const { generate, requests } = scriptModel(frameTurns(5));
  const result = await runToolLoop(
    loopOptions({ generate, tools: [imageTool()], keepImages: 2, ...overrides })
  );
  return { requests, result };
}

/** A journal with only the steps stored before `key`. */
function journalBefore(stored: Map<string, Stored>, key: string): Map<string, Stored> {
  const keys = [...stored.keys()];
  return new Map([...stored].slice(0, keys.indexOf(key)));
}

describe("runToolLoop — conversation cache marks", () => {
  it("marks the system text and the newest stable message of every request by default", async () => {
    const { generate, requests } = scriptModel(frameTurns(2));

    await runToolLoop(loopOptions({ generate }));

    expect(requests.map(request => request.cacheSystem)).toEqual([true, true, true]);
    expect(requests.map(request => marksOf(messagesOf(request)))).toEqual([
      ["0:Check shot 3."],
      ["0:Check shot 3.", "2:Frame of shot 1."],
      ["2:Frame of shot 1.", "4:Frame of shot 2."]
    ]);
  });

  it("sends a marked string content as one marked text part and leaves the rest as is", async () => {
    const { generate, requests } = scriptModel(frameTurns(1));

    await runToolLoop(loopOptions({ generate }));

    expect(requests[1]).toEqual({
      prompt: "",
      system: SYSTEM,
      model: MODEL,
      messages: [
        { role: "user", content: [{ type: "text", text: "Check shot 3.", cache: true }] },
        { role: "assistant", content: null, toolCalls: [call("c1", 1)] },
        {
          role: "tool",
          toolCallId: "c1",
          content: [{ type: "text", text: "Frame of shot 1.", cache: true }]
        }
      ],
      tools: [READ_FRAME],
      cacheSystem: true
    });
  });

  it("marks the same request with an explicit conversation mode", async () => {
    const byDefault = scriptModel(frameTurns(2));
    const explicit = scriptModel(frameTurns(2));

    await runToolLoop(loopOptions({ generate: byDefault.generate }));
    await runToolLoop(loopOptions({ generate: explicit.generate, cache: "conversation" }));

    expect(explicit.requests).toEqual(byDefault.requests);
  });
});

describe("runToolLoop — the limit of 4 breakpoints", () => {
  it.each([
    {
      callerMarks: 1,
      rolling: [["0:Check shot 3."], ["0:Check shot 3.", "2:F1"], ["2:F1", "4:F2"]]
    },
    { callerMarks: 2, rolling: [["0:Check shot 3."], ["2:F1"], ["4:F2"]] },
    { callerMarks: 3, rolling: [[], [], []] },
    { callerMarks: 4, rolling: [[], [], []] }
  ])("keeps $callerMarks caller marks and stays within the limit", async scenario => {
    const { generate, requests } = scriptModel(frameTurns(2));
    const callerMarks = Array.from(
      { length: scenario.callerMarks },
      (_, index) => `0:Brief ${index + 1}.`
    );
    const tool: ToolSpec<{ shot: number }> = {
      ...textTool(),
      run: async ({ shot }) => ({
        value: shot,
        content: [{ type: "text", text: `F${shot}` }],
        costUsd: 0
      })
    };

    await runToolLoop(
      loopOptions({ generate, messages: [briefed(scenario.callerMarks)], tools: [tool] })
    );

    expect(requests).toHaveLength(3);
    for (const [index, request] of requests.entries()) {
      const marks = marksOf(messagesOf(request));

      expect(breakpoints(request)).toBeLessThanOrEqual(MAX_BREAKPOINTS);
      expect(marks.slice(0, scenario.callerMarks)).toEqual(callerMarks);
      expect(marks.slice(scenario.callerMarks)).toEqual(scenario.rolling[index]);
    }
  });

  it("sends the system mark with 3 caller marks and leaves it out with 4", async () => {
    const three = scriptModel(frameTurns(1));
    const four = scriptModel(frameTurns(1));

    await runToolLoop(loopOptions({ generate: three.generate, messages: [briefed(3)] }));
    await runToolLoop(loopOptions({ generate: four.generate, messages: [briefed(4)] }));

    expect(three.requests.map(request => request.cacheSystem)).toEqual([true, true]);
    expect(three.requests.map(request => breakpoints(request))).toEqual([4, 4]);
    for (const request of four.requests) expect(request).not.toHaveProperty("cacheSystem");
    expect(four.requests.map(request => breakpoints(request))).toEqual([4, 4]);
  });
});

describe("runToolLoop — cache and images", () => {
  it("puts the mark on the newest message before the first tool message that still has images", async () => {
    const { requests } = await imageRun();

    expect(requests).toHaveLength(6);
    for (const request of requests) {
      const stable = messagesOf(request).slice(0, firstImageResult(request));
      const newestMarkable = stable.findLastIndex(message => message.role !== "assistant");

      expect(newestMark(request)).toBe(newestMarkable);
    }
    expect(requests.map(request => marksOf(messagesOf(request)))).toEqual([
      ["0:Check shot 3."],
      ["0:Check shot 3."],
      ["0:Check shot 3."],
      ["0:Check shot 3.", "2:[image dropped: f1.png]"],
      ["2:[image dropped: f1.png]", "4:[image dropped: f2.png]"],
      ["4:[image dropped: f2.png]", "6:[image dropped: f3.png]"]
    ]);
  });

  it("sends the marked prefix of a request unchanged in the next request", async () => {
    const { requests } = await imageRun();

    for (const [index, request] of requests.slice(0, -1).entries()) {
      const length = newestMark(request) + 1;

      expect(length).toBeGreaterThan(0);
      expect(prefixJson(requests[index + 1], length)).toBe(prefixJson(request, length));
    }
  });

  it("keeps the prefix across the step that replaces a message's images", async () => {
    const { requests } = await imageRun();
    const withImage = messagesOf(requests[2]);
    const replaced = messagesOf(requests[3]);

    expect(withImage[2]?.content).toMatchObject([{ type: "text" }, { type: "image" }]);
    expect(replaced[2]?.content).toEqual([
      { type: "text", text: "Frame 1." },
      { type: "text", text: "[image dropped: f1.png]", cache: true }
    ]);
    expect(prefixJson(requests[3], newestMark(requests[2]) + 1)).toBe(
      prefixJson(requests[2], newestMark(requests[2]) + 1)
    );
  });

  it("sends a replaced message identically in every later request", async () => {
    const { requests } = await imageRun();
    const replacedAt = [
      { message: 2, firstRequest: 3 },
      { message: 4, firstRequest: 4 },
      { message: 6, firstRequest: 5 }
    ];

    for (const { message, firstRequest } of replacedAt) {
      const first = JSON.stringify(
        normalise(messagesOf(requests[firstRequest]).slice(message, message + 1))
      );

      for (const later of requests.slice(firstRequest + 1)) {
        expect(JSON.stringify(normalise(messagesOf(later).slice(message, message + 1)))).toBe(
          first
        );
      }
    }
    expect(normalise(messagesOf(requests[5]).slice(2, 3))).toEqual([
      {
        role: "tool",
        toolCallId: "c1",
        content: [
          { type: "text", text: "Frame 1." },
          { type: "text", text: "[image dropped: f1.png]" }
        ]
      }
    ]);
  });

  it.each([
    { keepImages: Infinity },
    { keepImages: 10 }
  ])("marks the newest tool result when keepImages is $keepImages", async ({ keepImages }) => {
    const { requests } = await imageRun({ keepImages });

    expect(requests.map(request => marksOf(messagesOf(request)))).toEqual([
      ["0:Check shot 3."],
      ["0:Check shot 3.", "2:Frame 1."],
      ["2:Frame 1.", "4:Frame 2."],
      ["4:Frame 2.", "6:Frame 3."],
      ["6:Frame 3.", "8:Frame 4."],
      ["8:Frame 4.", "10:Frame 5."]
    ]);
    expect(messagesOf(requests[5])[10]?.content).toMatchObject([
      { type: "text", text: "Frame 5.", cache: true },
      { type: "image", path: "frames/f5.png" }
    ]);
  });

  it("marks the kept image turns at the end of the run, once they can no longer be dropped", async () => {
    const { requests } = await imageRun({ maxSteps: 6 });

    expect(marksOf(messagesOf(requests[4]))).toEqual([
      "2:[image dropped: f1.png]",
      "4:[image dropped: f2.png]"
    ]);
    expect(marksOf(messagesOf(requests[5]))).toEqual(["4:[image dropped: f2.png]", "10:Frame 5."]);
  });

  it("counts the assistant turns of the given messages when it decides which images can still be dropped", async () => {
    const { generate, requests } = scriptModel([answer("", [call("c3", 3)]), answer("Done.")]);
    const messages = [USER, ...imageTurn(1), ...imageTurn(2)];

    await runToolLoop(
      loopOptions({ generate, messages, tools: [imageTool()], keepImages: 2, maxSteps: 2 })
    );

    expect(requests.map(request => marksOf(messagesOf(request)))).toEqual([
      ["0:Check shot 3."],
      ["0:Check shot 3.", "6:Frame 3."]
    ]);
    expect(messagesOf(requests[0])[2]?.content).toMatchObject([
      { type: "text" },
      { type: "image" }
    ]);
    expect(messagesOf(requests[1])[2]?.content).toEqual([
      { type: "text", text: "Frame 1." },
      { type: "text", text: "[image dropped: f1.png]" }
    ]);
  });
});

describe("runToolLoop — cache modes", () => {
  it('cache: "system" sends the requests of 0.12.0: the system mark and no mark on a part', async () => {
    const { generate, requests } = scriptModel(frameTurns(2));
    const base = {
      prompt: "",
      system: SYSTEM,
      model: MODEL,
      tools: [READ_FRAME],
      cacheSystem: true
    };

    await runToolLoop(loopOptions({ generate, cache: "system" }));

    expect(requests).toEqual([
      { ...base, messages: [USER] },
      { ...base, messages: [USER, ...textTurn(1)] },
      { ...base, messages: [USER, ...textTurn(1), ...textTurn(2)] }
    ]);
  });

  it('cache: "system" drops old images and still marks no part', async () => {
    const { generate, requests } = scriptModel(frameTurns(3));

    await runToolLoop(loopOptions({ generate, tools: [imageTool()], cache: "system" }));

    expect(requests.map(request => breakpoints(request))).toEqual([1, 1, 1, 1]);
    expect(messagesOf(requests[3])[2]?.content).toEqual([
      { type: "text", text: "Frame 1." },
      { type: "text", text: "[image dropped: f1.png]" }
    ]);
  });

  it('cache: "system" keeps the system mark and adds nothing next to 4 caller marks', async () => {
    const { generate, requests } = scriptModel(frameTurns(1));

    await runToolLoop(loopOptions({ generate, messages: [briefed(4)], cache: "system" }));

    expect(requests.map(request => request.cacheSystem)).toEqual([true, true]);
    expect(requests.map(request => marksOf(messagesOf(request)).length)).toEqual([4, 4]);
  });

  it('cache: "off" sends no system mark and adds no mark', async () => {
    const { generate, requests } = scriptModel(frameTurns(2));

    await runToolLoop(loopOptions({ generate, cache: "off", reasoning: "low" }));

    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request).not.toHaveProperty("cacheSystem");
      expect(breakpoints(request)).toBe(0);
    }
    expect(requests[0]).toEqual({
      prompt: "",
      system: SYSTEM,
      model: MODEL,
      messages: [USER],
      tools: [READ_FRAME],
      params: { reasoning: "low" }
    });
  });

  it('cache: "off" passes a caller mark through', async () => {
    const { generate, requests } = scriptModel(frameTurns(1));

    await runToolLoop(loopOptions({ generate, messages: [briefed(1)], cache: "off" }));

    expect(requests.map(request => marksOf(messagesOf(request)))).toEqual([
      ["0:Brief 1."],
      ["0:Brief 1."]
    ]);
  });
});

describe("runToolLoop — cache on a resumed run", () => {
  it("sends the same request for the last model step after a restart", async () => {
    const stored = new Map<string, Stored>();
    const first = scriptModel(frameTurns(2));
    await runToolLoop(loopOptions({ generate: first.generate, step: createJournal(stored).step }));
    expect([...stored.keys()]).toEqual(["model:1", "tool:c1", "model:2", "tool:c2", "model:3"]);

    const resumed = scriptModel([answer("Done.")]);
    await runToolLoop(
      loopOptions({
        generate: resumed.generate,
        step: createJournal(journalBefore(stored, "model:3")).step
      })
    );

    expect(resumed.requests).toHaveLength(1);
    expect(resumed.requests[0]).toEqual(first.requests[2]);
    expect(JSON.stringify(resumed.requests[0])).toBe(JSON.stringify(first.requests[2]));
    expect(marksOf(messagesOf(resumed.requests[0]))).toEqual([
      "2:Frame of shot 1.",
      "4:Frame of shot 2."
    ]);
  });

  it("sends the same requests from an empty journal as the full run did", async () => {
    const first = scriptModel(frameTurns(5));
    const again = scriptModel(frameTurns(5));
    const options = { tools: [imageTool()], keepImages: 2 };

    await runToolLoop(loopOptions({ ...options, generate: first.generate }));
    await runToolLoop(loopOptions({ ...options, generate: again.generate }));

    expect(again.requests).toEqual(first.requests);
    expect(JSON.stringify(again.requests)).toBe(JSON.stringify(first.requests));
  });

  it("sends the same requests after a restart in the middle of an image run", async () => {
    const stored = new Map<string, Stored>();
    const first = scriptModel(frameTurns(5));
    const options = { tools: [imageTool()], keepImages: 2 };
    await runToolLoop(
      loopOptions({ ...options, generate: first.generate, step: createJournal(stored).step })
    );

    const resumed = scriptModel(frameTurns(5).slice(3));
    await runToolLoop(
      loopOptions({
        ...options,
        generate: resumed.generate,
        step: createJournal(journalBefore(stored, "model:4")).step
      })
    );

    expect(resumed.requests).toEqual(first.requests.slice(3));
    expect(JSON.stringify(resumed.requests)).toBe(JSON.stringify(first.requests.slice(3)));
  });

  it("sends the same request for the step that starts finish mode, and for the one after", async () => {
    const stored = new Map<string, Stored>();
    const first = scriptModel(frameTurns(2, 0.125));
    const options = {
      tools: [textTool(0.25)],
      budget: { usd: 1, finishAt: 0.375 },
      finishNote: NOTE
    };
    await runToolLoop(
      loopOptions({ ...options, generate: first.generate, step: createJournal(stored).step })
    );

    const resumed = scriptModel(frameTurns(2, 0.125).slice(1));
    const result = await runToolLoop(
      loopOptions({
        ...options,
        generate: resumed.generate,
        step: createJournal(journalBefore(stored, "model:2")).step
      })
    );

    expect(marksOf(messagesOf(first.requests[1]))).toEqual(["0:Check shot 3.", `3:${NOTE}`]);
    expect(marksOf(messagesOf(first.requests[2]))).toEqual([`3:${NOTE}`, "5:Frame of shot 2."]);
    expect(resumed.requests).toEqual(first.requests.slice(1));
    expect(JSON.stringify(resumed.requests)).toBe(JSON.stringify(first.requests.slice(1)));
    expect(result.messages[3]).toEqual({ role: "user", content: NOTE });
  });

  it("sends the same request after a restart that replays the finish-mode step", async () => {
    const stored = new Map<string, Stored>();
    const first = scriptModel(frameTurns(2, 0.125));
    const options = {
      tools: [textTool(0.25)],
      budget: { usd: 1, finishAt: 0.375 },
      finishNote: NOTE
    };
    await runToolLoop(
      loopOptions({ ...options, generate: first.generate, step: createJournal(stored).step })
    );

    const resumed = scriptModel([answer("Done.", [], 0.125)]);
    await runToolLoop(
      loopOptions({
        ...options,
        generate: resumed.generate,
        step: createJournal(journalBefore(stored, "model:3")).step
      })
    );

    expect(resumed.requests).toEqual([first.requests[2]]);
    expect(JSON.stringify(resumed.requests[0])).toBe(JSON.stringify(first.requests[2]));
  });
});

describe("runToolLoop — cache and the result history", () => {
  it("returns a history without the loop's marks", async () => {
    const { generate, requests } = scriptModel(frameTurns(2));

    const result = await runToolLoop(loopOptions({ generate }));

    expect(marksOf(messagesOf(requests[2]))).toHaveLength(2);
    expect(marksOf(result.messages)).toEqual([]);
    expect(JSON.stringify(result.messages)).not.toContain('"cache"');
    expect(result.messages.slice(0, 3)).toEqual([
      USER,
      { role: "assistant", content: null, toolCalls: [call("c1", 1)] },
      { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "Frame of shot 1." }] }
    ]);
  });

  it("keeps the caller's marks in the history and never changes the caller's messages", async () => {
    const { generate } = scriptModel(frameTurns(2));
    const messages = deepFreeze<ChatMessage[]>([briefed(1), { role: "user", content: "Go on." }]);
    const before = structuredClone(messages);

    const result = await runToolLoop(loopOptions({ generate, messages }));

    expect(messages).toEqual(before);
    expect(marksOf(result.messages)).toEqual(["0:Brief 1."]);
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[1]).toBe(messages[1]);
  });

  it("keeps a replayed history free of marks", async () => {
    const stored = new Map<string, Stored>();
    const { generate } = scriptModel(frameTurns(2));
    const first = await runToolLoop(loopOptions({ generate, step: createJournal(stored).step }));
    const deadModel = vi.fn(async (): Promise<PromptGenResult> => {
      throw new Error("the model is not called on a replay");
    });

    const replay = await runToolLoop(
      loopOptions({ generate: deadModel, step: createJournal(stored).step })
    );

    expect(replay).toEqual(first);
    expect(marksOf(replay.messages)).toEqual([]);
  });
});

describe("runToolLoop — cached usage", () => {
  it("passes cachedReadTokens and cachedWriteTokens through on the model event", async () => {
    const usage: PromptGenUsage = {
      promptTokens: 2400,
      completionTokens: 120,
      cachedTokens: 1800,
      cacheWriteTokens: 350,
      cachedReadTokens: 1800,
      cachedWriteTokens: 350
    };
    const { generate } = scriptModel([{ ...answer("Done."), usage }]);
    const events: LoopEvent[] = [];

    await runToolLoop(loopOptions({ generate, onStep: event => events.push(event) }));

    expect(events).toEqual([
      { kind: "model", step: 1, text: "Done.", toolCalls: [], costUsd: 0, usage }
    ]);
  });

  it("leaves the cached counts out of the model event when the provider reports none", async () => {
    const { generate } = scriptModel([answer("Done.")]);
    const events: LoopEvent[] = [];

    await runToolLoop(loopOptions({ generate, onStep: event => events.push(event) }));

    const [event] = events;
    expect(event?.kind === "model" ? event.usage : undefined).toEqual(USAGE);
    expect(event?.kind === "model" ? Object.keys(event.usage) : []).not.toContain(
      "cachedReadTokens"
    );
  });

  it("replays the cached counts from the journal", async () => {
    const stored = new Map<string, Stored>();
    const usage: PromptGenUsage = { ...USAGE, cachedReadTokens: 0, cachedWriteTokens: 900 };
    const { generate } = scriptModel([{ ...answer("Done."), usage }]);
    await runToolLoop(loopOptions({ generate, step: createJournal(stored).step }));
    const events: LoopEvent[] = [];

    await runToolLoop(
      loopOptions({
        generate,
        step: createJournal(stored).step,
        onStep: event => events.push(event)
      })
    );

    expect(generate).toHaveBeenCalledTimes(1);
    expect(events).toMatchObject([{ kind: "model", usage }]);
  });
});

describe("runToolLoop — cache types", () => {
  it("makes the cache option optional, with the three modes", () => {
    expectTypeOf<Pick<RunToolLoopOptions, "cache">>().toEqualTypeOf<{
      cache?: "system" | "conversation" | "off";
    }>();
    expectTypeOf<RunToolLoopOptions["cache"]>().toEqualTypeOf<
      "system" | "conversation" | "off" | undefined
    >();

    // @ts-expect-error a mode outside the three is rejected
    const wrong: RunToolLoopOptions["cache"] = "always";
    expect(wrong).toBe("always");
  });

  it("makes the cached usage counts optional numbers", () => {
    expectTypeOf<Pick<PromptGenUsage, "cachedReadTokens" | "cachedWriteTokens">>().toEqualTypeOf<{
      cachedReadTokens?: number;
      cachedWriteTokens?: number;
    }>();
    expectTypeOf<PromptGenUsage["cachedReadTokens"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<PromptGenUsage["cachedWriteTokens"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<Extract<LoopEvent, { kind: "model" }>["usage"]>().toEqualTypeOf<PromptGenUsage>();

    const withoutCounts: PromptGenUsage = { ...USAGE };
    expect(withoutCounts).not.toHaveProperty("cachedReadTokens");
  });
});
