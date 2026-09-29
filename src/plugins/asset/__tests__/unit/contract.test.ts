import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ASSET_MIME,
  type AssetHandler,
  type AssetRecord,
  type AssetRequest,
  type AssetResult,
  encodeAssetRecord,
  parseAssetRecord
} from "../../contract";

// ---------------------------------------------------------------------------
// asset contract: ASSET_MIME, encode/parse of the stored AssetRecord artifact
// ---------------------------------------------------------------------------

const EXPECTED = "Expected JSON with assetId, provider, account, groupId, registeredAt.";

const record: AssetRecord = {
  assetId: "asset-20260929-a1",
  provider: "ark",
  account: "3f9a0c1b2d4e",
  groupId: "group-7",
  registeredAt: 1_790_000_000_000
};

/**
 * UTF-8 bytes of a JSON text.
 *
 * @param text - Any text.
 * @returns The encoded bytes.
 * @example
 * ```ts
 * bytesOf('{"a":1}');
 * ```
 */
function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * The pinned two-line parse error for `reason`.
 *
 * @param reason - The first-line reason.
 * @returns The full error message.
 * @example
 * ```ts
 * notARecord("invalid JSON");
 * ```
 */
function notARecord(reason: string): string {
  return `[ai] Not an asset record: ${reason}.\n  ${EXPECTED}`;
}

describe("asset contract", () => {
  it("names the asset MIME", () => {
    expect(ASSET_MIME).toBe("application/vnd.moku.asset+json");
  });

  describe("encodeAssetRecord / parseAssetRecord", () => {
    it("round-trips a record", () => {
      expect(parseAssetRecord(encodeAssetRecord(record))).toStrictEqual(record);
    });

    it("writes UTF-8 JSON in a stable key order", () => {
      const shuffled: AssetRecord = {
        registeredAt: record.registeredAt,
        groupId: record.groupId,
        account: record.account,
        provider: record.provider,
        assetId: record.assetId
      };

      const text = new TextDecoder().decode(encodeAssetRecord(shuffled));

      expect(text).toBe(
        '{"assetId":"asset-20260929-a1","provider":"ark","account":"3f9a0c1b2d4e","groupId":"group-7","registeredAt":1790000000000}'
      );
      expect(encodeAssetRecord(shuffled)).toStrictEqual(encodeAssetRecord(record));
    });

    it("drops keys that are not part of the record", () => {
      const bytes = encodeAssetRecord({ ...record, extra: "x" } as AssetRecord);
      const parsed = parseAssetRecord(bytesOf(JSON.stringify({ ...record, extra: "x" })));

      expect(new TextDecoder().decode(bytes)).not.toContain("extra");
      expect(parsed).toStrictEqual(record);
    });

    it("rejects bytes that are not JSON", () => {
      expect(() => parseAssetRecord(bytesOf("png:not json"))).toThrow(notARecord("invalid JSON"));
    });

    it("rejects JSON that is not an object", () => {
      expect(() => parseAssetRecord(bytesOf("[1,2]"))).toThrow(notARecord("not a JSON object"));
      expect(() => parseAssetRecord(bytesOf("null"))).toThrow(notARecord("not a JSON object"));
      expect(() => parseAssetRecord(bytesOf("42"))).toThrow(notARecord("not a JSON object"));
    });

    it("rejects a record with a missing field", () => {
      const withoutProvider = JSON.stringify({ ...record, provider: undefined });

      expect(() => parseAssetRecord(bytesOf(withoutProvider))).toThrow(
        notARecord('missing "provider"')
      );
      expect(() => parseAssetRecord(bytesOf("{}"))).toThrow(notARecord('missing "assetId"'));
      expect(() =>
        parseAssetRecord(bytesOf(JSON.stringify({ ...record, registeredAt: undefined })))
      ).toThrow(notARecord('missing "registeredAt"'));
    });

    it("rejects a field with the wrong type", () => {
      const numericId = JSON.stringify({ ...record, assetId: 7 });
      const emptyAccount = JSON.stringify({ ...record, account: "" });
      const textTime = JSON.stringify({ ...record, registeredAt: "yesterday" });

      expect(() => parseAssetRecord(bytesOf(numericId))).toThrow(
        notARecord('"assetId" must be a non-empty string')
      );
      expect(() => parseAssetRecord(bytesOf(emptyAccount))).toThrow(
        notARecord('"account" must be a non-empty string')
      );
      expect(() => parseAssetRecord(bytesOf(textTime))).toThrow(
        notARecord('"registeredAt" must be a finite number')
      );
    });
  });

  describe("types", () => {
    it("pins AssetResult.mimeType to the asset MIME", () => {
      expectTypeOf<AssetResult["mimeType"]>().toEqualTypeOf<"application/vnd.moku.asset+json">();
      expectTypeOf<AssetResult["body"]>().toEqualTypeOf<Uint8Array>();
    });

    it("accepts only the aigc group", () => {
      const image = { path: "refs/mira.png", mimeType: "image/png", hash: "a".repeat(64) };
      const aigc: AssetRequest = { image, group: "aigc" };
      // @ts-expect-error -- "liveness" is a non-goal: only "aigc" is a group kind
      const liveness: AssetRequest = { image, group: "liveness" };
      expect([aigc.group, liveness.group]).toEqual(["aigc", "liveness"]);
    });

    it("requires submit and poll on a handler", () => {
      expectTypeOf<AssetHandler["submit"]>().returns.resolves.toEqualTypeOf<{ jobId: string }>();
      // @ts-expect-error -- an asset handler registers asynchronously: submit + poll are required
      const partial: AssetHandler = { estimate: () => ({ usd: 0 }) };
      expect(partial).toBeDefined();
    });
  });
});
