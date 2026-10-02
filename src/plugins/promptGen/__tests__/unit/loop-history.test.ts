/**
 * @file runToolLoop — unit tests of the pure history and tool helpers.
 */
/* eslint-disable unicorn/no-null -- ChatMessage.content is `string | null` in the contract */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ChatMessage, ContentPart } from "../../contract";
import {
  assistantMessage,
  notRunAnswers,
  summaryOf,
  toolMessage,
  withFinishNote,
  withoutOldImages
} from "../../loop/history";
import { planCall, toolDefinitions } from "../../loop/tools";
import type { ToolSpec } from "../../loop/types";

const IMAGE: ContentPart = {
  type: "image",
  path: "renders/frames/s1.png",
  mimeType: "image/png",
  hash: "h1"
};

const readFrame: ToolSpec<{ shot: number }> = {
  name: "read_frame",
  description: "Return one frame.",
  schema: z.object({ shot: z.number() }),
  run: async () => ({ value: 1, content: [], costUsd: 0 })
};

describe("withoutOldImages", () => {
  const history: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "Look." }, IMAGE] },
    { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "read_frame", input: {} }] },
    { role: "tool", toolCallId: "c1", content: [IMAGE] },
    { role: "assistant", content: null, toolCalls: [{ id: "c2", name: "read_frame", input: {} }] },
    { role: "tool", toolCallId: "c2", content: "plain text" }
  ];

  it("drops every tool image with keep 0 and leaves user images and text results alone", () => {
    const trimmed = withoutOldImages(history, 0);

    expect(trimmed[0]).toBe(history[0]);
    expect(trimmed[2]).toEqual({
      role: "tool",
      toolCallId: "c1",
      content: [{ type: "text", text: "[image dropped: s1.png]" }]
    });
    expect(trimmed[4]).toBe(history[4]);
    expect(history[2]).toEqual({ role: "tool", toolCallId: "c1", content: [IMAGE] });
  });

  it("keeps everything when the history has fewer assistant turns than kept", () => {
    expect(withoutOldImages(history, 5)).toEqual(history);
  });

  it("returns a new array", () => {
    expect(withoutOldImages(history, 2)).not.toBe(history);
  });
});

describe("notRunAnswers", () => {
  it("answers only the open calls of the last assistant message", () => {
    const history: ChatMessage[] = [
      { role: "assistant", content: null, toolCalls: [{ id: "old", name: "x", input: {} }] },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          { id: "c1", name: "read_frame", input: {} },
          { id: "c2", name: "read_frame", input: {} }
        ]
      },
      { role: "tool", toolCallId: "c1", content: "done" }
    ];

    expect(notRunAnswers(history, "cancel")).toEqual([
      { role: "tool", toolCallId: "c2", content: "Not run: cancel." }
    ]);
  });

  it("answers nothing without an assistant message or without tool calls", () => {
    expect(notRunAnswers([{ role: "user", content: "Hi." }], "steps")).toEqual([]);
    expect(notRunAnswers([{ role: "assistant", content: "Done." }], "steps")).toEqual([]);
  });
});

describe("message helpers", () => {
  it("builds an assistant message with tool calls only when there are some", () => {
    const usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
    const calls = [{ id: "c1", name: "read_frame", input: { shot: 3 } }];

    expect(
      assistantMessage({
        text: "",
        costUsd: 0,
        toolCalls: calls,
        finishReason: "tool_calls",
        usage
      })
    ).toEqual({ role: "assistant", content: null, toolCalls: calls });
    expect(
      assistantMessage({ text: "Done.", costUsd: 0, toolCalls: [], finishReason: "stop", usage })
    ).toEqual({ role: "assistant", content: "Done." });
  });

  it("copies tool content and summarizes its first text part", () => {
    const content: ContentPart[] = [IMAGE, { type: "text", text: "Frame." }];
    const message = toolMessage("c1", content);

    expect(message.content).toEqual(content);
    expect(message.content).not.toBe(content);
    expect(summaryOf(content)).toBe("Frame.");
    expect(summaryOf([IMAGE])).toBe("");
  });

  it("adds the finish note unless a user message has exactly its text", () => {
    const history: ChatMessage[] = [
      { role: "assistant", content: "Wrap up." },
      { role: "user", content: [{ type: "text", text: "Wrap up." }] }
    ];
    const noted = withFinishNote(history, "Wrap up.");

    expect(noted).toEqual([...history, { role: "user", content: "Wrap up." }]);
    expect(withFinishNote(noted, "Wrap up.")).toEqual(noted);
    expect(withFinishNote(history, undefined)).toEqual(history);
    expect(withFinishNote(history, undefined)).not.toBe(history);
  });
});

describe("tool helpers", () => {
  it("defines each tool by its input JSON schema without $schema", () => {
    expect(toolDefinitions([readFrame])).toEqual([
      {
        name: "read_frame",
        description: "Return one frame.",
        inputSchema: {
          type: "object",
          properties: { shot: { type: "number" } },
          required: ["shot"]
        }
      }
    ]);
  });

  it("plans a run with the parsed input", () => {
    const plan = planCall([readFrame], { id: "c1", name: "read_frame", input: { shot: 3 } });

    expect(plan).toEqual({ kind: "run", tool: readFrame, input: { shot: 3 } });
  });
});
