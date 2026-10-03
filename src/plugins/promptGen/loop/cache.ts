/**
 * @file runToolLoop — the prompt cache of a request: the breakpoints a cache
 * mode sets on the request messages, within the provider's limit. The marks
 * are a function of the history and the options only, never of loop state,
 * so a resumed run builds the same request for the same step.
 */
import type { ChatMessage, ContentPart } from "../contract";
import { withoutOldImages } from "./history";
import type { RunToolLoopOptions } from "./types";

/**
 * Most cache breakpoints one request may carry. This is the Anthropic limit;
 * the system mark, the caller's marks and the loop's rolling marks share it.
 *
 * @example
 * ```ts
 * MAX_BREAKPOINTS; // 4: the system mark, one caller mark and two rolling marks fit
 * ```
 */
export const MAX_BREAKPOINTS = 4;

/** Breakpoints the system mark takes. */
const SYSTEM_BREAKPOINTS = 1;

/** What a search returns when nothing matches, as `findLastIndex` does. */
const NOT_FOUND = -1;

/**
 * What the loop marks for the prompt cache: the system text and the
 * conversation, the system text only, or nothing.
 *
 * @example
 * ```ts
 * const mode: LoopCacheMode = "conversation";
 * ```
 */
export type LoopCacheMode = NonNullable<RunToolLoopOptions["cache"]>;

/**
 * What decides the cache marks of every request of one run. All of it comes
 * from the options, so the marks never depend on loop state.
 *
 * @example
 * ```ts
 * // One user message given, maxSteps 30: a request carries at most 29 assistant messages.
 * const plan: CachePlan = { mode: "conversation", keepImages: 2, maxAssistants: 29 };
 * ```
 */
export type CachePlan = {
  /** What the loop marks. */
  mode: LoopCacheMode;
  /** Assistant turns whose tool-result images stay in the request. */
  keepImages: number;
  /** Most assistant messages a request of this run carries: those of the given messages, plus `maxSteps - 1`. */
  maxAssistants: number;
};

/**
 * The request fields the cache mode decides.
 *
 * @example
 * ```ts
 * const fields: CachedRequest = {
 *   messages: [{ role: "user", content: [{ type: "text", text: "Check shot 3.", cache: true }] }],
 *   cacheSystem: true
 * };
 * ```
 */
export type CachedRequest = {
  /** The request messages: old tool images dropped, the loop's marks set on copies. */
  messages: ChatMessage[];
  /** Whether the request marks the system text. */
  cacheSystem: boolean;
};

/**
 * Tells whether a mark can go on a part: a text part with non-blank text.
 *
 * @param part - A content part.
 * @returns True for a text part whose text is not blank.
 * @example
 * ```ts
 * hasText({ type: "text", text: "  " }); // false
 * ```
 */
function hasText(part: ContentPart): boolean {
  return part.type === "text" && part.text.trim() !== "";
}

/**
 * Tells whether a part carries a cache mark.
 *
 * @param part - A content part.
 * @returns True for a text part with `cache: true`.
 * @example
 * ```ts
 * isMarked({ type: "text", text: "Shot list.", cache: true }); // true
 * ```
 */
function isMarked(part: ContentPart): boolean {
  return part.type === "text" && part.cache === true;
}

/**
 * The parts of a message as the marks see them: a string content is one text
 * part, and an assistant message has none, so it is never marked.
 *
 * @param message - A request message.
 * @returns Its parts; `[]` for an assistant message.
 * @example
 * ```ts
 * partsOf({ role: "user", content: "Check shot 3." }); // [{ type: "text", text: "Check shot 3." }]
 * ```
 */
function partsOf(message: ChatMessage): ContentPart[] {
  if (message.role === "assistant") return [];
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  return message.content;
}

/**
 * Index of the part of a message a mark goes on: its last text part with
 * non-blank text, also when image parts follow it.
 *
 * @param message - A request message.
 * @returns The part index; -1 when the message cannot be marked.
 * @example
 * ```ts
 * targetPart({ role: "user", content: [{ type: "text", text: "Look." }, { type: "text", text: " " }] }); // 0
 * ```
 */
function targetPart(message: ChatMessage): number {
  return partsOf(message).findLastIndex(part => hasText(part));
}

/**
 * Tells whether the caller already marked the part a mark on this message
 * would go on.
 *
 * @param message - A request message.
 * @returns True when its target part has `cache: true`.
 * @example
 * ```ts
 * hasMarkedTarget({ role: "user", content: [{ type: "text", text: "Shot list.", cache: true }] }); // true
 * ```
 */
