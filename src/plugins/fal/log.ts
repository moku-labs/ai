/**
 * @file fal request log — one opt-in JSONL line per billable request, every
 * task: `{ at, task, model, endpoint, requestId | error, prompt, body }`. The
 * body drops the prompt-bearing field (`prompt`, or the chat `messages`), cuts
 * every string (URLs to host + last segment, data URIs to MIME + length) and
 * names ref URLs by their files. Never the key or a header. A failed write
 * warns once per plugin instance and never fails the request.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { readField, redacted } from "./client/http";
import type { FalContext, FalTask, LocalFile } from "./types";

/**
 * What a handler knows about one billable request.
 *
 * @example
 * ```ts
 * const entry: RequestLogEntry = { task: "music", model: "stable-audio-2.5", endpoint: "fal-ai/stable-audio-25/text-to-audio", prompt: "rain", body: { prompt: "rain", seconds_total: 30 }, files: [] };
 * ```
 */
export type RequestLogEntry = {
  /** The fal task. */
  task: FalTask;
  /** Model alias or id. */
  model: string;
  /** fal endpoint id (prompt-gen: the chat path). */
  endpoint: string;
  /** The prompt as sent. */
  prompt: string;
  /** The posted body. */
  body: Record<string, unknown>;
  /** The uploaded files, in the order their URLs appear in the body. */
  files: readonly LocalFile[];
};

/**
 * How one request ended: fal's request id, or the error it threw.
 *
 * @example
 * ```ts
 * const outcome: RequestOutcome = { requestId: "019a-req" };
 * ```
 */
export type RequestOutcome = { requestId: string } | { error: unknown };

/**
 * The file sink. A failed write warns once per plugin instance and never fails the request.
 *
 * @example
 * ```ts
 * const sink: RequestLog = { write: async () => undefined };
 * ```
 */
export type RequestLog = {
  /** Appends one line for `entry`; never throws. */
  write(entry: RequestLogEntry, outcome: RequestOutcome): Promise<void>;
};

/**
 * A JSON value as the log line carries it.
 */
type LoggedValue =
  | string
  | number
  | boolean
  | null
  | LoggedValue[]
  | { [key: string]: LoggedValue };

/** Log event for a write that failed. */
const WRITE_FAILED_EVENT = "fal:request-log:failed";

/** Body fields that carry the prompt; the line has the prompt once, on its own. */
const PROMPT_FIELDS: ReadonlySet<string> = new Set(["prompt", "messages"]);

/** Body field holding the ref URLs of an image request. */
const IMAGE_URLS = "image_urls";

/**
 * Cuts one string: an http(s) URL to host and last path segment (no query),
 * a data URI to MIME type and length; anything else is kept.
 *
 * @param text - A string from the posted body.
 * @returns The string as the log line carries it.
 * @example
 * ```ts
 * cutString("https://v3.fal.media/files/abc/x.png?sig=1"); // => "v3.fal.media/…/x.png"
 * cutString("data:image/png;base64,AAAA"); // => "data:image/png;26"
 * ```
 */
export function cutString(text: string): string {
  // A data URI: its MIME type and length, never the base64 bytes.
  if (text.startsWith("data:")) {
    const mime = text.slice("data:".length).split(/[;,]/)[0] ?? "";
    return `data:${mime};${text.length}`;
  }
  // Anything that is not a web URL is kept as is.
  const isWebUrl = /^https?:\/\//i.test(text) && URL.canParse(text);
  if (!isWebUrl) return text;

  // A web URL: host and last path segment; the query (it may carry a signature) is dropped.
  const url = new URL(text);
  const segments = url.pathname.split("/").filter(segment => segment !== "");
  const last = segments.at(-1);
  if (last === undefined) return url.host;
  return segments.length > 1 ? `${url.host}/…/${last}` : `${url.host}/${last}`;
}

/**
 * A body value as logged: strings cut, arrays and objects walked, anything
 * that is not JSON dropped.
 *
 * @param value - A value from the posted body.
 * @returns The logged value, or undefined to drop it.
 * @example
 * ```ts
 * loggedValue(["https://cdn.fal.test/a.png", 3]); // => ["cdn.fal.test/a.png", 3]
 * ```
 */
function loggedValue(value: unknown): LoggedValue | undefined {
  if (typeof value === "string") return cutString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  // eslint-disable-next-line unicorn/no-null -- JSON null is kept as JSON null
  if (value === null) return null;
  if (Array.isArray(value)) {
    // Items that are not JSON (functions, symbols) cannot come from a posted body: drop them.
    return value.map(item => loggedValue(item)).filter(item => item !== undefined);
  }
  if (typeof value !== "object") return undefined;

  const logged: Record<string, LoggedValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const itemValue = loggedValue(item);
    if (itemValue !== undefined) logged[key] = itemValue;
  }
  return logged;
}

/**
 * Ref URLs as logged: the file names when there is one URL per uploaded
 * file, else only their count.
 *
 * @param count - How many ref URLs the body carries.
 * @param files - The uploaded files.
 * @returns File names, or `{ count }`.
 * @example
 * ```ts
 * refNames(1, [{ path: "/s/face.png", mimeType: "image/png", hash: "h" }]); // => ["face.png"]
 * ```
 */
