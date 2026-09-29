/**
 * @file apimodels unit test fixtures — fake `ApimodelsContext` builder, fake
 * `registry`/`env`/`log`/`journal`, envelope `Response` builders, a scripted
 * URL-routing `fetch` for the apimodels API, and temp-file helpers for
 * `VideoFile` inputs. NOT a test file itself (no `.test.ts` suffix).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvApi, LogApi } from "@moku-labs/common";
import type { Mock } from "vitest";
import { vi } from "vitest";
import type { ProviderRecord } from "../../../journal/types";
import type { VideoFile } from "../../../video/contract";
import type { ApimodelsContext, ApimodelsJournal, Config, RegistryApi, State } from "../../types";

/** The API base URL every fixture uses (the plugin default). */
export const BASE = "https://api.apimodels.app/v1";

/** Default config fixture, matching `apimodelsPlugin`'s own defaults. */
export const DEFAULT_CONFIG: Config = {
  apiKeyEnv: "APIMODELS_API_KEY",
  baseUrl: BASE,
  assetGroup: "moku-ai",
  timeoutMs: 60_000,
  priceOverrides: {}
};

/** The fake key every test context resolves (never a real key). */
export const TEST_KEY = "test-apimodels-key-0123456789";

/** A prompt that must never reach a log line, a journal row or an error message. */
export const PROMPT = "a secret prompt that must never be logged";

/** Clip bytes a fake download returns. */
export const CLIP = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);

/** Builds an in-memory fake mirroring registry's real behavior. */
export function createFakeRegistry(): RegistryApi {
  const handlers = new Map<string, Map<string, unknown>>();
  return {
    register(task, provider, handler) {
      const taskProviders = handlers.get(task) ?? new Map<string, unknown>();
      taskProviders.set(provider, handler);
      handlers.set(task, taskProviders);
    },
    resolve(task, provider) {
      return handlers.get(task)?.get(provider);
    },
    providers(task) {
      return [...(handlers.get(task)?.keys() ?? [])];
    },
    tasks() {
      return [...handlers.keys()];
    }
  };
}

/** Builds a fake `EnvApi` backed by a plain record of resolved variables. */
export function createFakeEnv(given?: Record<string, string>): EnvApi {
  const values = given ?? { APIMODELS_API_KEY: TEST_KEY };
  return {
    get: key => values[key],
    require: key => {
      const value = values[key];
      if (value === undefined) throw new Error(`[ai] ${key} is not set.`);
      return value;
    },
    has: key => key in values,
    getPublic: () => ({ ...values }),
    getPublicMap: () => new Map(Object.entries(values))
  };
}

/** Builds a fake `LogApi` with every method a `vi.fn()` mock. */
export function createFakeLog(): LogApi {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: () => [],
    expect: vi.fn(),
    addSink: vi.fn(),
    reset: vi.fn(),
    clearSinks: vi.fn()
  };
}

/** A fake journal: every method a spy over an in-memory record table. */
export type FakeJournal = {
  [K in keyof ApimodelsJournal]: Mock<ApimodelsJournal[K]>;
} & {
  /** Stored values by `provider|account|kind|key`. */
  records: Map<string, string>;
  /** Opens or closes the fake (a closed journal throws like the real one). */
  setOpen(open: boolean): void;
};

/** Identity of a record inside {@link FakeJournal.records}. */
export function recordKey(q: Omit<ProviderRecord, "value">): string {
  return `${q.provider}|${q.account}|${q.kind}|${q.key}`;
}

/** Builds a {@link FakeJournal}; open unless `open` is false. */
export function createFakeJournal(open = true): FakeJournal {
  const records = new Map<string, string>();
  const status = { open };
  const requireOpen = (): void => {
    if (!status.open)
      throw new Error("[ai] Journal is not open.\n  Call app.start() before using the journal.");
  };
  return {
    records,
    setOpen(next) {
      status.open = next;
    },
    isOpen: vi.fn(() => status.open),
    findProviderRecord: vi.fn(q => {
      requireOpen();
      return records.get(recordKey(q));
    }),
    putProviderRecords: vi.fn((list: ProviderRecord[]) => {
      requireOpen();
      for (const record of list) records.set(recordKey(record), record.value);
    }),
    deleteProviderRecord: vi.fn(q => {
      requireOpen();
      records.delete(recordKey(q));
    })
  };
}

/** Per-dependency overrides accepted by {@link createTestCtx}. */
export type TestCtxOverrides = {
  config?: Partial<Config>;
  state?: Partial<State>;
  registry?: RegistryApi;
  env?: EnvApi;
  log?: LogApi;
  journal?: FakeJournal;
};

