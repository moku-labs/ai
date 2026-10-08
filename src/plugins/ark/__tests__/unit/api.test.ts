import { describe, expect, it } from "vitest";
import { createArkApi } from "../../api";
import { modelsOf } from "../../models";
import { recordDraft, sha256Hex } from "../../video/draft";
import type { FakeJournal } from "../fixtures";
import {
  createFakeEnv,
  createFakeJournal,
  createTestCtx,
  DRAFT_CREATED_MS,
  DRAFT_TASK_ID,
  INTL_API_ACCOUNT,
  LIVE_DRAFT_TASK,
  loggedText,
  TEST_ACCESS_KEY,
  TEST_API_KEY
} from "../fixtures";

const DRAFT_MODEL = "dreamina-seedance-2-5-260628";
const DRAFT_CLIP = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 1]);
const DRAFT_HASH = sha256Hex(DRAFT_CLIP);

/** The record of the live draft, as the provider writes it. */
const LIVE_DRAFT_RECORD = {
  taskId: DRAFT_TASK_ID,
  model: DRAFT_MODEL,
  seed: LIVE_DRAFT_TASK.seed,
  createdAt: DRAFT_CREATED_MS,
  withVideoInput: false
};

/** A fake journal holding the live draft, written through the provider's own write path. */
function journalWithDraft(): FakeJournal {
  const journal = createFakeJournal();
  recordDraft(
    createTestCtx({ journal }),
    DRAFT_TASK_ID,
    LIVE_DRAFT_TASK,
    DRAFT_MODEL,
    DRAFT_CLIP,
    false
  );
  return journal;
}

describe("createArkApi().info()", () => {
  it("reports region, both key sets configured and the region's models", () => {
    const api = createArkApi(createTestCtx());

    expect(api.info()).toEqual({
      provider: "ark",
      region: "intl",
      configured: { video: true, assets: true, image: true },
      models: modelsOf("intl"),
      imageModels: ["seedream-5-0-lite-260128"]
    });
    expect(api.info().models).toEqual([
      "dreamina-seedance-2-0-260128",
      "dreamina-seedance-2-0-fast-260128",
      "dreamina-seedance-2-0-mini-260615",
      "dreamina-seedance-2-5-260628"
    ]);
  });

  it("reports nothing configured, without throwing, when no key is set", () => {
    const api = createArkApi(createTestCtx({ env: createFakeEnv({}) }));
    expect(api.info().configured).toEqual({ video: false, assets: false, image: false });
  });

  it("reports images configured with the API key alone", () => {
    const api = createArkApi(createTestCtx({ env: createFakeEnv({ ARK_API_KEY: TEST_API_KEY }) }));
    expect(api.info().configured).toEqual({ video: true, assets: false, image: true });
  });

  it("needs both the access key and the secret key for assets", () => {
    const api = createArkApi(
      createTestCtx({
        env: createFakeEnv({ ARK_API_KEY: TEST_API_KEY, ARK_ACCESS_KEY: TEST_ACCESS_KEY })
      })
    );
    expect(api.info().configured).toEqual({ video: true, assets: false, image: true });
  });

  it("treats an empty variable as not set", () => {
    const api = createArkApi(createTestCtx({ env: createFakeEnv({ ARK_API_KEY: "" }) }));
    expect(api.info().configured.video).toBe(false);
  });

  it("reads the configured env var names and lists only cn models on cn", () => {
    const ctx = createTestCtx({
      config: { region: "cn", apiKeyEnv: "VOLC_ARK_KEY" },
      env: createFakeEnv({ VOLC_ARK_KEY: "k" })
    });

    const info = createArkApi(ctx).info();

    expect(info.region).toBe("cn");
    expect(info.configured.video).toBe(true);
    expect(info.models).toEqual(modelsOf("cn"));
    expect(info.models).toEqual(["doubao-seedance-2-0-260128", "doubao-seedance-2-5-260628"]);
    expect(info.imageModels).toEqual([]);
  });
});

describe("createArkApi().draftRecord()", () => {
  it("returns the record the provider wrote, by the clip's sha256, with no log line", () => {
    const journal = journalWithDraft();
    const ctx = createTestCtx({ journal });

    const record = createArkApi(ctx).draftRecord(DRAFT_HASH);

    expect(record).toEqual(LIVE_DRAFT_RECORD);
    expect(loggedText(ctx)).toBe("[]");
  });

  it("reads under the account the write path used", () => {
    const journal = journalWithDraft();

    createArkApi(createTestCtx({ journal })).draftRecord(DRAFT_HASH);

    const row = { provider: "ark", account: INTL_API_ACCOUNT, kind: "draft", key: DRAFT_HASH };
    expect(journal.putProviderRecords).toHaveBeenCalledWith([
      { ...row, value: JSON.stringify(LIVE_DRAFT_RECORD) }
    ]);
    expect(journal.findProviderRecord).toHaveBeenCalledWith(row);
  });

  it.each([
    ["no API key", {}],
    ["an empty API key", { ARK_API_KEY: "" }]
  ])("returns undefined with %s, without throwing or reading the journal", (_label, values) => {
    const journal = journalWithDraft();
    const api = createArkApi(createTestCtx({ journal, env: createFakeEnv(values) }));

    expect(api.draftRecord(DRAFT_HASH)).toBeUndefined();
    expect(journal.findProviderRecord).not.toHaveBeenCalled();
  });

  it("returns undefined while the journal is closed, without reading it", () => {
    const journal = createFakeJournal(false);
    const api = createArkApi(createTestCtx({ journal }));

    expect(api.draftRecord(DRAFT_HASH)).toBeUndefined();
    expect(journal.findProviderRecord).not.toHaveBeenCalled();
  });

  it("returns undefined for a draft whose journal was closed after the write", () => {
    const journal = journalWithDraft();
    journal.open = false;

    expect(createArkApi(createTestCtx({ journal })).draftRecord(DRAFT_HASH)).toBeUndefined();
    expect(journal.findProviderRecord).not.toHaveBeenCalled();
  });

  it("returns undefined for a hash with no record", () => {
    const api = createArkApi(createTestCtx({ journal: journalWithDraft() }));
    expect(api.draftRecord("0".repeat(64))).toBeUndefined();
  });

  it("returns undefined for a damaged stored value", () => {
    const journal = createFakeJournal();
    const row = { provider: "ark", account: INTL_API_ACCOUNT, kind: "draft", key: DRAFT_HASH };
    journal.putProviderRecords([{ ...row, value: "{not json" }]);
    const api = createArkApi(createTestCtx({ journal }));

    expect(api.draftRecord(DRAFT_HASH)).toBeUndefined();

    journal.putProviderRecords([{ ...row, value: '{"taskId":"cgt-1","model":"m"}' }]);
    expect(api.draftRecord(DRAFT_HASH)).toBeUndefined();
  });

  it("does not find a draft made with another API key", () => {
    const journal = journalWithDraft();
    const env = createFakeEnv({ ARK_API_KEY: "another-ark-api-key" });

    expect(createArkApi(createTestCtx({ journal, env })).draftRecord(DRAFT_HASH)).toBeUndefined();
    expect(journal.findProviderRecord).toHaveBeenCalledTimes(1);
  });

  it("does not find a draft made in another region", () => {
    const journal = journalWithDraft();
    const ctx = createTestCtx({ journal, config: { region: "cn" } });

    expect(createArkApi(ctx).draftRecord(DRAFT_HASH)).toBeUndefined();
    expect(journal.findProviderRecord).toHaveBeenCalledTimes(1);
  });
});
