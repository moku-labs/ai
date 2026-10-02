import { describe, expect, it } from "vitest";
import type { ChatMessage, ContentPart } from "../../../promptGen/contract";
import { ToolArgumentsError } from "../../../promptGen/contract";
import {
  finishReasonOf,
  imagePartsOf,
  inputTextOf,
  promptTextOf,
  readToolCalls,
  systemMessages,
  toolFields,
  turnMessages,
  usageOf
} from "../../llm/conversation";

// ─────────────────────────────────────────────────────────────────────────────
// fal chat wire mapping of a multi-turn request and the reading of an answer.
// ─────────────────────────────────────────────────────────────────────────────

const STILL: ContentPart = {
  type: "image",
  path: "/s/still.png",
  mimeType: "image/png",
  hash: "a"
};
const FRAME: ContentPart = {
  type: "image",
  path: "/s/frame.png",
  mimeType: "image/png",
  hash: "b"
};
const EPHEMERAL = { type: "ephemeral" };

/** Captures what a function throws. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("systemMessages", () => {
  it("sends no system message without system text", () => {
    expect(systemMessages(undefined, true)).toEqual([]);
  });

  it("sends the system text as is without cacheSystem", () => {
    expect(systemMessages("Be brief.", false)).toEqual([{ role: "system", content: "Be brief." }]);
  });

  it("sends the system text as one cached part with cacheSystem", () => {
    expect(systemMessages("Be brief.", true)).toEqual([
      {
        role: "system",
        content: [{ type: "text", text: "Be brief.", cache_control: EPHEMERAL }]
      }
    ]);
  });
});

describe("turnMessages", () => {
  it("maps user, assistant and tool turns to the OpenAI chat form", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Check shot 3." },
      {
        role: "assistant",
        // eslint-disable-next-line unicorn/no-null -- a tool-only assistant turn has null content by contract
        content: null,
        toolCalls: [{ id: "toolu_01", name: "read_frame", input: { shot: 3 } }]
      },
      { role: "tool", toolCallId: "toolu_01", content: "Subject is cut at the chin." },
      { role: "assistant", content: "Reframe shot 3.", toolCalls: [] },
      { role: "assistant", content: "Done." }
    ];

    expect(turnMessages(messages, [])).toEqual([
      { role: "user", content: "Check shot 3." },
      {
        role: "assistant",
        // eslint-disable-next-line unicorn/no-null -- the wire carries JSON null content
        content: null,
        tool_calls: [
          {
            id: "toolu_01",
            type: "function",
            function: { name: "read_frame", arguments: '{"shot":3}' }
          }
        ]
      },
      { role: "tool", tool_call_id: "toolu_01", content: "Subject is cut at the chin." },
      { role: "assistant", content: "Reframe shot 3." },
      { role: "assistant", content: "Done." }
    ]);
  });

  it("sends a missing tool-call input as {}", () => {
    const [assistant] = turnMessages(
      [{ role: "assistant", content: "", toolCalls: [{ id: "c", name: "t", input: undefined }] }],
      []
    );
    expect(assistant).toMatchObject({ tool_calls: [{ function: { arguments: "{}" } }] });
  });

  it("marks cached text parts and gives each image part the next URL in message order", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Shot list.", cache: true }, STILL]
      },
      {
        role: "tool",
        toolCallId: "toolu_01",
        content: [{ type: "text", text: "Frame 12." }, FRAME]
      }
    ];

    expect(turnMessages(messages, ["https://cdn/a.png", "https://cdn/b.png"])).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Shot list.", cache_control: EPHEMERAL },
          { type: "image_url", image_url: { url: "https://cdn/a.png" } }
        ]
      },
      {
        role: "tool",
        tool_call_id: "toolu_01",
        content: [
          { type: "text", text: "Frame 12." },
          { type: "image_url", image_url: { url: "https://cdn/b.png" } }
        ]
      }
    ]);
  });

  it("leaves image parts out before the upload", () => {
    expect(turnMessages([{ role: "user", content: [STILL] }], [])).toEqual([
      { role: "user", content: [] }
    ]);
  });
});

describe("imagePartsOf", () => {
  it("lists every image part of user and tool turns, in message order", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [STILL, { type: "text", text: "a" }] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "plain" },
      { role: "tool", toolCallId: "c", content: [FRAME, STILL] }
    ];
    expect(imagePartsOf(messages)).toEqual([STILL, FRAME, STILL]);
  });
});

describe("toolFields", () => {
  const readFrame = {
    name: "read_frame",
    description: "Return one frame.",
    inputSchema: { type: "object", properties: { shot: { type: "number" } } }
  };

  it("sends nothing without tools and tool choice, or with an empty tool list", () => {
    expect(toolFields({})).toEqual({});
    expect(toolFields({ tools: [] })).toEqual({});
  });

  it("maps tools to function tools with their schema as parameters", () => {
    expect(toolFields({ tools: [readFrame] })).toEqual({
      tools: [
        {
          type: "function",
          function: {
            name: "read_frame",
            description: "Return one frame.",
            parameters: readFrame.inputSchema
          }
        }
      ]
    });
  });

  it.each(["auto", "none", "required"] as const)("sends tool choice %s as is", choice => {
    expect(toolFields({ tools: [readFrame], toolChoice: choice }).tool_choice).toBe(choice);
  });

  it("sends a named tool choice as a function choice", () => {
    expect(toolFields({ toolChoice: { name: "read_frame" } })).toEqual({
      tool_choice: { type: "function", function: { name: "read_frame" } }
    });
  });
});

describe("readToolCalls", () => {
  /** One `tool_calls` entry with the given arguments. */
  const call = (args?: unknown): unknown => ({
    id: "toolu_01",
    type: "function",
    function: args === undefined ? { name: "read_frame" } : { name: "read_frame", arguments: args }
  });

  it("reads no calls when the field is missing", () => {
    expect(readToolCalls(undefined)).toEqual([]);
  });

  it("parses JSON arguments", () => {
    expect(readToolCalls([call('{"shot":3}')])).toEqual([
      { id: "toolu_01", name: "read_frame", input: { shot: 3 } }
    ]);
  });

  it.each([
    ["empty", ""],
    ["missing", undefined]
  ])("reads %s arguments as {}", (_label, args) => {
    expect(readToolCalls([call(args)])[0]?.input).toEqual({});
  });

  it("keeps arguments that are already parsed", () => {
    expect(readToolCalls([call({ shot: 4 })])[0]?.input).toEqual({ shot: 4 });
  });

  it("throws ToolArgumentsError with the raw text when the arguments are not JSON", () => {
    const error = thrownBy(() => readToolCalls([call("{shot: 3")]));
    expect(error).toBeInstanceOf(ToolArgumentsError);
    expect(error).toMatchObject({
      toolName: "read_frame",
      raw: "{shot: 3",
      message:
        '[ai] Tool call "read_frame" has arguments that are not JSON.\n  The model sent: {shot: 3.'
    });
  });

  it("refuses a call without an id or a function name", () => {
    expect(() => readToolCalls([{ type: "function", function: { name: "t" } }])).toThrow(
      "[ai] fal returned an incomplete tool call."
    );
    expect(() => readToolCalls([{ id: "c", type: "function" }])).toThrow(
      "[ai] fal returned an incomplete tool call."
    );
  });
});