/** Builds a fake `ApimodelsContext`: default config, empty caches, fake registry/env/log/journal. */
export function createTestCtx(overrides: TestCtxOverrides = {}): ApimodelsContext {
  const config: Config = { ...DEFAULT_CONFIG, ...overrides.config };
  const state: State = {
    // eslint-disable-next-line unicorn/no-null -- State.prices is `X | null`; mirrors createApimodelsState's sentinel
    prices: null,
    uploads: new Map(),
    assets: new Map(),
    groups: new Map(),
    groupsInFlight: new Map(),
    assetsInFlight: new Map(),
    uploadsInFlight: new Map(),
    journalSkipLogged: false,
    ...overrides.state
  };
  const registry = overrides.registry ?? createFakeRegistry();
  return {
    config,
    state,
    emit: () => undefined,
    require: () => registry,
    env: overrides.env ?? createFakeEnv(),
    log: overrides.log ?? createFakeLog(),
    journal: overrides.journal ?? createFakeJournal()
  };
}

/** Everything any log call of `ctx` received, stringified. */
export function loggedText(ctx: ApimodelsContext): string {
  const log = ctx.log as unknown as Record<string, Mock>;
  return JSON.stringify(
    ["info", "debug", "warn", "error"].flatMap(level => log[level]?.mock.calls ?? [])
  );
}

/** Calls of one log level, as `[event, data]` pairs. */
export function logCalls(ctx: ApimodelsContext, level: "info" | "debug" | "warn"): unknown[][] {
  return (ctx.log[level] as unknown as Mock).mock.calls;
}

/** A real JSON `Response` with the given status, body and headers. */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return Response.json(body, { status, headers });
}

/** An apimodels `{ code, msg, data }` envelope, HTTP 200 unless told otherwise. */
export function envelope(data: unknown, code = 200, httpStatus = 200): Response {
  return jsonResponse(httpStatus, { code, msg: code === 200 ? "success" : "error", data });
}

/** A real binary `Response` (a video download). */
export function bytesResponse(bytes: Uint8Array, contentType = "video/mp4"): Response {
  return new Response(bytes, { status: 200, headers: { "content-type": contentType } });
}

/** One recorded `fetch` call: URL, method, headers and body. */
export type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: RequestInit["body"];
};

/** Normalizes a fetch mock's recorded calls into {@link FetchCall}s. */
export function callsOf(fetchMock: Mock): FetchCall[] {
  return fetchMock.mock.calls.map(call => {
    const [url, init] = call as [string, RequestInit | undefined];
    return {
      url,
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: init?.body
    };
  });
}

/** Parses a recorded call's JSON body. */
export function jsonBodyOf(call: FetchCall | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.body)) as Record<string, unknown>;
}

