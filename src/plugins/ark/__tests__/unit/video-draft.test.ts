import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { VideoFile, VideoRequest } from "../../../video/contract";
import { resolveArkModel } from "../../models";
import type { EstimateRequest } from "../../types";
import {
  DRAFT_TTL_MS,
  defaultResolutionOf,
  isDraftTask,
  parseDraftRecord,
  sha256Hex
} from "../../video/draft";
import { buildFinalBody, checkDraftFile, checkFinalRequest } from "../../video/final";
import { createVideoHandler } from "../../video/handler";
import type { FakeJournal, TempFiles } from "../fixtures";
import {
  bytesResponse,
  CREATE_TASK_RESPONSE,
  callsOf,
  createFakeJournal,
  createTempFiles,
  createTestCtx,
  DRAFT_CREATED_MS,
  DRAFT_TASK_ID,
  DRAFT_VIDEO_URL,
  FINAL_TASK_ID,
  FINAL_VIDEO_URL,
  INTL_API_ACCOUNT,
  INTL_TASKS_URL,
  jsonBodyOf,
  jsonResponse,
  LIVE_DRAFT_TASK,
  LIVE_FINAL_TASK,
  LOCAL_IMAGE_BYTES,
  stubFetch
} from "../fixtures";

const MODEL_25 = "dreamina-seedance-2-5-260628";
const MODEL_20 = "dreamina-seedance-2-0-260128";
const MODEL_MINI = "dreamina-seedance-2-0-mini-260615";
const NO_DRAFT_MODE_MINI = `[ai] Model ${MODEL_MINI} has no draft mode.\n  Use ${MODEL_25} for drafts.`;
const DRAFT_CLIP = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 1]);
const FINAL_CLIP = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 2]);
const DRAFT_HASH = createHash("sha256").update(DRAFT_CLIP).digest("hex");
const HOUR_MS = 60 * 60 * 1000;
const model25 = resolveArkModel(MODEL_25, "intl");

let temp: TempFiles;
let draftClip: VideoFile;
let image: VideoFile;

beforeAll(() => {
  temp = createTempFiles();
  draftClip = temp.file("draft.mp4", DRAFT_CLIP, "video/mp4", DRAFT_HASH);
  image = temp.file("key.png", LOCAL_IMAGE_BYTES, "image/png");
});

