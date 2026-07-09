import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvProvider } from "@moku-labs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { promptGenPlugin } from "../../../promptGen";
import { registryPlugin } from "../../../registry";
import { translatePlugin } from "../../../translate";
import { voiceoverPlugin } from "../../../voiceover";
import { openaiPlugin } from "../../index";
import { FlaggedProviderError } from "../../types";

// ---------------------------------------------------------------------------
// Integration test: openai provider through the real createApp lifecycle —
// registered under all three tasks (voiceover/translate/prompt-gen) in
// onInit, consumed end-to-end through each task facade. Fetch is mocked at
// the boundary (vi.stubGlobal, real Response instances — the SDK reads
// `.headers.entries()`/`.text()`/`.json()`/`.arrayBuffer()` internally, so a
// hand-rolled fake object is not enough); NO real network calls anywhere.
// ---------------------------------------------------------------------------

/**
 * OpenAI's real chat message `content`/`refusal` fields are typed
 * `string | null` — the single source of the `null` literal for this file.
 */
// eslint-disable-next-line unicorn/no-null -- see comment above
const NO_TEXT = null;

/**
 * Builds a `chat.completions` response echoing `options.echo` back as the
 * assistant's content, or a refusal when `options.flagged` is set.
 *
 * @param options - The text to echo, and whether to simulate a refusal.
 * @param options.echo - The text to echo back as the completion content.
 * @param options.flagged - When true, the response carries a refusal instead of content.
 * @returns A fake chat completion `Response`.
 * @example
 * ```ts
 * fakeChatResponse({ echo: "Hello" });
 * ```
 */
function fakeChatResponse(options: { echo: string; flagged?: boolean }): Response {
  const payload = {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 0,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: options.flagged ? NO_TEXT : `echo:${options.echo}`,
          refusal: options.flagged ? "I can't help with that." : NO_TEXT
        }
      }
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  };
  return Response.json(payload);
}

/**
 * Builds an `audio.speech` response carrying `bytes` as the raw audio body.
 *
 * @param bytes - The raw audio bytes the response should carry.
 * @returns A fake tts `Response`.
 * @example
 * ```ts
 * fakeSpeechResponse(new Uint8Array([1, 2, 3, 4]));
 * ```
 */
function fakeSpeechResponse(bytes: Uint8Array): Response {
  return new Response(bytes, { status: 200, headers: { "content-type": "audio/mpeg" } });
}

/**
 * Fakes the OpenAI HTTP boundary: dispatches by request path to a chat or
 * speech response, reading the last user message out of the request body so
 * assertions can verify the round trip end to end.
 *
 * @returns A fake `fetch` implementation.
 * @example
 * ```ts
 * vi.stubGlobal("fetch", createFakeOpenaiFetch());
 * ```
 */
function createFakeOpenaiFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/audio/speech")) {
      return fakeSpeechResponse(new Uint8Array([1, 2, 3, 4]));
    }
    if (url.includes("/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ content: string }>;
      };
      const lastMessage = body.messages?.at(-1)?.content ?? "";
      return fakeChatResponse({
        echo: lastMessage,
        flagged: lastMessage.includes("TRIGGER_CONTENT_POLICY")
      });
    }
    throw new Error(`createFakeOpenaiFetch: unexpected request to ${url}`);
  }) as typeof fetch;
}

/** A fixture `EnvProvider` resolving `OPENAI_API_KEY` without touching real process env. */
const fixtureEnvProvider: EnvProvider = {
  name: "openai-integration-fixture",
  load: () => ({ OPENAI_API_KEY: "test-key" })
};

/**
 * Assembles a fresh framework wiring registry + voiceover + translate +
 * promptGen + openai. `journal` (core plugin) is pinned to `dbPath` so
 * `onStart` never writes `.moku/journal.db` into the repo's real cwd; `env`
 * (also core) is pinned to the fixture provider above when `withApiKey` is
 * true, so `configured`/`execute()` see a resolved API key without touching
 * real process env.
 *
 * @param dbPath - The temp-dir journal database path for this test.
 * @param withApiKey - Whether to wire the fixture env provider supplying the API key.
 * @returns The assembled framework (`createApp`/`createPlugin`).
 * @example
 * ```ts
 * const { createApp } = buildFramework(dbPath, true);
 * ```
 */
