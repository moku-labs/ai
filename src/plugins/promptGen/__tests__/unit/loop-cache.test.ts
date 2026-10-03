/**
 * @file runToolLoop — unit tests of the pure cache marks of a request.
 */
/* eslint-disable unicorn/no-null -- ChatMessage.content is `string | null` in the contract */
import { describe, expect, it } from "vitest";
import type { ChatMessage, ContentPart } from "../../contract";
import {
  type CachedRequest,
  type CachePlan,
  cachedRequest,
  MAX_BREAKPOINTS
} from "../../loop/cache";
import { withoutOldImages } from "../../loop/history";

const USER: ChatMessage = { role: "user", content: "Check shot 3." };
const MARKED_USER: ChatMessage = {
  role: "user",
  content: [{ type: "text", text: "Check shot 3.", cache: true }]
};

/** The image of frame `shot`. */
function image(shot: number): ContentPart {
  return { type: "image", path: `frames/f${shot}.png`, mimeType: "image/png", hash: `h${shot}` };
}

/** The assistant turn that reads frame `shot` with call `c<shot>`. */
function turn(shot: number): ChatMessage {
  return {
    role: "assistant",
    content: null,
    toolCalls: [{ id: `c${shot}`, name: "read_frame", input: { shot } }]
  };
}

/** A text-only tool result of call `c<shot>`. */
function frameText(shot: number): ChatMessage {
  return {
    role: "tool",
    toolCallId: `c${shot}`,
    content: [{ type: "text", text: `Frame ${shot}.` }]
  };
}

/** A tool result of call `c<shot>` with a caption and the frame image. */
function frameImage(shot: number): ChatMessage {
  return {
    role: "tool",
    toolCallId: `c${shot}`,
    content: [{ type: "text", text: `Frame ${shot}.` }, image(shot)]
  };
}

/** A history of `turns` assistant turns, each answered by one tool result. */
function historyOf(turns: number, result: (shot: number) => ChatMessage): ChatMessage[] {
  const shots = Array.from({ length: turns }, (_, index) => index + 1);
  return [USER, ...shots.flatMap(shot => [turn(shot), result(shot)])];
}

/** A conversation-mode plan of a run with one given user message and maxSteps 10. */
function plan(overrides: Partial<CachePlan> = {}): CachePlan {
  return { mode: "conversation", keepImages: 2, maxAssistants: 9, ...overrides };
}

/** The marked parts of request messages, as `<message index>:<text>`. */
function marksOf(messages: ChatMessage[]): string[] {
  return messages.flatMap((message, index) =>
    Array.isArray(message.content)
      ? message.content.flatMap(part =>
          part.type === "text" && part.cache === true ? [`${index}:${part.text}`] : []
        )
      : []
  );
}

/** Freezes a value and everything in it, so a write to it throws. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const inner of Object.values(value)) deepFreeze(inner);
  return value;
}

/** A user message with `callerMarks` marked brief parts, then an unmarked question. */
function briefed(callerMarks: number): ChatMessage {
  const briefs = Array.from(
    { length: callerMarks },
    (_, index): ContentPart => ({ type: "text", text: `Brief ${index + 1}.`, cache: true })
  );
  return { role: "user", content: [...briefs, { type: "text", text: "Check shot 3." }] };
}

/** A two-turn text history whose first user message carries caller marks. */
function briefedHistory(callerMarks: number): ChatMessage[] {
  return [briefed(callerMarks), ...historyOf(2, frameText).slice(1)];
}

/** Breakpoints of a request: the system mark and every marked part. */
function breakpoints(request: CachedRequest): number {
  return (request.cacheSystem ? 1 : 0) + marksOf(request.messages).length;
}

