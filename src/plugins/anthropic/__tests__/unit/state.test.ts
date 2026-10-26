/**
 * @file anthropic state — the turn memory: keyed by the first tool_use id,
 * bounded at 500 turns with the oldest dropped.
 */
import { describe, expect, it } from "vitest";
import { createAnthropicState, MAX_REMEMBERED_TURNS, rememberTurn } from "../../state";
import type { AnthropicContentBlock } from "../../types";

/**
 * A tool turn's blocks: thinking, then one call.
 *
 * @param id - The tool_use id.
 * @returns The blocks.
 */
function toolTurn(id: string): AnthropicContentBlock[] {
  return [
    { type: "thinking", thinking: `About ${id}.`, signature: `sig-${id}` },
    { type: "tool_use", id, name: "read_frame", input: { shot: 3 } }
  ];
}

describe("anthropic state: turn memory", () => {
  it("gives every app its own turn memory", () => {
    const first = createAnthropicState();
    const second = createAnthropicState();

    rememberTurn(first.turns, toolTurn("toolu_01"));

    expect(first.turns.size).toBe(1);
    expect(second.turns.size).toBe(0);
  });

  it("keeps a turn's whole content under its first tool_use id", () => {
    const turns = new Map<string, AnthropicContentBlock[]>();
    const content: AnthropicContentBlock[] = [
      { type: "thinking", thinking: "Two frames.", signature: "sig" },
      { type: "text", text: "Reading both." },
      { type: "tool_use", id: "toolu_01", name: "read_frame", input: { shot: 3 } },
      { type: "tool_use", id: "toolu_02", name: "read_frame", input: { shot: 4 } }
    ];

    rememberTurn(turns, content);

    expect([...turns.keys()]).toEqual(["toolu_01"]);
    expect(turns.get("toolu_01")).toEqual(content);
  });

  it("keeps nothing for content without a tool_use block", () => {
    const turns = new Map<string, AnthropicContentBlock[]>();

    rememberTurn(turns, [{ type: "text", text: "Done." }]);

    expect(turns.size).toBe(0);
  });

  it("drops the oldest turn when a new one passes the cap", () => {
    const turns = new Map<string, AnthropicContentBlock[]>();
    for (let index = 0; index < MAX_REMEMBERED_TURNS; index += 1) {
      rememberTurn(turns, toolTurn(`toolu_${index}`));
    }

    rememberTurn(turns, toolTurn("toolu_new"));

    expect(turns.size).toBe(500);
    expect(turns.has("toolu_0")).toBe(false);
    expect(turns.has("toolu_1")).toBe(true);
    expect(turns.has("toolu_new")).toBe(true);
  });
});
