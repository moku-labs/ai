/**
 * @file runToolLoop — the conversation history: the messages each step adds,
 * the answers to calls a stop leaves open, and the image trim of a request.
 */
import path from "node:path";
import type { ChatMessage, ContentPart, PromptGenResult, ToolCall } from "../contract";

/** The tool-message text sent when a tool returns no content. */
const NO_OUTPUT = "(no output)";

/** How many characters of a tool result a `tool` event quotes. */
const SUMMARY_LENGTH = 200;

/** A tool message: the answer to one tool call. */
type ToolMessage = Extract<ChatMessage, { role: "tool" }>;

/**
 * A model turn without text: the contract's `content: null` and `finalText: null`.
 *
 * @example
 * ```ts
 * textOrNull("") === NO_TEXT; // => true
 * ```
 */
// eslint-disable-next-line unicorn/no-null -- ChatMessage.content and RunToolLoopResult.finalText are `string | null` in the contract
export const NO_TEXT = null;

/**
 * The model text as the loop keeps it: `null` when the model sent none.
 *
 * @param text - The text of a model answer.
 * @returns The text, or `null` when it is empty.
 * @example
 * ```ts
 * textOrNull(""); // null
 * ```
 */
export function textOrNull(text: string): string | null {
  return text === "" ? NO_TEXT : text;
}

/**
 * The assistant message of one model answer: its text and, when it made
 * any, its tool calls.
 *
 * @param result - The model answer.
 * @returns The assistant message.
 * @example
 * ```ts
 * assistantMessage({ text: "Done.", toolCalls: [], costUsd: 0, finishReason: "stop", usage }); // { role: "assistant", content: "Done." }
 * ```
 */
export function assistantMessage(result: PromptGenResult): ChatMessage {
  const content = textOrNull(result.text);
  if (result.toolCalls.length === 0) return { role: "assistant", content };
  return { role: "assistant", content, toolCalls: [...result.toolCalls] };
}

/**
 * The tool message that answers a call; empty content becomes `"(no output)"`.
 *
 * @param toolCallId - Id of the answered call.
 * @param content - The tool result content.
 * @returns The tool message.
 * @example
 * ```ts
 * toolMessage("c1", []); // { role: "tool", toolCallId: "c1", content: "(no output)" }
 * ```
 */
export function toolMessage(toolCallId: string, content: ContentPart[]): ChatMessage {
  if (content.length === 0) return { role: "tool", toolCallId, content: NO_OUTPUT };
  return { role: "tool", toolCallId, content: [...content] };
}

/**
 * The summary a `tool` event carries: the first text part, cut to 200 characters.
 *
 * @param content - The tool result content.
 * @returns The summary; `""` when the content has no text part.
 * @example
 * ```ts
 * summaryOf([{ type: "text", text: "Subject is cut at the chin." }]); // "Subject is cut at the chin."
 * ```
 */
export function summaryOf(content: ContentPart[]): string {
  const firstText = content.find(part => part.type === "text");
  return firstText?.type === "text" ? firstText.text.slice(0, SUMMARY_LENGTH) : "";
}

/**
 * Tells whether the history already has a user message with exactly this text.
 *
 * @param messages - The history.
 * @param text - The user text to look for.
 * @returns True when a user message's content equals `text`.
 * @example
 * ```ts
 * hasUserText([{ role: "user", content: "Wrap up." }], "Wrap up."); // true
 * ```
 */
function hasUserText(messages: readonly ChatMessage[], text: string): boolean {
  return messages.some(message => message.role === "user" && message.content === text);
}

/**
 * The history with the finish note as its last user message, unless no note
 * is set or a user message already has exactly its text.
 *
 * @param messages - The history.
 * @param note - The finish note, if the caller set one.
 * @returns A new array.
 * @example
 * ```ts
 * withFinishNote([{ role: "user", content: "Check shot 3." }], "Wrap up."); // [{ role: "user", content: "Check shot 3." }, { role: "user", content: "Wrap up." }]
 * ```
 */
export function withFinishNote(
  messages: readonly ChatMessage[],
  note: string | undefined
): ChatMessage[] {
  if (note === undefined || hasUserText(messages, note)) return [...messages];
  return [...messages, { role: "user", content: note }];
}

