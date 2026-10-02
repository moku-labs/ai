import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PromptGenUnavailableError } from "../../../promptGen/contract";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "../../errors";
import { CHAT_PATH, DEFAULT_MAX_TOKENS, planChat, RETRY_BASE_MS } from "../../llm/chat";
import { createPromptGenHandler } from "../../llm/handler";
import type { LocalFile } from "../../types";
import type { TempFiles } from "./fixtures";
import {
  callsOf,
  createTempFiles,
  createTestCtx,
  jsonBodyOf,
  jsonResponse,
  storageUrlOf,
  stubFetch,
  stubStorageFetch,
  TEST_KEY
} from "./fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// fal prompt-gen chat: plan, sync POST, private retry, unavailable, answer.
// ─────────────────────────────────────────────────────────────────────────────

const OPUS = "anthropic/claude-opus-5.5";
const CHAT_URL = `https://fal.run/${CHAT_PATH}`;

let temp: TempFiles;
let still: LocalFile;

beforeAll(() => {
  temp = createTempFiles();
  still = temp.file("still.png", new Uint8Array([9, 9]), "image/png", "d".repeat(64));
});

afterAll(() => {
  temp.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A chat completions answer with one choice. */
function answer(content: string | null, extra: Record<string, unknown> = {}): Response {
  return jsonResponse(200, {
    id: "gen-1",
    provider: "Anthropic",
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0002 },
    ...extra
  });
}

/** Captures what a promise rejects with. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("planChat", () => {
  it("builds the minimal body: default model, medium reasoning, default max tokens", () => {
    expect(planChat(createTestCtx(), { prompt: "p" }).body).toEqual({
      model: OPUS,
      messages: [{ role: "user", content: "p" }],
      max_tokens: DEFAULT_MAX_TOKENS,
      reasoning: { effort: "medium" }
    });
    expect(DEFAULT_MAX_TOKENS).toBe(32_000);
  });

  it("puts the system message first, drops reasoning off and clamps the temperature", () => {
    const plan = planChat(createTestCtx(), {
      prompt: "p",
      system: "s",
      temperature: 3,
      params: { reasoning: "off", top_p: 0.5 }
    });
    expect(plan.body).toEqual({
      model: OPUS,
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "p" }
      ],
      max_tokens: DEFAULT_MAX_TOKENS,
      temperature: 2
    });
    expect(planChat(createTestCtx(), { prompt: "p", temperature: -1 }).body.temperature).toBe(0);
  });

  it("asks for a JSON schema answer, strict only on request", () => {
    const schema = { type: "object", properties: { n: { type: "number" } } };
    const strict = planChat(createTestCtx(), {
      prompt: "p",
      params: { responseSchema: schema, strictSchema: true }
    });
    expect(strict.body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "answer", schema, strict: true }
    });
    const loose = planChat(createTestCtx(), { prompt: "p", params: { responseSchema: schema } });
    expect(loose.body.response_format?.json_schema.strict).toBe(false);
  });

  it.each([
    [500, 500],
    [0, DEFAULT_MAX_TOKENS],
    [1.5, DEFAULT_MAX_TOKENS],
    ["9", DEFAULT_MAX_TOKENS]
  ])("max_tokens %j → %d", (asked, sent) => {
    expect(
      planChat(createTestCtx(), { prompt: "p", params: { max_tokens: asked } }).maxTokens
    ).toBe(sent);
  });

  it("maps model default and undefined to llmDefaultModel, any other id as is", () => {
    const ctx = createTestCtx({ config: { llmDefaultModel: "anthropic/claude-sonnet-5" } });
    expect(planChat(ctx, { prompt: "p" }).modelId).toBe("anthropic/claude-sonnet-5");
    expect(planChat(ctx, { prompt: "p", model: "default" }).modelId).toBe(
      "anthropic/claude-sonnet-5"
    );
    expect(planChat(ctx, { prompt: "p", model: "x-ai/grok-4.7" }).modelId).toBe("x-ai/grok-4.7");
  });

  it("takes one image or a list", () => {
    expect(planChat(createTestCtx(), { prompt: "p", params: { images: still } }).images).toEqual([
      still
    ]);
    expect(
      planChat(createTestCtx(), { prompt: "p", params: { images: [still, still] } }).images
    ).toHaveLength(2);
  });

  it.each([
    ["an empty prompt", { prompt: "  " }, "[ai] fal prompt-gen needs a non-empty prompt."],
    [
      "an unknown reasoning level",
      { prompt: "p", params: { reasoning: "max" } },
      'params.reasoning must be "off", "low", "medium" or "high"'
    ],
    [
      "a schema that is not an object",
      { prompt: "p", params: { responseSchema: [] } },
      "params.responseSchema must be a JSON schema object"
    ],
    [
      "an image that is not a local file",
      { prompt: "p", params: { images: [{ path: "x" }] } },
      "params.images must be local files"
    ],
    [
      "a model without a price",
      { prompt: "p", model: "meta/llama-9" },
      '[ai] No price for fal prompt-gen model "meta/llama-9".'
    ]
  ])("refuses %s as a terminal 400", (_label, request, message) => {
    let caught: unknown;
    try {
      planChat(createTestCtx(), request);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TerminalProviderError);
    expect(caught).toMatchObject({ status: 400, message: expect.stringContaining(message) });
  });
});

describe("old one-turn body (byte identity with 0.11.0)", () => {
  it("posts system + prompt + temperature + responseSchema byte for byte as before", async () => {
    const fetchMock = stubFetch(answer("ok"));

    await createPromptGenHandler(createTestCtx()).execute(
      {
        prompt: "Describe the shot.",
        system: "You are a director.",
        temperature: 0.7,
        params: {
          responseSchema: {
            type: "object",
            properties: { line: { type: "string" } },
            required: ["line"]
          },
          strictSchema: true
        }
      },
      {}
    );

    const [post] = callsOf(fetchMock);
    expect(String(post?.body)).toBe(
      '{"model":"anthropic/claude-opus-5.5","messages":[{"role":"system","content":"You are a director."},{"role":"user","content":"Describe the shot."}],"max_tokens":32000,"temperature":0.7,"reasoning":{"effort":"medium"},"response_format":{"type":"json_schema","json_schema":{"name":"answer","schema":{"type":"object","properties":{"line":{"type":"string"}},"required":["line"]},"strict":true}}}'
    );
  });

  it("posts a prompt with params.images byte for byte as before", async () => {
    const fetchMock = stubStorageFetch(answer("a still"));

    await createPromptGenHandler(createTestCtx()).execute(
      {
        prompt: "describe",
        system: "s",
        params: { images: [still], reasoning: "high", max_tokens: 500 }
      },
      {}
    );

    const post = callsOf(fetchMock).find(call => call.url === CHAT_URL);
    expect(String(post?.body)).toBe(
      '{"model":"anthropic/claude-opus-5.5","messages":[{"role":"system","content":"s"},{"role":"user","content":[{"type":"text","text":"describe"},{"type":"image_url","image_url":{"url":"https://cdn.fal.test/file/dddddddddddddddd.png"}}]}],"max_tokens":500,"reasoning":{"effort":"high"}}'
    );
  });
});

describe("execute", () => {
  it("POSTs to <runUrl>/<chat path> with the key and returns text, cost and meta", async () => {
    const fetchMock = stubFetch(answer("hello"));
    const ctx = createTestCtx();

    const result = await createPromptGenHandler(ctx).execute({ prompt: "p", system: "s" }, {});

    const [post] = callsOf(fetchMock);
    expect(post?.url).toBe(CHAT_URL);
    expect(post?.method).toBe("POST");
    expect(post?.headers.Authorization).toBe(`Key ${TEST_KEY}`);
    expect(jsonBodyOf(post).model).toBe(OPUS);
    expect(result).toEqual({
      text: "hello",
      costUsd: 0.0002,
      toolCalls: [],
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 0, cacheWriteTokens: 0 },
      meta: {
        modelId: OPUS,
        reasoning: "medium",
        provider: "Anthropic",
        finishReason: "stop",
        promptTokens: 10,
        completionTokens: 5,
        costSource: "usage",
        partial: false
      }
    });
    expect(ctx.log.info).toHaveBeenCalledWith("fal:llm:done", {
      model: OPUS,
      promptTokens: 10,
      completionTokens: 5,
      costSource: "usage"
    });
  });

  it("uploads params.images and sends them as image_url parts after the text", async () => {
    const fetchMock = stubStorageFetch(answer("a still"));

    await createPromptGenHandler(createTestCtx()).execute(
      { prompt: "describe", params: { images: [still] } },
      {}
    );

    const post = callsOf(fetchMock).find(call => call.url === CHAT_URL);
    expect(jsonBodyOf(post).messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image_url", image_url: { url: storageUrlOf(still) } }
        ]
      }
    ]);
  });

  it("retries a 5xx after RETRY_BASE_MS and logs fal:llm:retry", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(jsonResponse(500, {}), answer("ok"));
    const ctx = createTestCtx();

    const done = createPromptGenHandler(ctx).execute({ prompt: "p" }, {});
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    const result = await done;
    expect(result.text).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ctx.log.warn).toHaveBeenCalledWith("fal:llm:retry", {
      model: OPUS,
      attempt: 1,
      errorType: "retryable",
      status: 500
    });
  });

  it("waits RETRY_BASE_MS on a 5xx: the fal client reads Retry-After only on a 429", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(jsonResponse(503, {}, { "retry-after": "3" }), answer("ok"));

    const done = createPromptGenHandler(createTestCtx()).execute({ prompt: "p" }, {});
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);

    const result = await done;
    expect(result.text).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops after three attempts, doubling the backoff", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(
      jsonResponse(500, {}),
      jsonResponse(502, {}),
      jsonResponse(503, {})
    );
    const ctx = createTestCtx();

    const done = createPromptGenHandler(ctx).execute({ prompt: "p" }, {});
    const failure = expect(done).rejects.toMatchObject({
      name: "RetryableProviderError",
      status: 503
    });
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2 * RETRY_BASE_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    await failure;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(ctx.log.warn).toHaveBeenCalledTimes(2);
  });

  it("retries a request timeout", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          })
      )
      .mockResolvedValueOnce(answer("late"));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createTestCtx({ config: { timeoutMs: 5 } });

    const result = await createPromptGenHandler(ctx).execute({ prompt: "p" }, {});

    expect(result.text).toBe("late");
    expect(ctx.log.warn).toHaveBeenCalledWith("fal:llm:retry", {
      model: OPUS,
      attempt: 1,
      errorType: "retryable",
      status: undefined,
      kind: "timeout"
    });
  });

  it("does not retry a network failure", async () => {
    const fetchMock = stubFetch(new TypeError("fetch failed"));
    const error = await rejectionOf(
      createPromptGenHandler(createTestCtx()).execute({ prompt: "p" }, {})
    );
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ kind: "network" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      429,
      "limit",
      "[ai] fal limited the LLM request (HTTP 429).\n  Wait, or use another prompt-gen provider."
    ],
    [
      402,
      "limit",
      "[ai] fal limited the LLM request (HTTP 402).\n  Wait, or use another prompt-gen provider."
    ],
    [
      401,
      "auth",
      "[ai] fal refused the LLM request (HTTP 401).\n  Check FAL_KEY, or use another prompt-gen provider."
    ],
    [
      403,
      "auth",
      "[ai] fal refused the LLM request (HTTP 403).\n  Check FAL_KEY, or use another prompt-gen provider."
    ]
  ])("throws HTTP %d at once as PromptGenUnavailableError %s", async (status, reason, message) => {
    const fetchMock = stubFetch(jsonResponse(status, { detail: "no" }));
    const error = await rejectionOf(
      createPromptGenHandler(createTestCtx()).execute({ prompt: "p" }, {})
    );
    expect(error).toBeInstanceOf(PromptGenUnavailableError);
    expect(error).toMatchObject({ reason, message });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps any other 4xx a terminal error, not retried", async () => {
    const fetchMock = stubFetch(jsonResponse(400, { detail: "bad body" }));
    const error = await rejectionOf(
      createPromptGenHandler(createTestCtx()).execute({ prompt: "p" }, {})
    );
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an abort during the backoff rejects with the signal's reason", async () => {
    vi.useFakeTimers();
    stubFetch(jsonResponse(500, {}), answer("never"));
    const controller = new AbortController();

    const done = createPromptGenHandler(createTestCtx()).execute(
      { prompt: "p" },
      { signal: controller.signal }
    );
    const failure = expect(done).rejects.toBe("paused");
    await vi.advanceTimersByTimeAsync(10);
    controller.abort("paused");
    await failure;
  });

  it("needs the key before any call", async () => {
    const fetchMock = stubFetch();
    const ctx = createTestCtx({ config: { apiKeyEnv: "OTHER_KEY" } });
    await expect(createPromptGenHandler(ctx).execute({ prompt: "p" }, {})).rejects.toThrow(
      "[ai] OTHER_KEY is not set."
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("answer reading", () => {
  it("flags an error body that names the content policy", async () => {
    stubFetch(jsonResponse(200, { error: { message: "content_policy_violation: nope" } }));
    const error = await rejectionOf(
      createPromptGenHandler(createTestCtx()).execute({ prompt: "p" }, {})
    );
    expect(error).toBeInstanceOf(FlaggedProviderError);
  });

  it("flags a content-policy marker that sits past the 300-character cut", async () => {
    const message = `${"x".repeat(400)} content_policy_violation`;
    stubFetch(jsonResponse(200, { error: { message } }));
    const error = await rejectionOf(
      createPromptGenHandler(createTestCtx()).execute({ prompt: "p" }, {})
    );
    expect(error).toBeInstanceOf(FlaggedProviderError);
  });

  it("turns any other error body into a terminal 400 with fal's text cut to 300", async () => {
    stubFetch(jsonResponse(200, { error: { message: `bad model ${"x".repeat(400)}` } }));
    const error = await rejectionOf(
      createPromptGenHandler(createTestCtx()).execute({ prompt: "p" }, {})
    );
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({ status: 400 });
    const { message } = error as Error;
    expect(message.startsWith("[ai] fal LLM returned an error: bad model x")).toBe(true);
    expect(message.length).toBeLessThan(360);
  });

  it("reads a null content cut by length as an empty, partial answer", async () => {
    stubFetch(
      // eslint-disable-next-line unicorn/no-null -- fal sends JSON null content when cut by length
      jsonResponse(200, { choices: [{ message: { content: null }, finish_reason: "length" }] })
    );
    const ctx = createTestCtx();
    const result = await createPromptGenHandler(ctx).execute({ prompt: "p" }, {});
    expect(result.text).toBe("");
    expect(result.meta).toMatchObject({
      partial: true,
      finishReason: "length",
      costSource: "chars"
    });
    expect(ctx.log.warn).toHaveBeenCalledWith("fal:llm:partial", { model: OPUS });
  });

  it("rejects an answer without choices[0].message.content", async () => {
    stubFetch(jsonResponse(200, { choices: [] }));
    await expect(
      createPromptGenHandler(createTestCtx()).execute({ prompt: "p" }, {})
    ).rejects.toThrow(
      "[ai] fal returned an incomplete LLM result.\n  Expected choices[0].message.content in the response."
    );
  });
});

describe("request log", () => {
  it("writes one line per POST attempt", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "moku-fal-llm-log-"));
    const file = path.join(dir, "fal.jsonl");
    stubFetch(jsonResponse(500, {}), answer("ok"));
    const ctx = createTestCtx({ config: { requestLog: file } });

    await createPromptGenHandler(ctx).execute({ prompt: "p" }, {});

    const lines = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line) as Record<string, unknown>);
    rmSync(dir, { recursive: true, force: true });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      task: "prompt-gen",
      model: OPUS,
      endpoint: CHAT_PATH,
      error: { errorType: "retryable", status: 500 },
      prompt: "p"
    });
    expect(lines[1]).toMatchObject({
      requestId: "gen-1",
      body: { model: OPUS, max_tokens: 32_000 }
    });
  });
});
