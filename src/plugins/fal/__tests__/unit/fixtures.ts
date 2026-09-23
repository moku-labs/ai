/**
 * @file fal unit test fixtures — fake `FalContext` builder, fake
 * `registry`/`env`/`log`, real `Response` builders for a scripted `fetch`,
 * and temp-file helpers for `VideoFile` inputs. NOT a test file itself (no
 * `.test.ts` suffix), so vitest does not collect it as a suite.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvApi, LogApi } from "@moku-labs/common";
import { vi } from "vitest";
import type { VideoFile } from "../../../video/contract";
import type { Config, FalContext, RegistryApi, State } from "../../types";

/** Default config fixture, matching `falPlugin`'s own defaults except a 0 ms poll interval. */
export const DEFAULT_CONFIG: Config = {
  apiKeyEnv: "FAL_KEY",
  queueUrl: "https://queue.fal.run",
  uploadUrl: "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3",
  upload: "storage",
  timeoutMs: 60_000,
  priceOverrides: {}
};

/** The fake key every test context resolves (never a real key). */
export const TEST_KEY = "test-fal-key";

/** Builds an in-memory fake mirroring registry's real register/resolve/providers/tasks behavior. */
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
  const values = given ?? { FAL_KEY: TEST_KEY };
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

/** Per-dependency overrides accepted by {@link createTestCtx}. */
export type TestCtxOverrides = {
  config?: Partial<Config>;
  state?: Partial<State>;
  registry?: RegistryApi;
  env?: EnvApi;
  log?: LogApi;
};

/** Builds a fake `FalContext`: default config, uncomputed prices, fake registry/env/log. */
export function createTestCtx(overrides: TestCtxOverrides = {}): FalContext {
  const config: Config = { ...DEFAULT_CONFIG, ...overrides.config };
  // eslint-disable-next-line unicorn/no-null -- State.prices is `X | null`; mirrors createFalState's sentinel
  const state: State = { prices: null, ...overrides.state };
  const registry = overrides.registry ?? createFakeRegistry();
  const env = overrides.env ?? createFakeEnv();
  const log = overrides.log ?? createFakeLog();
  return { config, state, emit: () => undefined, require: () => registry, env, log };
}

/** A real JSON `Response` with the given status, body and headers. */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return Response.json(body, { status, headers });
}

/** A real binary `Response` (e.g. a video download). */
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
export function callsOf(fetchMock: ReturnType<typeof vi.fn>): FetchCall[] {
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
export function stubFetch(...responses: Array<Response | Error>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const response of responses) {
    if (response instanceof Error) fetchMock.mockRejectedValueOnce(response);
    else fetchMock.mockResolvedValueOnce(response);
  }
  fetchMock.mockRejectedValue(new Error("unexpected extra fetch call"));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
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
  const dir = mkdtempSync(path.join(tmpdir(), "moku-fal-"));
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

/** A fal submit response with distinct, non-derivable status/result URLs. */
export function submitResponse(requestId = "req-1"): Response {
  return jsonResponse(200, {
    request_id: requestId,
    status_url: `https://queue.fal.run/custom/requests/${requestId}/status-x`,
    response_url: `https://queue.fal.run/custom/requests/${requestId}/result-x`,
    cancel_url: `https://queue.fal.run/custom/requests/${requestId}/cancel`
  });
}

/** A fal storage-initiate response for file `n`. */
export function initiateResponse(n: number): Response {
  return jsonResponse(200, {
    upload_url: `https://upload.fal.test/put/${n}`,
    file_url: `https://cdn.fal.test/file/${n}`
  });
}

/** An empty 200 response (e.g. the storage PUT). */
export function okResponse(): Response {
  return new Response("", { status: 200 });
}

/** Writes `value` as big-endian bytes of `width` length. */
function bigEndian(value: number, width: number): number[] {
  return Array.from({ length: width }, (_, index) => (value >> (8 * (width - 1 - index))) & 0xff);
}

/** Writes `value` as little-endian bytes of `width` length. */
function littleEndian(value: number, width: number): number[] {
  return Array.from({ length: width }, (_, index) => (value >> (8 * index)) & 0xff);
}

/** ASCII bytes of `text`. */
function asciiBytes(text: string): number[] {
  return [...text].map(char => char.codePointAt(0) ?? 0);
}

/** A PNG header (signature + IHDR) for a `width` x `height` image. */
export function pngHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...bigEndian(13, 4),
    ...asciiBytes("IHDR"),
    ...bigEndian(width, 4),
    ...bigEndian(height, 4),
    8,
    6,
    0,
    0,
    0
  ]);
}

/** A JPEG header with an EXIF APP1 and a DQT segment before the SOF0 marker. */
export function jpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe1,
    ...bigEndian(8, 2),
    ...asciiBytes("Exif"),
    0,
    0,
    0xff,
    0xdb,
    ...bigEndian(4, 2),
    0,
    1,
    0xff,
    0xc0,
    ...bigEndian(17, 2),
    8,
    ...bigEndian(height, 2),
    ...bigEndian(width, 2),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1
  ]);
}

/** A WebP header whose first chunk is `VP8 `, `VP8L` or `VP8X`. */
export function webpHeader(
  kind: "VP8 " | "VP8L" | "VP8X",
  width: number,
  height: number
): Uint8Array {
  const payloads: Record<typeof kind, number[]> = {
    "VP8 ": [0, 0, 0, 0x9d, 0x01, 0x2a, ...littleEndian(width, 2), ...littleEndian(height, 2)],
    VP8L: [0x2f, ...littleEndian((width - 1) | ((height - 1) << 14), 4)],
    VP8X: [0, 0, 0, 0, ...littleEndian(width - 1, 3), ...littleEndian(height - 1, 3)]
  };
  const payload = payloads[kind];
  return new Uint8Array([
    ...asciiBytes("RIFF"),
    ...littleEndian(payload.length + 12, 4),
    ...asciiBytes("WEBP"),
    ...asciiBytes(kind),
    ...littleEndian(payload.length, 4),
    ...payload
  ]);
}
