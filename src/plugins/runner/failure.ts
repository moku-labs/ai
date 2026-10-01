/**
 * @file runner failure — the `item:failed` record: the safe message it may
 * carry, and the one place that reports and logs a terminal failure. Only a
 * text the handler declared safe (`publicMessage`) or our own `[ai]` text is
 * passed on (neither carries keys or prompts); the message is never written
 * to the journal, which stays metadata only.
 */
import type { ErrorClass, ItemRow } from "../journal/types";
import { isProviderErrorHint } from "./retry";
import type { ItemFailure, RunnerContext, UnstampedRunEvent } from "./types";

/** Prefix of this framework's own error texts. */
const OWN_ERROR_PREFIX = "[ai]";

/** How many lines of an error message an `item:failed` record carries. */
const MAX_MESSAGE_LINES = 2;

/** The longest message an `item:failed` record carries, in characters. */
const MAX_MESSAGE_LENGTH = 300;

/**
 * The text a handler declared safe to show: the `publicMessage` of a thrown
 * object, when it is a non-empty string.
 *
 * @param error - The thrown value.
 * @returns The public message, or undefined.
 */
function publicMessageOf(error: unknown): string | undefined {
  if (!isProviderErrorHint(error)) return undefined;

  const { publicMessage } = error;
  const isShowable = typeof publicMessage === "string" && publicMessage !== "";
  return isShowable ? publicMessage : undefined;
}

/**
 * Our own error text: the message of an `Error` that starts with `[ai]`.
 *
 * @param error - The thrown value.
 * @returns The `[ai]` message, or undefined.
 */
function ownErrorMessageOf(error: unknown): string | undefined {
  const isOwnError = error instanceof Error && error.message.startsWith(OWN_ERROR_PREFIX);
  return isOwnError ? error.message : undefined;
}

/**
 * The message an `item:failed` record may carry: the first two lines, cut at
 * 300 characters, of the error's `publicMessage` when it is a non-empty
 * string (the handler declares it safe), else of an `Error` message that
 * starts with `[ai]`. Any other error (a provider's raw text, a thrown
 * string) gives no message, so no key or prompt reaches the stream.
 *
 * @param error - The thrown value, from a `catch` clause or a failed job poll.
 * @returns The safe message, or undefined.
 * @example
 * ```ts
 * failureMessageOf({ publicMessage: "[studio] ffmpeg failed.\n  Check the clips.\n  more" });
 * // => "[studio] ffmpeg failed.\n  Check the clips."
 * failureMessageOf(new Error("[ai] fal rejected the image.")); // => "[ai] fal rejected the image."
 * failureMessageOf(new Error("401 Unauthorized")); // => undefined
 * ```
 */
export function failureMessageOf(error: unknown): string | undefined {
  const text = publicMessageOf(error) ?? ownErrorMessageOf(error);
  if (text === undefined) return undefined;

  const firstLines = text.split("\n").slice(0, MAX_MESSAGE_LINES).join("\n");
  return firstLines.slice(0, MAX_MESSAGE_LENGTH);
}

/**
 * Builds an {@link ItemFailure}, with the `message` key only when there is a
 * message (`exactOptionalPropertyTypes`: an absent key, never `undefined`).
 *
 * @param errorClass - The failure's error class.
 * @param message - The safe message from {@link failureMessageOf}, if any.
 * @returns The failure.
 * @example
 * ```ts
 * itemFailureOf("http-4xx", "[ai] ark rejected the request."); // => { errorClass: "http-4xx", message: "[ai] ark rejected the request." }
 * itemFailureOf("http-4xx", undefined); // => { errorClass: "http-4xx" }
 * ```
 */
export function itemFailureOf(errorClass: ErrorClass, message: string | undefined): ItemFailure {
  return message === undefined ? { errorClass } : { errorClass, message };
}

/**
 * Reports an item's terminal failure: logs `runner:item:failed`
 * (`{ itemId, errorClass, message }`, message only when present) and reports
 * the `item:failed` record with the item's label and the same message.
 *
 * @param ctx - Runner domain context.
 * @param item - The failed item.
 * @param failure - Its error class and optional message.
 * @param report - Stream callback.
 */
export function reportItemFailed(
  ctx: RunnerContext,
  item: ItemRow,
  failure: ItemFailure,
  report: (event: UnstampedRunEvent) => void
): void {
  const { errorClass, message } = failure;
  const detail = message === undefined ? {} : { message };

  ctx.log.warn("runner:item:failed", { itemId: item.id, errorClass, ...detail });
  report({ type: "item:failed", itemId: item.id, label: item.label, errorClass, ...detail });
}
