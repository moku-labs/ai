/**
 * @file openai unit test fixtures — fake `OpenaiContext` + fake `OpenaiClient`
 * builders. NOT a test file itself (no `.test.ts` suffix), so vitest does not
 * collect it as a suite.
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import { vi } from "vitest";
import type { registryPlugin } from "../../../registry";
import type {
  Config,
  OpenaiChatCompletion,
  OpenaiChatRequestBody,
  OpenaiClient,
  OpenaiContext,
  OpenaiSpeechRequestBody,
  OpenaiSpeechResult,
  RegistryApi,
  State
} from "../../types";

/** Default fixture config: matches the plugin's own `defaultConfig` in `index.ts`. */
export const FIXTURE_CONFIG: Config = {
  apiKeyEnv: "OPENAI_API_KEY",
  models: { tts: "gpt-4o-mini-tts", chat: "gpt-4o-mini" },
  timeoutMs: 60_000,
  priceOverrides: {}
};

/**
 * State fields (`client`/`prices`) and the chat message `content`/`refusal`
 * pair are all typed `X | null` (spec/AI M0 mirrors the real OpenAI
 * contract) — the single source of the `null` literal for this file.
 */
// eslint-disable-next-line unicorn/no-null -- see comment above
const FAKE_NULL = null;

/**
 * Builds a chat message result with text content (no refusal) — avoids
 * repeating the `null` literal at every call site.
 *
 * @param content - The generated text.
 * @returns A message result with `content` set and `refusal` null.
 * @example
 * ```ts
 * textMessage("Hola");
 * ```
 */
export function textMessage(content: string): { content: string; refusal: null } {
  return { content, refusal: FAKE_NULL };
}

/**
 * Builds a chat message result carrying a model refusal (no content) —
 * avoids repeating the `null` literal at every call site.
 *
 * @param refusal - The model's refusal explanation.
 * @returns A message result with `refusal` set and `content` null.
 * @example
 * ```ts
 * refusalMessage("I can't help with that.");
 * ```
 */
export function refusalMessage(refusal: string): { content: null; refusal: string } {
  return { content: FAKE_NULL, refusal };
}

/** Overrides accepted by {@link createFakeOpenaiContext}. */
export type FakeOpenaiContextOverrides = {
  config?: Partial<Config>;
  state?: Partial<State>;
  /** When set, `ctx.env.get(config.apiKeyEnv)` resolves to this value; otherwise it is unset. */
  apiKey?: string;
};

/**
 * Builds a fake `OpenaiContext` for unit tests: fixture config, fresh state
 * (both fields `null` unless overridden — e.g. pre-seeding `state.client`
 * with a fake `OpenaiClient` lets handler/request tests skip the SDK
 * boundary entirely), an in-memory `env` backed by a single optional API
 * key, and a `vi.fn()`-backed `log`.
 *
 * @param overrides - Partial overrides for config, state, and the API key.
 * @returns A fake `OpenaiContext`.
 * @example
 * ```ts
 * const ctx = createFakeOpenaiContext({ apiKey: "sk-test" });
 * ```
 */
export function createFakeOpenaiContext(overrides: FakeOpenaiContextOverrides = {}): OpenaiContext {
  const config: Config = { ...FIXTURE_CONFIG, ...overrides.config };
  const state: State = { client: FAKE_NULL, prices: FAKE_NULL, ...overrides.state };
  const envValues = new Map<string, string>();
  if (overrides.apiKey !== undefined) envValues.set(config.apiKeyEnv, overrides.apiKey);

  const env: EnvApi = {
    get: (key: string): string | undefined => envValues.get(key),
    require: (key: string): string => {
      const value = envValues.get(key);
      if (value === undefined) {
        throw new Error(
          `[ai] ${key} is not set.\n  Export it or set config.apiKeyEnv to the variable that holds your key.`
        );
      }
      return value;
    },
    has: (key: string): boolean => envValues.has(key),
    getPublic: (): Readonly<Record<string, string>> => Object.freeze(Object.fromEntries(envValues)),
    getPublicMap: (): ReadonlyMap<string, string> => new Map(envValues)
  };

  const log: LogApi = {
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

/** One recorded `audio.speech.create` call, for call-shape assertions. */
export type SpeechCreateCall = { params: OpenaiSpeechRequestBody; signal: AbortSignal | undefined };
/** One recorded `chat.completions.create` call, for call-shape assertions. */
export type ChatCreateCall = { params: OpenaiChatRequestBody; signal: AbortSignal | undefined };

/** Overrides accepted by {@link createFakeOpenaiClient}. */
export type FakeOpenaiClientOverrides = {
  speechResult?: OpenaiSpeechResult;
  chatResult?: OpenaiChatCompletion;
  speechImpl?: OpenaiClient["audio"]["speech"]["create"];
  chatImpl?: OpenaiClient["chat"]["completions"]["create"];
};

/**
 * Builds a fake `OpenaiClient` (a plain object literal, since `OpenaiClient`
 * is structural — no SDK involved) that records every call and returns a
 * fixed/overridable result, letting tests inspect exactly what request
 * shape a handler built and assert on signal passthrough.
 *
 * @param overrides - Fixed results or full implementations to install.
 * @returns The fake client plus its recorded call log.
 * @example
 * ```ts
 * const { client, speechCalls } = createFakeOpenaiClient();
 * ```
 */
export function createFakeOpenaiClient(overrides: FakeOpenaiClientOverrides = {}): {
  client: OpenaiClient;
  speechCalls: SpeechCreateCall[];
  chatCalls: ChatCreateCall[];
} {
  const speechCalls: SpeechCreateCall[] = [];
  const chatCalls: ChatCreateCall[] = [];

  const client: OpenaiClient = {
    audio: {
      speech: {
        create: async (params, options) => {
          speechCalls.push({ params, signal: options?.signal });
          if (overrides.speechImpl) return overrides.speechImpl(params, options);
          return overrides.speechResult ?? { arrayBuffer: async () => new ArrayBuffer(4) };
        }
      }
    },
    chat: {
      completions: {
        create: async (params, options) => {
          chatCalls.push({ params, signal: options?.signal });
          if (overrides.chatImpl) return overrides.chatImpl(params, options);
          return (
            overrides.chatResult ?? {
              choices: [{ message: textMessage("ok") }],
              usage: { prompt_tokens: 10, completion_tokens: 5 }
            }
          );
        }
      }
    }
  };

  return { client, speechCalls, chatCalls };
}