function buildFramework(dbPath: string, withApiKey: boolean) {
  return createCore(coreConfig, {
    plugins: [registryPlugin, voiceoverPlugin, translatePlugin, promptGenPlugin, openaiPlugin],
    pluginConfigs: {
      journal: { path: dbPath },
      ...(withApiKey ? { env: { providers: [fixtureEnvProvider] } } : {})
    }
  });
}

describe("openai integration", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "moku-openai-integration-"));
    dbPath = path.join(tempDir, "journal.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("registers under all three tasks in onInit, visible via each facade's providers()", async () => {
    const { createApp } = buildFramework(dbPath, true);
    const app = createApp();
    await app.start();

    expect(app.voiceover.providers()).toEqual(["openai"]);
    expect(app.translate.providers()).toEqual(["openai"]);
    expect(app.promptGen.providers()).toEqual(["openai"]);

    await app.stop();
  });

  it("round-trips through app.voiceover.generate() with provider openai", async () => {
    vi.stubGlobal("fetch", createFakeOpenaiFetch());
    const { createApp } = buildFramework(dbPath, true);
    const app = createApp();
    await app.start();

    const result = await app.voiceover.generate(
      { text: "Hello", voice: "alloy" },
      { provider: "openai" }
    );

    expect([...result.audio]).toEqual([1, 2, 3, 4]);
    expect(result.mimeType).toBe("audio/mpeg");
    expect(result.costUsd).toBeCloseTo(("Hello".length / 1_000_000) * 15, 10);

    await app.stop();
  });

  it("round-trips through app.translate.generate() with provider openai", async () => {
    vi.stubGlobal("fetch", createFakeOpenaiFetch());
    const { createApp } = buildFramework(dbPath, true);
    const app = createApp();
    await app.start();

    const result = await app.translate.generate(
      { text: "Hello", targetLang: "es" },
      { provider: "openai" }
    );

    expect(result.text).toBe("echo:Hello");
    expect(result.costUsd).toBeGreaterThan(0);

    await app.stop();
  });

  it("round-trips through app.promptGen.generate() with provider openai", async () => {
    vi.stubGlobal("fetch", createFakeOpenaiFetch());
    const { createApp } = buildFramework(dbPath, true);
    const app = createApp();
    await app.start();

    const result = await app.promptGen.generate(
      { prompt: "Describe a sunset." },
      { provider: "openai" }
    );

    expect(result.text).toBe("echo:Describe a sunset.");
    expect(result.costUsd).toBeGreaterThan(0);

    await app.stop();
  });

  it("exposes app.openai.info() reflecting the configured API key", async () => {
    const { createApp } = buildFramework(dbPath, true);
    const app = createApp();
    await app.start();

    expect(app.openai.info()).toEqual({
      provider: "openai",
      configured: true,
      models: { tts: "gpt-4o-mini-tts", chat: "gpt-4o-mini" }
    });

    await app.stop();
  });

  it("app.openai.info() reports configured: false with no API key configured", async () => {
    const { createApp } = buildFramework(dbPath, false);
    const app = createApp();
    await app.start();

    expect(app.openai.info().configured).toBe(false);

    await app.stop();
  });

  it("throws the pinned missing-key error from execute() when no API key is configured", async () => {
    const { createApp } = buildFramework(dbPath, false);
    const app = createApp();
    await app.start();

    await expect(
      app.voiceover.generate({ text: "hi", voice: "alloy" }, { provider: "openai" })
    ).rejects.toThrow(
      "[ai] OPENAI_API_KEY is not set.\n  Export it or set config.apiKeyEnv to the variable that holds your key."
    );

    await app.stop();
  });

  it("propagates a FlaggedProviderError through app.translate.generate() on a model refusal", async () => {
    vi.stubGlobal("fetch", createFakeOpenaiFetch());
    const { createApp } = buildFramework(dbPath, true);
    const app = createApp();
    await app.start();

    await expect(
      app.translate.generate(
        { text: "TRIGGER_CONTENT_POLICY", targetLang: "es" },
        { provider: "openai" }
      )
    ).rejects.toBeInstanceOf(FlaggedProviderError);

    await app.stop();
  });
});