afterAll(() => {
  temp.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A final request: the 2.5 model and the draft clip. */
function finalRequest(overrides: Partial<VideoRequest> = {}): VideoRequest {
  return { model: MODEL_25, prompt: "", fromDraft: draftClip, ...overrides };
}

/** A fake journal holding the live draft's record under the draft clip's hash. */
function journalWithDraft(record: object = {}): FakeJournal {
  const journal = createFakeJournal();
  const value = {
    taskId: DRAFT_TASK_ID,
    model: MODEL_25,
    seed: 76_282,
    createdAt: DRAFT_CREATED_MS,
    ...record
  };
  journal.putProviderRecords([
    {
      provider: "ark",
      account: INTL_API_ACCOUNT,
      kind: "draft",
      key: DRAFT_HASH,
      value: JSON.stringify(value)
    }
  ]);
  vi.mocked(journal.putProviderRecords).mockClear();
  return journal;
}

/** Freezes `Date.now()` at the given moment. */
function freezeClock(at: number): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
}

/** What a promise rejected with. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

describe("draft helpers", () => {
  it("sha256Hex is the store's content hash", () => {
    expect(sha256Hex(DRAFT_CLIP)).toBe(DRAFT_HASH);
  });

  it("isDraftTask reads draft: true only", () => {
    expect(isDraftTask(LIVE_DRAFT_TASK)).toBe(true);
    expect(isDraftTask(LIVE_FINAL_TASK)).toBe(false);
    expect(isDraftTask(undefined)).toBe(false);
  });

  it("defaultResolutionOf is 1080p for a final, 480p for a draft, else the fallback", () => {
    expect(defaultResolutionOf({ fromDraft: { $ref: "d" } }, "720p")).toBe("1080p");
    expect(defaultResolutionOf({ params: { draft: true } }, "720p")).toBe("480p");
    expect(defaultResolutionOf({}, "720p")).toBe("720p");
  });

  it("parseDraftRecord reads a record and refuses a damaged one", () => {
    expect(parseDraftRecord('{"taskId":"cgt-1","model":"m","seed":7,"createdAt":1}')).toEqual({
      taskId: "cgt-1",
      model: "m",
      seed: 7,
      createdAt: 1
    });
    expect(parseDraftRecord("{not json")).toBeUndefined();
    expect(parseDraftRecord('{"taskId":"cgt-1","model":"m"}')).toBeUndefined();
  });

  it("keeps a draft id valid for 7 days", () => {
    expect(DRAFT_TTL_MS).toBe(604_800_000);
  });
});

describe("final checks (pure)", () => {
  it("builds the exact final body: the draft task only, 1080p, watermark false", () => {
    const model = resolveArkModel(MODEL_25, "intl");
    const checked = checkFinalRequest(model25, {});

    expect(buildFinalBody(model, DRAFT_TASK_ID, checked)).toEqual({
      model: MODEL_25,
      content: [{ type: "draft_task", draft_task: { id: DRAFT_TASK_ID } }],
      resolution: "1080p",
      watermark: false
    });
  });

  it("passes only watermark, return_last_frame, execution_expires_after and priority", () => {
    const checked = checkFinalRequest(model25, {
      params: {
        watermark: true,
        return_last_frame: true,
        execution_expires_after: 3600,
        priority: 1,
        generation: 2
      }
    });
    expect(checked).toEqual({
      resolution: "1080p",
      params: {
        watermark: true,
        return_last_frame: true,
        execution_expires_after: 3600,
        priority: 1
      }
    });
  });

  it("refuses a fromDraft that is not a video (1)", () => {
    expect(() => checkDraftFile(image)).toThrow(
      "[ai] ark input.fromDraft must be the draft's video.\n  Point $ref at the draft item."
    );
  });

  it("refuses frames, refs, refUrls, seed and draft on a final (5)", () => {
    const cases: Array<[Partial<EstimateRequest>, string]> = [
      [{ image }, "input.image"],
      [{ endImage: image }, "input.endImage"],
      [{ refs: [image] }, "input.refs"],
      [{ params: { refUrls: ["https://cdn.example/a.mp4"] } }, "params.refUrls"],
      [{ params: { seed: 7 } }, "params.seed"],
      [{ params: { draft: true } }, "params.draft"]
    ];
    for (const [request, field] of cases) {
      expect(() => checkFinalRequest(model25, request)).toThrow(
        `[ai] ark final renders take only the draft.\n  Remove ${field}.`
      );
    }
  });

  it("refuses an unknown param on a final", () => {
    expect(() => checkFinalRequest(model25, { params: { cfg: 1 } })).toThrow(
      '[ai] Unknown ark param "cfg".'
    );
  });

  it("takes 1080p only, the default (6)", () => {
    expect(checkFinalRequest(model25, { resolution: "1080p" }).resolution).toBe("1080p");
    expect(() => checkFinalRequest(model25, { resolution: "720p" })).toThrow(
      "[ai] ark finals from a draft are 1080p only.\n  Remove input.resolution or set it to 1080p."
    );
  });
});

describe("estimate: draft and final", () => {
  it("prices a draft at 480p with the 2.5 base price", () => {
    const handler = createVideoHandler(createTestCtx());
    expect(handler.estimate({ model: MODEL_25, prompt: "p", params: { draft: true } })).toEqual({
      usd: 0.541_827
    });
  });

  it("prices an unresolved final at 1080p with price1080, for 5 s or its seconds", () => {
    const handler = createVideoHandler(createTestCtx());
    const final: EstimateRequest = { model: MODEL_25, prompt: "", fromDraft: { $ref: "draft" } };

    expect(handler.estimate(final)).toEqual({ usd: 2.866_793 });
    expect(handler.estimate({ ...final, seconds: 10 })).toEqual({ usd: 5.709_893 });
  });

  it("fails at plan time for a final on a model without a draft mode (mini), with no fetch", () => {
    const fetchMock = stubFetch();
    const handler = createVideoHandler(createTestCtx());
    const final: EstimateRequest = { model: MODEL_MINI, prompt: "", fromDraft: { $ref: "d" } };

    expect(() => handler.estimate(final)).toThrow(NO_DRAFT_MODE_MINI);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails at plan time for a draft the model cannot make or a final at 720p", () => {
    const handler = createVideoHandler(createTestCtx());

    expect(() =>
      handler.estimate({ model: MODEL_20, prompt: "p", params: { draft: true } })
    ).toThrow("has no draft mode.");
    expect(() =>
      handler.estimate({
        model: MODEL_25,
        prompt: "",
        fromDraft: { $ref: "d" },
        resolution: "720p"
      })
    ).toThrow("finals from a draft are 1080p only.");
  });
});

describe("submit a final from a draft", () => {
  it("POSTs the exact draft-task body, never the prompt", async () => {
    freezeClock(DRAFT_CREATED_MS + HOUR_MS);
    const fetchMock = stubFetch(jsonResponse(200, { id: FINAL_TASK_ID }));
    const ctx = createTestCtx({ journal: journalWithDraft() });

    const result = await createVideoHandler(ctx).submit(
      finalRequest({ prompt: "ignored", seconds: 12, aspect: "16:9", audio: false }),
      {}
    );

    expect(result).toEqual({ jobId: FINAL_TASK_ID });
    const [call] = callsOf(fetchMock);
    expect(call?.url).toBe(INTL_TASKS_URL);
    expect(jsonBodyOf(call)).toEqual({
      model: MODEL_25,
      content: [{ type: "draft_task", draft_task: { id: DRAFT_TASK_ID } }],
      resolution: "1080p",
      watermark: false
    });
    expect(ctx.journal.findProviderRecord).toHaveBeenCalledWith({
      provider: "ark",
      account: INTL_API_ACCOUNT,
      kind: "draft",
      key: DRAFT_HASH
    });
  });

  it("fails before any fetch for each broken rule", async () => {
    freezeClock(DRAFT_CREATED_MS + HOUR_MS);
    const cases: Array<[VideoRequest, string]> = [
      [
        finalRequest({ fromDraft: image }),
        "[ai] ark input.fromDraft must be the draft's video.\n  Point $ref at the draft item."
      ],
      [
        finalRequest({ fromDraft: { ...draftClip, hash: "0".repeat(64) } }),
        "[ai] ark has no draft task for input.fromDraft.\n  Make the draft with provider ark and params.draft: true, in this project."
      ],
      [
        finalRequest({ model: MODEL_20 }),
        `[ai] Model ${MODEL_20} has no draft mode.\n  Use ${MODEL_25} for drafts.`
      ],
      [
        finalRequest({ image }),
        "[ai] ark final renders take only the draft.\n  Remove input.image."
      ],
      [
        finalRequest({ resolution: "480p" }),
        "[ai] ark finals from a draft are 1080p only.\n  Remove input.resolution or set it to 1080p."
      ]
    ];
    for (const [request, message] of cases) {
      const fetchMock = stubFetch();
      const handler = createVideoHandler(createTestCtx({ journal: journalWithDraft() }));

      const error = await rejectionOf(handler.submit(request, {}));

      expect(error.message).toBe(message);
      expect(error.constructor).toBe(Error);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("fails before any fetch for a draft made with another model", async () => {
    freezeClock(DRAFT_CREATED_MS + HOUR_MS);
    const fetchMock = stubFetch();
    const otherModel = "dreamina-seedance-2-5-250101";
    const journal = journalWithDraft({ model: otherModel });

    const error = await rejectionOf(
      createVideoHandler(createTestCtx({ journal })).submit(finalRequest(), {})
    );

    expect(error.message).toBe(
      `[ai] Draft ${DRAFT_TASK_ID} was made with ${otherModel}.\n  Set input.model to ${otherModel}.`
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a final on a model without a draft mode (mini), with no fetch", async () => {
    freezeClock(DRAFT_CREATED_MS + HOUR_MS);
    const fetchMock = stubFetch();
    const handler = createVideoHandler(createTestCtx({ journal: journalWithDraft() }));

    const error = await rejectionOf(handler.submit(finalRequest({ model: MODEL_MINI }), {}));

    expect(error.message).toBe(NO_DRAFT_MODE_MINI);
    expect(error.constructor).toBe(Error);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails on a draft 7 days old, naming the expiry date, with no fetch (4)", async () => {
    freezeClock(DRAFT_CREATED_MS + DRAFT_TTL_MS);
    const fetchMock = stubFetch();
    const handler = createVideoHandler(createTestCtx({ journal: journalWithDraft() }));

    const error = await rejectionOf(handler.submit(finalRequest(), {}));

    expect(error.message).toBe(
      `[ai] ark draft ${DRAFT_TASK_ID} expired on 2026-10-07T09:10:42.000Z.\n  Bump params.generation on the draft item to render it again.`
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still takes a draft one second before it expires", async () => {
    freezeClock(DRAFT_CREATED_MS + DRAFT_TTL_MS - 1000);
    stubFetch(jsonResponse(200, { id: FINAL_TASK_ID }));
    const handler = createVideoHandler(createTestCtx({ journal: journalWithDraft() }));

    await expect(handler.submit(finalRequest(), {})).resolves.toEqual({ jobId: FINAL_TASK_ID });
  });

  it("fails before any fetch when the journal is closed", async () => {
    const fetchMock = stubFetch();
    const journal = journalWithDraft();
    journal.open = false;

    const error = await rejectionOf(
      createVideoHandler(createTestCtx({ journal })).submit(finalRequest(), {})
    );

    expect(error.message).toBe(
      "[ai] ark needs the journal to find a draft.\n  Call app.start() first."
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not find a draft made with another API key", async () => {
    freezeClock(DRAFT_CREATED_MS + HOUR_MS);
    stubFetch();
    const ctx = createTestCtx({
      journal: journalWithDraft(),
      config: { apiKeyEnv: "OTHER_ARK_KEY" }
    });
    ctx.env = { ...ctx.env, require: () => "another-key" };

    const error = await rejectionOf(createVideoHandler(ctx).submit(finalRequest(), {}));

    expect(error.message).toContain("[ai] ark has no draft task for input.fromDraft.");
  });
});

describe("poll: draft record and meta", () => {
  it("records a done draft by its clip's sha256 and returns the draft meta", async () => {
    stubFetch(jsonResponse(200, LIVE_DRAFT_TASK), bytesResponse(DRAFT_CLIP));
    const ctx = createTestCtx();
    const draft = { model: MODEL_25, prompt: "p", image, params: { draft: true } };

    const result = await createVideoHandler(ctx).poll(DRAFT_TASK_ID, draft, {});

    expect(result).toEqual({
      state: "done",
      video: DRAFT_CLIP,
      mimeType: "video/mp4",
      costUsd: 0.518_276,
      meta: {
        taskId: DRAFT_TASK_ID,
        model: MODEL_25,
        seconds: 5,
        resolution: "480p",
        completionTokens: 48_437,
        seed: 76_282,
        draft: true
      }
    });
    expect(ctx.journal.putProviderRecords).toHaveBeenCalledWith([
      {
        provider: "ark",
        account: INTL_API_ACCOUNT,
        kind: "draft",
        key: DRAFT_HASH,
        value: JSON.stringify({
          taskId: DRAFT_TASK_ID,
          model: MODEL_25,
          seed: 76_282,
          createdAt: DRAFT_CREATED_MS
        })
      }
    ]);
    expect(ctx.log.info).toHaveBeenCalledWith("ark:draft:recorded", { taskId: DRAFT_TASK_ID });
  });

  it("dates a draft without created_at from the poll time", async () => {
    freezeClock(DRAFT_CREATED_MS + HOUR_MS);
    const undated: Record<string, unknown> = { ...LIVE_DRAFT_TASK };
    delete undated.created_at;
    stubFetch(jsonResponse(200, undated), bytesResponse(DRAFT_CLIP));
    const journal = createFakeJournal();
    const draft = { model: MODEL_25, prompt: "p", params: { draft: true } };

    await createVideoHandler(createTestCtx({ journal })).poll(DRAFT_TASK_ID, draft, {});

    const [value] = [...journal.records.values()];
    expect(parseDraftRecord(value ?? "")).toMatchObject({ createdAt: DRAFT_CREATED_MS + HOUR_MS });
  });

  it("writes the same record again on a re-poll", async () => {
    stubFetch(
      jsonResponse(200, LIVE_DRAFT_TASK),
      bytesResponse(DRAFT_CLIP),
      jsonResponse(200, LIVE_DRAFT_TASK),
      bytesResponse(DRAFT_CLIP)
    );
    const journal = createFakeJournal();
    const handler = createVideoHandler(createTestCtx({ journal }));
    const draft = { model: MODEL_25, prompt: "p", params: { draft: true } };

    await handler.poll(DRAFT_TASK_ID, draft, {});
    await handler.poll(DRAFT_TASK_ID, draft, {});

    const [first, second] = vi.mocked(journal.putProviderRecords).mock.calls;
    expect(second).toEqual(first);
    expect(journal.records.size).toBe(1);
  });

  it("skips the record when the journal is closed, warns once, and still returns the clip", async () => {
    stubFetch(
      jsonResponse(200, LIVE_DRAFT_TASK),
      bytesResponse(DRAFT_CLIP),
      jsonResponse(200, LIVE_DRAFT_TASK),
      bytesResponse(DRAFT_CLIP)
    );
    const journal = createFakeJournal(false);
    const ctx = createTestCtx({ journal });
    const handler = createVideoHandler(ctx);
    const draft = { model: MODEL_25, prompt: "p", params: { draft: true } };

    const result = await handler.poll(DRAFT_TASK_ID, draft, {});
    await handler.poll(DRAFT_TASK_ID, draft, {});

    expect(result).toMatchObject({ state: "done", video: DRAFT_CLIP });
    expect(journal.putProviderRecords).not.toHaveBeenCalled();
    const closed = vi
      .mocked(ctx.log.warn)
      .mock.calls.filter(([event]) => event === "ark:journal:closed");
    expect(closed).toEqual([["ark:journal:closed", { taskId: DRAFT_TASK_ID }]]);
    expect(ctx.state.journalSkipLogged).toBe(true);
  });

  it("prices a done final at 1080p with price1080 and names its draft task", async () => {
    const fetchMock = stubFetch(jsonResponse(200, LIVE_FINAL_TASK), bytesResponse(FINAL_CLIP));
    const ctx = createTestCtx();

    const result = await createVideoHandler(ctx).poll(FINAL_TASK_ID, finalRequest(), {});

    expect(result).toEqual({
      state: "done",
      video: FINAL_CLIP,
      mimeType: "video/mp4",
      costUsd: 2.866_793,
      meta: {
        taskId: FINAL_TASK_ID,
        model: MODEL_25,
        seconds: 5,
        resolution: "1080p",
        completionTokens: 245_025,
        seed: 76_282,
        draftTaskId: DRAFT_TASK_ID
      }
    });
    expect(callsOf(fetchMock)[1]?.url).toBe(FINAL_VIDEO_URL);
    expect(ctx.journal.putProviderRecords).not.toHaveBeenCalled();
  });

  it("downloads the live draft clip from its content URL", async () => {
    const fetchMock = stubFetch(jsonResponse(200, LIVE_DRAFT_TASK), bytesResponse(DRAFT_CLIP));

    await createVideoHandler(createTestCtx()).poll(
      DRAFT_TASK_ID,
      { model: MODEL_25, prompt: "p", params: { draft: true } },
      {}
    );

    expect(callsOf(fetchMock)[1]?.url).toBe(DRAFT_VIDEO_URL);
  });
});

describe("submit a draft", () => {
  it("POSTs draft: true at 480p with no ratio for 2.5 with a first frame", async () => {
    const fetchMock = stubFetch(jsonResponse(200, CREATE_TASK_RESPONSE));

    await createVideoHandler(createTestCtx()).submit(
      { model: MODEL_25, prompt: "p", image, aspect: "9:16", params: { draft: true } },
      {}
    );

    const body = jsonBodyOf(callsOf(fetchMock)[0]) as Record<string, unknown>;
    expect(body).toMatchObject({ model: MODEL_25, resolution: "480p", draft: true });
    expect(body).not.toHaveProperty("ratio");
  });

  it("logs ark:ratio:ignored once when an explicit aspect cannot be honoured", async () => {
    stubFetch(jsonResponse(200, CREATE_TASK_RESPONSE), jsonResponse(200, CREATE_TASK_RESPONSE));
    const ctx = createTestCtx();
    const handler = createVideoHandler(ctx);
    const request = { model: MODEL_25, prompt: "p", image, aspect: "16:9" };

    await handler.submit(request, {});
    await handler.submit(request, {});

    const ignored = vi
      .mocked(ctx.log.warn)
      .mock.calls.filter(([event]) => event === "ark:ratio:ignored");
    expect(ignored).toEqual([["ark:ratio:ignored", { model: MODEL_25 }]]);
  });
});