function hasMarkedTarget(message: ChatMessage): boolean {
  const target = targetPart(message);
  return partsOf(message).some((part, index) => index === target && isMarked(part));
}

/**
 * A copy of a message with a cache mark on its target part. A string content
 * becomes one marked text part.
 *
 * @param message - A user or tool message with non-blank text.
 * @returns The marked copy; an assistant message, which has no parts, as is.
 * @example
 * ```ts
 * withMark({ role: "user", content: "Check shot 3." }); // { role: "user", content: [{ type: "text", text: "Check shot 3.", cache: true }] }
 * ```
 */
function withMark(message: ChatMessage): ChatMessage {
  if (message.role === "assistant") return message;

  const target = targetPart(message);
  const content = partsOf(message).map((part, index): ContentPart => {
    const isTarget = index === target && part.type === "text";
    return isTarget ? { ...part, cache: true } : part;
  });
  return { ...message, content };
}

/**
 * Counts the cache marks the request messages already carry: the caller's.
 *
 * @param messages - The request messages, before the loop marks any.
 * @returns The number of parts with `cache: true`.
 * @example
 * ```ts
 * countMarks([{ role: "user", content: [{ type: "text", text: "Shot list.", cache: true }] }]); // 1
 * ```
 */
function countMarks(messages: readonly ChatMessage[]): number {
  const parts = messages.flatMap(message => partsOf(message));
  return parts.filter(part => isMarked(part)).length;
}

/**
 * Tells whether a request message can still change in this run: a tool
 * message that still has an image, from an assistant turn old enough to leave
 * the kept turns before the run ends. With `keepImages: Infinity` none can.
 *
 * @param message - A message of the trimmed request.
 * @param assistantsBefore - How many assistant messages come before it.
 * @param plan - The run's cache plan.
 * @returns True when a later request of this run sends it without its images.
 * @example
 * ```ts
 * // maxSteps 10, keepImages 2: the first turn's frame is dropped by the fourth request.
 * canLoseImages({ role: "tool", toolCallId: "c1", content: [{ type: "image", path: "f1.png", mimeType: "image/png", hash: "h1" }] }, 1, { mode: "conversation", keepImages: 2, maxAssistants: 9 }); // true
 * ```
 */
function canLoseImages(message: ChatMessage, assistantsBefore: number, plan: CachePlan): boolean {
  const hasToolImage =
    message.role === "tool" && partsOf(message).some(part => part.type === "image");
  const leavesKeptTurns = assistantsBefore <= plan.maxAssistants - plan.keepImages;
  return hasToolImage && leavesKeptTurns;
}

/**
 * How many leading messages of a trimmed request are stable: every message
 * before the first one that can still lose its images.
 *
 * @param trimmed - The request messages, old tool images dropped.
 * @param plan - The run's cache plan.
 * @returns Index of the first message that can still change, or the length.
 * @example
 * ```ts
 * stableLength([{ role: "user", content: "Check shot 3." }], { mode: "conversation", keepImages: 2, maxAssistants: 9 }); // 1
 * ```
 */
function stableLength(trimmed: readonly ChatMessage[], plan: CachePlan): number {
  let assistantsBefore = 0;
  for (const [index, message] of trimmed.entries()) {
    if (canLoseImages(message, assistantsBefore, plan)) return index;
    if (message.role === "assistant") assistantsBefore += 1;
  }
  return trimmed.length;
}

/**
 * The mark of the request a history becomes: the newest stable user or tool
 * message with non-blank text. Assistant messages are never marked.
 *
 * @param history - A history.
 * @param plan - The run's cache plan.
 * @returns Index of the message; -1 when no stable message can be marked.
 * @example
 * ```ts
 * markTarget([{ role: "user", content: "Check shot 3." }, { role: "assistant", content: "Fine." }], { mode: "conversation", keepImages: 2, maxAssistants: 9 }); // 0
 * ```
 */
function markTarget(history: readonly ChatMessage[], plan: CachePlan): number {
  const trimmed = withoutOldImages(history, plan.keepImages);
  const stable = trimmed.slice(0, stableLength(trimmed, plan));
  return stable.findLastIndex(message => targetPart(message) !== NOT_FOUND);
}