describe("cachedRequest — off and system", () => {
  const history = historyOf(3, frameImage);

  it("off: sends the trimmed history without a system mark and adds no mark", () => {
    const request = cachedRequest(history, plan({ mode: "off" }));

    expect(request).toEqual({ messages: withoutOldImages(history, 2), cacheSystem: false });
    expect(marksOf(request.messages)).toEqual([]);
  });

  it("off: passes a caller mark through", () => {
    const request = cachedRequest([briefed(1), turn(1), frameText(1)], plan({ mode: "off" }));

    expect(marksOf(request.messages)).toEqual(["0:Brief 1."]);
    expect(request.cacheSystem).toBe(false);
  });

  it("system: sends the trimmed history with the system mark only", () => {
    const request = cachedRequest(history, plan({ mode: "system" }));

    expect(request).toEqual({ messages: withoutOldImages(history, 2), cacheSystem: true });
    expect(marksOf(request.messages)).toEqual([]);
  });

  it("drops old tool images in every mode", () => {
    const dropped = { type: "text", text: "[image dropped: f1.png]" };

    for (const mode of ["off", "system", "conversation"] as const) {
      const { messages } = cachedRequest(history, plan({ mode }));

      expect(messages[2]?.content).toMatchObject([{ type: "text", text: "Frame 1." }, dropped]);
    }
  });
});

describe("cachedRequest — conversation marks", () => {
  it("turns a marked string content into one marked text part", () => {
    expect(cachedRequest([USER], plan())).toEqual({ messages: [MARKED_USER], cacheSystem: true });
  });

  it("marks the last non-blank text part, also when an image follows it", () => {
    const look: ChatMessage = {
      role: "user",
      content: [
        { type: "text", text: "Shot list." },
        { type: "text", text: "Look." },
        { type: "text", text: "  " },
        image(1)
      ]
    };

    const { messages } = cachedRequest([look], plan());

    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Shot list." },
          { type: "text", text: "Look.", cache: true },
          { type: "text", text: "  " },
          image(1)
        ]
      }
    ]);
  });

  it("sets two rolling marks: the previous request's and this one's", () => {
    const { messages, cacheSystem } = cachedRequest(historyOf(2, frameText), plan());

    expect(marksOf(messages)).toEqual(["2:Frame 1.", "4:Frame 2."]);
    expect(messages[0]).toBe(USER);
    expect(cacheSystem).toBe(true);
  });

  it("marks the previous request's target after the first model turn", () => {
    const { messages } = cachedRequest(historyOf(1, frameText), plan());

    expect(marksOf(messages)).toEqual(["0:Check shot 3.", "2:Frame 1."]);
  });

  it("never marks an assistant message and skips a message with blank text", () => {
    const history: ChatMessage[] = [
      USER,
      { role: "assistant", content: "Looking.", toolCalls: [] },
      { role: "tool", toolCallId: "c1", content: "   " },
      { role: "assistant", content: "Done." }
    ];

    const { messages } = cachedRequest(history, plan());

    expect(marksOf(messages)).toEqual(["0:Check shot 3."]);
    expect(messages.slice(1)).toEqual(history.slice(1));
  });

  it("adds no mark when no message has text to mark", () => {
    const history: ChatMessage[] = [
      { role: "user", content: [image(1)] },
      { role: "assistant", content: "Seen." },
      { role: "user", content: "" }
    ];

    expect(cachedRequest(history, plan())).toEqual({ messages: history, cacheSystem: true });
  });

  it("is a pure function: it never changes the history and repeats its answer", () => {
    const history = deepFreeze(historyOf(4, frameImage));
    const before = structuredClone(history);

    const first = cachedRequest(history, plan());
    const second = cachedRequest(history, plan());

    expect(history).toEqual(before);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(marksOf(first.messages)).toHaveLength(2);
  });
});