/** Stubs global `fetch` with responses returned in order; extra calls fail the test. */
export function stubFetch(...responses: Array<Response | Error>): Mock {
  const fetchMock = vi.fn();
  for (const response of responses) {
    if (response instanceof Error) fetchMock.mockRejectedValueOnce(response);
    else fetchMock.mockResolvedValueOnce(response);
  }
  fetchMock.mockRejectedValue(new Error("unexpected extra fetch call"));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Kinds of apimodels calls {@link stubApi} routes. */
export type ApiCallKind =
  | "upload"
  | "group"
  | "register"
  | "submit"
  | "poll"
  | "records"
  | "download";

/** How {@link stubApi} answers each kind of call; `n` counts calls of that kind, from 1. */
export type ApiScript = {
  upload?: (n: number, form: FormData) => Response | Promise<Response>;
  group?: (n: number, body: Record<string, unknown>) => Response | Promise<Response>;
  register?: (n: number, body: Record<string, unknown>) => Response | Promise<Response>;
  submit?: (n: number, body: Record<string, unknown>) => Response | Promise<Response>;
  poll?: (taskId: string, n: number) => Response | Promise<Response>;
  records?: (taskId: string, n: number) => Response | Promise<Response>;
  download?: (url: string, n: number) => Response | Promise<Response>;
};

/** A stubbed apimodels API: the fetch mock plus per-kind call views. */
export type StubbedApi = {
  fetchMock: Mock;
  calls(kind?: ApiCallKind): FetchCall[];
  count(kind: ApiCallKind): number;
};

/** The public URL {@link stubApi} hands out for an uploaded `file` field named `name`. */
export function publicUrlOf(name: string): string {
  return `https://files.apimodels.test/${name}`;
}

/** Result URL of a completed task in {@link stubApi}'s default poll. */
export function resultUrlOf(taskId: string): string {
  return `https://r2.apimodels.test/results/${taskId}.mp4`;
}

/** Which apimodels call a URL + method is. */
function kindOf(url: string, method: string): ApiCallKind {
  if (url === `${BASE}/files`) return "upload";
  if (url === `${BASE}/assets/groups`) return "group";
  if (url === `${BASE}/assets`) return "register";
  if (url === `${BASE}/video/generations` && method === "POST") return "submit";
  if (url.startsWith(`${BASE}/video/generations?task_id=`)) return "poll";
  if (url.startsWith(`${BASE}/records/`)) return "records";
  return "download";
}

/** A completed task poll body for `taskId`. */
export function completedTask(taskId: string): Response {
  return envelope({ taskId, state: "completed", resultUrls: [resultUrlOf(taskId)] });
}

/** What one routed call carries into its answer. */
type RouteInput = { url: string; n: number; form: FormData; body: Record<string, unknown> };

/** The default answer of each kind, and how a script overrides it. */
const ROUTES: Record<
  ApiCallKind,
  (script: ApiScript, input: RouteInput) => Response | Promise<Response>
> = {
  upload: (script, { n, form }) =>
    script.upload?.(n, form) ??
    envelope({ publicUrl: publicUrlOf((form.get("file") as File).name) }),
  group: (script, { n, body }) => script.group?.(n, body) ?? envelope({ id: "grp-1" }),
  register: (script, { n, body }) =>
    script.register?.(n, body) ??
    envelope({ id: `asset-${n}`, asset_url: `asset://asset-${n}`, status: "Active" }),
  submit: (script, { n, body }) =>
    script.submit?.(n, body) ?? envelope({ taskId: `task-${n}`, state: "pending" }),
  poll: (script, { url, n }) => {
    const taskId = new URL(url).searchParams.get("task_id") ?? "";
    return script.poll?.(taskId, n) ?? envelope({ taskId, state: "pending" });
  },
  records: (script, { url, n }) => {
    const taskId = decodeURIComponent(url.slice(`${BASE}/records/`.length));
    return script.records?.(taskId, n) ?? envelope({ settled: false, currency: "USD" });
  },
  download: (script, { url, n }) => script.download?.(url, n) ?? bytesResponse(CLIP)
};

/** Parses a JSON request body; anything else reads as `{}`. */
function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
}

/**
 * Stubs global `fetch` as the apimodels API: uploads answer with a public URL
 * named after the uploaded file, a group is `grp-1`, registrations are
 * `asset://asset-<n>`, submits are `task-<n>`, polls stay pending, records are
 * unsettled, downloads return {@link CLIP}. `script` overrides any kind. An
 * already aborted signal rejects like real fetch.
 */
export function stubApi(script: ApiScript = {}): StubbedApi {
  const counts = new Map<ApiCallKind, number>();
  const kinds: ApiCallKind[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const kind = kindOf(url, init?.method ?? "GET");
    const n = (counts.get(kind) ?? 0) + 1;
    kinds.push(kind);
    counts.set(kind, n);
    if (init?.signal?.aborted) throw init.signal.reason;
    return ROUTES[kind](script, { url, n, form: init?.body as FormData, body: bodyOf(init) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    calls: kind =>
      callsOf(fetchMock).filter((_call, index) => kind === undefined || kinds[index] === kind),
    count: kind => counts.get(kind) ?? 0
  };
}

/** A temp directory holding real files for `VideoFile` inputs. */
export type TempFiles = {
  dir: string;
  /** Writes `bytes` under `name` and returns the `VideoFile` pointing at it. */
  file(name: string, bytes: Uint8Array, mimeType: string, hash: string): VideoFile;
  /** Removes the directory. */
  cleanup(): void;
};

/** Creates a temp directory for `VideoFile` fixtures. */
export function createTempFiles(): TempFiles {
  const dir = mkdtempSync(path.join(tmpdir(), "moku-apimodels-"));
  return {
    dir,
    file(name, bytes, mimeType, hash) {
      const filePath = path.join(dir, name);
      writeFileSync(filePath, bytes);
      return { path: filePath, mimeType, hash };
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/** Runs `work` and returns what it threw (fails when it resolves). */
export async function rejectionOf(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

/** Runs `work` and returns what it threw synchronously (fails when it returns). */
export function thrownBy(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}