/**
 * The loop's two rolling marks of a request: the mark of the request before,
 * then the mark of this one. The request before was built from the history
 * cut before its last assistant message; marking the same place again lets
 * the provider read the entry that request wrote, however many parts the
 * newest turn added.
 *
 * @param history - The history of this request.
 * @param plan - The run's cache plan.
 * @returns Indexes of the marked messages; one may repeat, and `[]` when nothing can be marked.
 * @example
 * ```ts
 * // The request before ended at the first user message; this one ends at the second.
 * rollingTargets([{ role: "user", content: "Check shot 3." }, { role: "assistant", content: "Fine." }, { role: "user", content: "And shot 4?" }], { mode: "conversation", keepImages: 2, maxAssistants: 9 }); // [0, 2]
 * ```
 */
function rollingTargets(history: readonly ChatMessage[], plan: CachePlan): number[] {
  const lastAssistant = history.findLastIndex(message => message.role === "assistant");
  const historyBefore = lastAssistant === NOT_FOUND ? [] : history.slice(0, lastAssistant);

  const targets = [markTarget(historyBefore, plan), markTarget(history, plan)];
  return targets.filter(target => target !== NOT_FOUND);
}

/**
 * The messages the loop may mark in a request, oldest first: its rolling
 * targets, each once, without those the caller already marked. Such a target
 * takes no slot of the limit.
 *
 * @param trimmed - The request messages, old tool images dropped.
 * @param history - The history they come from.
 * @param plan - The run's cache plan.
 * @returns Indexes of the messages, in message order.
 * @example
 * ```ts
 * // The caller marked the newest message itself: only the mark of the request before is left.
 * const history: ChatMessage[] = [{ role: "user", content: "Check shot 3." }, { role: "assistant", content: "Fine." }, { role: "user", content: [{ type: "text", text: "And shot 4?", cache: true }] }];
 * unmarkedTargets(history, history, { mode: "conversation", keepImages: 2, maxAssistants: 9 }); // [0]
 * ```
 */
function unmarkedTargets(
  trimmed: readonly ChatMessage[],
  history: readonly ChatMessage[],
  plan: CachePlan
): number[] {
  const targets = new Set(rollingTargets(history, plan));
  return trimmed.flatMap((message, index) => {
    const takesSlot = targets.has(index) && !hasMarkedTarget(message);
    return takesSlot ? [index] : [];
  });
}

/**
 * The newest items of a list that fit a number of slots.
 *
 * @param items - The items, oldest first.
 * @param slots - How many may stay; zero or less keeps none.
 * @returns The last `slots` items.
 * @example
 * ```ts
 * newest([2, 4], 1); // [4]
 * ```
 */
function newest<T>(items: readonly T[], slots: number): T[] {
  return slots > 0 ? items.slice(-slots) : [];
}

/**
 * The request fields the cache mode decides: the messages to send and
 * whether the system text is marked. Every mode sends the history without
 * its old tool images. `"off"` marks nothing, `"system"` marks the system
 * text, and `"conversation"` also sets two rolling marks: on the newest
 * stable message of this request and of the request before. A request
 * carries at most {@link MAX_BREAKPOINTS} breakpoints: the caller's marks are
 * never removed, the oldest rolling mark is dropped first, and with four or
 * more caller marks the system text is not marked either. The marks go on
 * copies, so the history never carries them; the result depends on the
 * arguments only.
 *
 * @param history - The history of the request.
 * @param plan - The run's cache plan.
 * @returns The request messages and the system mark.
 * @example
 * ```ts
 * cachedRequest([{ role: "user", content: "Check shot 3." }], { mode: "conversation", keepImages: 2, maxAssistants: 9 });
 * // { messages: [{ role: "user", content: [{ type: "text", text: "Check shot 3.", cache: true }] }], cacheSystem: true }
 * ```
 */
export function cachedRequest(history: readonly ChatMessage[], plan: CachePlan): CachedRequest {
  // Every mode sends the history without its old tool images.
  const trimmed = withoutOldImages(history, plan.keepImages);
  if (plan.mode === "off") return { messages: trimmed, cacheSystem: false };
  if (plan.mode === "system") return { messages: trimmed, cacheSystem: true };

  // The caller's marks keep their slots; the newest rolling marks take what the system mark leaves.
  const callerMarks = countMarks(trimmed);
  const freeSlots = MAX_BREAKPOINTS - SYSTEM_BREAKPOINTS - callerMarks;
  const marks = new Set(newest(unmarkedTargets(trimmed, history, plan), freeSlots));

  // The marks go on copies, so the history never carries them.
  const messages = trimmed.map((message, index) =>
    marks.has(index) ? withMark(message) : message
  );
  return { messages, cacheSystem: callerMarks < MAX_BREAKPOINTS };
}