/**
 * The tool calls of the last assistant message that no tool message answers yet.
 *
 * @param messages - The history.
 * @returns The open calls, in call order; `[]` when there is none.
 * @example
 * ```ts
 * openCalls([{ role: "assistant", content: null, toolCalls: [{ id: "c1", name: "ask", input: {} }] }]); // [{ id: "c1", ... }]
 * ```
 */
function openCalls(messages: readonly ChatMessage[]): ToolCall[] {
  const lastAssistantIndex = messages.findLastIndex(message => message.role === "assistant");
  const lastAssistant = messages[lastAssistantIndex];
  if (lastAssistant?.role !== "assistant") return [];

  // A call is answered by a tool message after its assistant message.
  const answered = new Set(
    messages
      .slice(lastAssistantIndex + 1)
      .flatMap(message => (message.role === "tool" ? [message.toolCallId] : []))
  );
  return (lastAssistant.toolCalls ?? []).filter(call => !answered.has(call.id));
}

/**
 * The answers to the calls a stop leaves open, so the history stays a valid
 * one to resume from: each open call gets `Not run: <reason>.`.
 *
 * @param messages - The history.
 * @param reason - Why the loop stopped.
 * @returns One tool message per open call; `[]` when none is open.
 * @example
 * ```ts
 * notRunAnswers([{ role: "assistant", content: null, toolCalls: [{ id: "c1", name: "render_shot", input: {} }] }], "budget"); // [{ role: "tool", toolCallId: "c1", content: "Not run: budget." }]
 * ```
 */
export function notRunAnswers(messages: readonly ChatMessage[], reason: string): ChatMessage[] {
  return openCalls(messages).map(call => ({
    role: "tool",
    toolCallId: call.id,
    content: `Not run: ${reason}.`
  }));
}

/**
 * Index of the oldest assistant message whose tool results keep their images:
 * the `keep`-th assistant message from the end. Tool messages before it lose them.
 *
 * @param messages - The history.
 * @param keep - How many of the last assistant turns keep their images.
 * @returns The first index that keeps images.
 * @example
 * ```ts
 * keptImagesFrom([{ role: "assistant", content: "a" }, { role: "assistant", content: "b" }], 1); // 1
 * ```
 */
function keptImagesFrom(messages: readonly ChatMessage[], keep: number): number {
  if (keep <= 0) return messages.length;

  const assistantIndexes = messages.flatMap((message, index) =>
    message.role === "assistant" ? [index] : []
  );
  return assistantIndexes.at(-keep) ?? 0;
}

/**
 * The tool message with each image part replaced by its `[image dropped: <name>]` text.
 *
 * @param message - A tool message.
 * @returns A copy without image parts; a text-only message as is.
 * @example
 * ```ts
 * withoutImages({ role: "tool", toolCallId: "c1", content: [{ type: "image", path: "f/a.png", mimeType: "image/png", hash: "h" }] }); // content: [{ type: "text", text: "[image dropped: a.png]" }]
 * ```
 */
function withoutImages(message: ToolMessage): ToolMessage {
  if (typeof message.content === "string") return message;

  const content = message.content.map(
    (part): ContentPart =>
      part.type === "image"
        ? { type: "text", text: `[image dropped: ${path.basename(part.path)}]` }
        : part
  );
  return { ...message, content };
}

/**
 * The history for the next request: tool-result images of assistant turns
 * older than the last `keep` ones become text, so the context stops growing.
 * The history itself is not changed.
 *
 * @param messages - The history.
 * @param keep - How many of the last assistant turns keep their tool-result images.
 * @returns A new array; changed tool messages are copies.
 * @example
 * ```ts
 * withoutOldImages(history, 2); // tool images of the third-last assistant turn and older are "[image dropped: <name>]"
 * ```
 */
export function withoutOldImages(messages: readonly ChatMessage[], keep: number): ChatMessage[] {
  const keptFrom = keptImagesFrom(messages, keep);
  return messages.map((message, index) =>
    index < keptFrom && message.role === "tool" ? withoutImages(message) : message
  );
}
