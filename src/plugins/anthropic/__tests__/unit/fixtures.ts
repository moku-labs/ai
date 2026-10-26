/**
 * @file anthropic unit test fixtures — fake `AnthropicContext`, fake
 * structural `AnthropicClient` that records every request, answer builders
 * and temp image files. Not a test file (no `.test.ts` suffix).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvApi, LogApi } from "@moku-labs/common";
import { vi } from "vitest";
import type { registryPlugin } from "../../../registry";
import type {
  AnthropicCallOptions,
  AnthropicClient,
  AnthropicContentBlock,
  AnthropicContext,
  AnthropicMessage,
  AnthropicRequestBody,
  AnthropicUsage,
  Config,
  RegistryApi,
  State
} from "../../types";

/** Default fixture config: the plugin's own `defaultConfig` in `index.ts`. */
export const FIXTURE_CONFIG: Config = {
  apiKeyEnv: "ANTHROPIC_API_KEY",
  model: "claude-opus-5-5",
  maxTokens: 32_000,
  timeoutMs: 900_000,
  priceOverrides: {}
};

/** State `client`/`prices` are `X | null` by spec: the one `null` literal of this file. */
// eslint-disable-next-line unicorn/no-null -- see comment above
const NOT_CREATED = null;

/** Overrides accepted by {@link createFakeAnthropicContext}. */
export type FakeContextOverrides = {
  config?: Partial<Config>;
  state?: Partial<State>;
  /** When set, `ctx.env.get(config.apiKeyEnv)` returns it; otherwise the key is unset. */
  apiKey?: string;
};

/** A fake ctx plus its `vi.fn()` log methods, typed for call assertions. */
export type FakeContext = AnthropicContext & {
  log: LogApi & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
};

/**
 * Builds a fake `AnthropicContext`: fixture config, fresh state, an
 * in-memory env with one optional key, a `vi.fn()` log.
 *
 * @param overrides - Config, state and key overrides.
 * @returns The fake context.
 */
export function createFakeAnthropicContext(overrides: FakeContextOverrides = {}): FakeContext {
  const config: Config = { ...FIXTURE_CONFIG, ...overrides.config };
  const state: State = {
    client: NOT_CREATED,
    prices: NOT_CREATED,
    turns: new Map(),
    ...overrides.state
  };
  const envValues = new Map<string, string>();
  if (overrides.apiKey !== undefined) envValues.set(config.apiKeyEnv, overrides.apiKey);

  const env: EnvApi = {
    get: (key: string): string | undefined => envValues.get(key),
    require: (key: string): string => {
      const value = envValues.get(key);
      if (value === undefined) throw new Error(`[ai] ${key} is not set.`);
      return value;
    },
    has: (key: string): boolean => envValues.has(key),
    getPublic: (): Readonly<Record<string, string>> => Object.freeze(Object.fromEntries(envValues)),
    getPublicMap: (): ReadonlyMap<string, string> => new Map(envValues)
  };

  const log = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: (): readonly [] => [],
    expect: vi.fn(),
    addSink: vi.fn(),
    reset: vi.fn(),
    clearSinks: vi.fn()
  };

  const registry: RegistryApi = {
    register: vi.fn(),
    resolve: (): unknown => undefined,
    providers: (): string[] => [],
    tasks: (): string[] => []
  };

  return {
    config,
    state,
    emit: () => undefined,
    require: (_plugin: typeof registryPlugin): RegistryApi => registry,
    env,
    log
  };
}

/** One recorded `messages.stream` call. */
export type StreamCall = { params: AnthropicRequestBody; signal: AbortSignal | undefined };

/** What one scripted request answers: a message, or an error thrown by `finalMessage`. */
export type Scripted = AnthropicMessage | Error;

/**
 * Builds a fake `AnthropicClient` that records each request and answers the
 * scripted messages in order (`"ok"` text once the script runs out).
 *
 * @param answers - The scripted answers, in request order.
 * @returns The client and its recorded calls.
 */
export function createFakeAnthropicClient(answers: readonly Scripted[] = []): {
  client: AnthropicClient;
  calls: StreamCall[];
} {
  const calls: StreamCall[] = [];
  const client: AnthropicClient = {
    messages: {
      stream: (params: AnthropicRequestBody, options?: AnthropicCallOptions) => {
        calls.push({ params, signal: options?.signal });
        const next = answers[calls.length - 1] ?? textAnswer("ok");
        return {
          finalMessage: async (): Promise<AnthropicMessage> => {
            if (next instanceof Error) throw next;
            return next;
          }
        };
      }
    }
  };
  return { client, calls };
}

/** Usage of a plain answer: 100 uncached input tokens, 20 output tokens, no cache counts. */
export const PLAIN_USAGE: AnthropicUsage = { input_tokens: 100, output_tokens: 20 };

/**
 * A finished message.
 *
 * @param content - The answer blocks.
 * @param stopReason - The stop reason.
 * @param usage - The usage.
 * @returns The message.
 */
export function answerOf(
  content: AnthropicContentBlock[],
  stopReason: string | null = "end_turn",
  usage: AnthropicUsage = PLAIN_USAGE
): AnthropicMessage {
  return { content, stop_reason: stopReason, usage };
}

/**
 * A text-only finished message.
 *
 * @param text - The answer text.
 * @returns The message.
 */
export function textAnswer(text: string): AnthropicMessage {
  return answerOf([{ type: "text", text }]);
}

/** The bytes of the fixture image files: a PNG signature. */
export const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** {@link IMAGE_BYTES} as base64, as an image block carries them. */
export const IMAGE_BASE64 = IMAGE_BYTES.toString("base64");

/**
 * A temp dir for image files; `cleanup` removes it.
 *
 * @returns `file(name)` writes {@link IMAGE_BYTES} to a new file and returns its path.
 */
export function createImageDir(): { file: (name: string) => string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "moku-anthropic-"));
  return {
    file: (name: string): string => {
      const filePath = path.join(dir, name);
      writeFileSync(filePath, IMAGE_BYTES);
      return filePath;
    },
    cleanup: (): void => rmSync(dir, { recursive: true, force: true })
  };
}