describe("finishReasonOf", () => {
  it.each([
    ["stop", "stop"],
    ["tool_calls", "tool_calls"],
    ["length", "length"],
    ["content_filter", "other"],
    [undefined, "other"]
  ])("%s → %s", (sent, read) => {
    expect(finishReasonOf(sent)).toBe(read);
  });
});

describe("usageOf", () => {
  it("reads prompt, completion, cached and cache-write tokens", () => {
    expect(
      usageOf({
        prompt_tokens: 2400,
        completion_tokens: 120,
        prompt_tokens_details: { cached_tokens: 1800, cache_write_tokens: 7 },
        cache_creation_input_tokens: 300
      })
    ).toEqual({
      promptTokens: 2400,
      completionTokens: 120,
      cachedTokens: 1800,
      cacheWriteTokens: 300
    });
  });

  it("takes cache writes from prompt_tokens_details without cache_creation_input_tokens", () => {
    expect(usageOf({ prompt_tokens_details: { cache_write_tokens: 7 } }).cacheWriteTokens).toBe(7);
  });

  it("reads 0 for every count fal does not report", () => {
    expect(usageOf(undefined)).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0
    });
  });
});

describe("inputTextOf", () => {
  it("joins system and prompt as before without messages", () => {
    expect(inputTextOf({ system: "ab", prompt: "cd" })).toBe("abcd");
    expect(inputTextOf({ prompt: "cd" })).toBe("cd");
  });

  it("takes system, text parts, assistant text and tool-call arguments, one per line", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "Check shot 3." }, STILL] },
      {
        role: "assistant",
        content: "Reading.",
        toolCalls: [{ id: "c", name: "read_frame", input: { shot: 3 } }]
      },
      // eslint-disable-next-line unicorn/no-null -- a tool-only assistant turn has null content by contract
      { role: "assistant", content: null },
      { role: "tool", toolCallId: "c", content: "Cut at the chin." }
    ];
    expect(inputTextOf({ prompt: "ignored", system: "Review.", messages })).toBe(
      'Review.\nCheck shot 3.\nReading.\n{"shot":3}\nCut at the chin.'
    );
    expect(inputTextOf({ prompt: "", messages: [{ role: "user", content: "hi" }] })).toBe("hi");
  });
});

describe("promptTextOf", () => {
  it("is the prompt without messages", () => {
    expect(promptTextOf({ prompt: "p" })).toBe("p");
  });

  it("is the text of the last user or tool message with messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Check shot 3." },
      {
        role: "tool",
        toolCallId: "c",
        content: [{ type: "text", text: "a" }, STILL, { type: "text", text: "b" }]
      },
      { role: "assistant", content: "Done." }
    ];
    expect(promptTextOf({ prompt: "", messages })).toBe("a\nb");
  });

  it("is empty when no user or tool message exists", () => {
    expect(promptTextOf({ prompt: "", messages: [{ role: "assistant", content: "x" }] })).toBe("");
  });
});