function refNames(count: number, files: readonly LocalFile[]): LoggedValue {
  if (count > 0 && count === files.length) return files.map(file => path.basename(file.path));
  return { count };
}

/**
 * How many `image_url` parts the chat messages carry.
 *
 * @param messages - The chat `messages` field.
 * @returns The number of image parts.
 * @example
 * ```ts
 * imagePartCount([{ role: "user", content: [{ type: "image_url", image_url: { url: "u" } }] }]); // => 1
 * ```
 */
function imagePartCount(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;

  let count = 0;
  for (const message of messages) {
    const content = readField(message, "content");
    if (!Array.isArray(content)) continue;
    count += content.filter(part => readField(part, "type") === "image_url").length;
  }
  return count;
}

/**
 * The body as logged: no prompt-bearing field, strings cut, ref URLs named.
 * A chat body's `image_url` parts are logged as `image_urls`.
 *
 * @param body - The posted body.
 * @param files - The uploaded files.
 * @returns The logged body.
 * @example
 * ```ts
 * loggedBody({ prompt: "p", num_images: 1 }, []); // => { num_images: 1 }
 * ```
 */
function loggedBody(
  body: Record<string, unknown>,
  files: readonly LocalFile[]
): Record<string, LoggedValue> {
  const logged: Record<string, LoggedValue> = {};
  for (const [key, value] of Object.entries(body)) {
    if (PROMPT_FIELDS.has(key)) continue;

    const isReferenceUrlList = key === IMAGE_URLS && Array.isArray(value);
    const item = isReferenceUrlList ? refNames(value.length, files) : loggedValue(value);
    if (item !== undefined) logged[key] = item;
  }

  // Chat images sit inside the dropped messages; keep their names.
  const imageParts = imagePartCount(body.messages);
  if (imageParts > 0) logged[IMAGE_URLS] = refNames(imageParts, files);
  return logged;
}

/**
 * The outcome as logged: fal's request id, or the redacted error class.
 *
 * @param outcome - How the request ended.
 * @returns The `requestId` or `error` field of the line.
 * @example
 * ```ts
 * outcomeField({ requestId: "r1" }); // => { requestId: "r1" }
 * ```
 */
function outcomeField(outcome: RequestOutcome): Record<string, LoggedValue> {
  if ("requestId" in outcome) return { requestId: outcome.requestId };
  return { error: loggedValue(redacted(outcome.error)) ?? {} };
}

/**
 * The JSONL line of one request.
 *
 * @param entry - The request.
 * @param outcome - How it ended.
 * @param at - When it was written.
 * @returns The line object.
 * @example
 * ```ts
 * requestLine({ task: "music", model: "m", endpoint: "e", prompt: "p", body: { prompt: "p" }, files: [] }, { requestId: "r" }, new Date(0)).at; // => "1970-01-01T00:00:00.000Z"
 * ```
 */
function requestLine(
  entry: RequestLogEntry,
  outcome: RequestOutcome,
  at: Date
): Record<string, LoggedValue> {
  return {
    at: at.toISOString(),
    task: entry.task,
    model: entry.model,
    endpoint: entry.endpoint,
    ...outcomeField(outcome),
    prompt: entry.prompt,
    body: loggedBody(entry.body, entry.files)
  };
}

/**
 * Opens the request log, or undefined when `config.requestLog` is `""` (off).
 * The path is relative to the working directory; its folders are created.
 * A failed write warns once per plugin instance (`state.requestLogWarned`).
 *
 * @param ctx - Plugin context (`config.requestLog`, `state.requestLogWarned`, log).
 * @returns The sink, or undefined when the log is off.
 */
export function createRequestLog(ctx: FalContext): RequestLog | undefined {
  const file = ctx.config.requestLog;
  if (file === "") return undefined;

  return {
    write: async (entry, outcome) => {
      try {
        await mkdir(path.dirname(file), { recursive: true });
        await appendFile(file, `${JSON.stringify(requestLine(entry, outcome, new Date()))}\n`);
      } catch (error) {
        // One warning per plugin instance: a broken path would repeat on every request.
        if (ctx.state.requestLogWarned) return;
        ctx.state.requestLogWarned = true;
        const reason = error instanceof Error ? error.message : "unknown error";
        ctx.log.warn(WRITE_FAILED_EVENT, { path: file, reason });
      }
    }
  };
}

/**
 * Sends one billable request and writes its log line: the request id after a
 * sent request, the error before a rejected one is rethrown. With the log off
 * it only sends.
 *
 * @param requestLog - The sink, or undefined when the log is off.
 * @param entry - The request.
 * @param send - Sends the request.
 * @param requestIdOf - Reads fal's request id off the result.
 * @returns What `send` returned.
 * @throws {Error} Whatever `send` threw, after the line is written.
 * @example
 * ```ts
 * await withRequestLog(undefined, entry, async () => 5, () => "r"); // => 5
 * ```
 */
export async function withRequestLog<T>(
  requestLog: RequestLog | undefined,
  entry: RequestLogEntry,
  send: () => Promise<T>,
  requestIdOf: (result: T) => string
): Promise<T> {
  if (requestLog === undefined) return send();

  let result: T;
  try {
    result = await send();
  } catch (error) {
    await requestLog.write(entry, { error });
    throw error;
  }
  await requestLog.write(entry, { requestId: requestIdOf(result) });
  return result;
}