describe("cachedRequest — images", () => {
  it("puts the mark in front of the first tool message that can still lose its images", () => {
    const { messages } = cachedRequest(historyOf(3, frameImage), plan());

    expect(marksOf(messages)).toEqual(["0:Check shot 3.", "2:[image dropped: f1.png]"]);
    expect(messages[4]).toEqual(frameImage(2));
    expect(messages[6]).toEqual(frameImage(3));
  });

  it("shares one mark when this request and the previous one have the same target", () => {
    const { messages } = cachedRequest(historyOf(2, frameImage), plan());

    expect(marksOf(messages)).toEqual(["0:Check shot 3."]);
  });

  it("marks the newest tool result when keepImages keeps every turn", () => {
    const { messages } = cachedRequest(historyOf(3, frameImage), plan({ keepImages: Infinity }));

    expect(marksOf(messages)).toEqual(["4:Frame 2.", "6:Frame 3."]);
    expect(messages[6]?.content).toEqual([
      { type: "text", text: "Frame 3.", cache: true },
      image(3)
    ]);
  });

  it("marks the newest tool result when keepImages drops every tool image", () => {
    const { messages } = cachedRequest(historyOf(2, frameImage), plan({ keepImages: 0 }));

    expect(marksOf(messages)).toEqual(["2:[image dropped: f1.png]", "4:[image dropped: f2.png]"]);
  });

  it("treats the image turns the run can no longer drop as stable", () => {
    const lastRequest = plan({ maxAssistants: 3 });

    const { messages } = cachedRequest(historyOf(3, frameImage), lastRequest);

    expect(marksOf(messages)).toEqual(["0:Check shot 3.", "6:Frame 3."]);
  });

  it("does not hold back a user message with an image", () => {
    const look: ChatMessage = {
      role: "user",
      content: [{ type: "text", text: "Look." }, image(9)]
    };

    const { messages } = cachedRequest([look, turn(1), frameText(1)], plan());

    expect(marksOf(messages)).toEqual(["0:Look.", "2:Frame 1."]);
  });
});

describe("cachedRequest — the limit of 4 breakpoints", () => {
  it("is the Anthropic limit", () => {
    expect(MAX_BREAKPOINTS).toBe(4);
  });

  it.each([
    { callerMarks: 0, rolling: ["2:Frame 1.", "4:Frame 2."], cacheSystem: true, total: 3 },
    { callerMarks: 1, rolling: ["2:Frame 1.", "4:Frame 2."], cacheSystem: true, total: 4 },
    { callerMarks: 2, rolling: ["4:Frame 2."], cacheSystem: true, total: 4 },
    { callerMarks: 3, rolling: [], cacheSystem: true, total: 4 },
    { callerMarks: 4, rolling: [], cacheSystem: false, total: 4 }
  ])("keeps $callerMarks caller marks and adds $rolling.length rolling marks", scenario => {
    const request = cachedRequest(briefedHistory(scenario.callerMarks), plan());
    const callerMarks = Array.from(
      { length: scenario.callerMarks },
      (_, index) => `0:Brief ${index + 1}.`
    );

    expect(marksOf(request.messages)).toEqual([...callerMarks, ...scenario.rolling]);
    expect(request.cacheSystem).toBe(scenario.cacheSystem);
    expect(breakpoints(request)).toBe(scenario.total);
    expect(breakpoints(request)).toBeLessThanOrEqual(MAX_BREAKPOINTS);
  });

  it("leaves more than 4 caller marks to the caller: no system mark, no rolling mark", () => {
    const request = cachedRequest(briefedHistory(5), plan());

    expect(request.cacheSystem).toBe(false);
    expect(marksOf(request.messages)).toEqual([
      "0:Brief 1.",
      "0:Brief 2.",
      "0:Brief 3.",
      "0:Brief 4.",
      "0:Brief 5."
    ]);
  });

  it("gives no slot to a target the caller already marked", () => {
    const callerMarked: ChatMessage = {
      role: "tool",
      toolCallId: "c2",
      content: [{ type: "text", text: "Frame 2.", cache: true }]
    };
    const history = [briefed(1), turn(1), frameText(1), turn(2), callerMarked];

    const request = cachedRequest(history, plan());

    expect(marksOf(request.messages)).toEqual(["0:Brief 1.", "2:Frame 1.", "4:Frame 2."]);
    expect(request.messages[4]).toBe(callerMarked);
    expect(breakpoints(request)).toBe(MAX_BREAKPOINTS);
  });

  it("drops the oldest rolling mark first", () => {
    const request = cachedRequest(briefedHistory(2), plan());

    expect(request.messages[2]).toEqual(frameText(1));
    expect(request.messages[4]?.content).toEqual([{ type: "text", text: "Frame 2.", cache: true }]);
  });
});
