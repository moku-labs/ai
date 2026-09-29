import { describe, expect, it } from "vitest";
import type { SignInput } from "../../sign";
import { canonicalQuery, canonicalRequest, signRequest, xDateOf } from "../../sign";

// Golden values: computed once by an independent port of the Volcengine signing sample
// (https://www.volcengine.com/docs/6369/67269) and pinned here.
const BODY_HASH = "908d4d5d3282f46918bd821ab9a976afe3bf8f49b8b44740b5f358f5a5e9025a";
const GOLDEN_HEADER =
  "HMAC-SHA256 Credential=AKLTtestaccesskey/20260929/ap-southeast-1/ark/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=dfb90698609a06c9c0bf1304cdff3c99b46924a7af183a2dd42638f721912906";
const CANONICAL = [
  "POST",
  "/",
  "Action=GetAsset&Version=2024-01-01",
  "content-type:application/json",
  "host:ark.ap-southeast-1.byteplusapi.com",
  `x-content-sha256:${BODY_HASH}`,
  "x-date:20260929T120000Z",
  "",
  "content-type;host;x-content-sha256;x-date",
  BODY_HASH
].join("\n");

const BASE: SignInput = {
  method: "POST",
  url: "https://ark.ap-southeast-1.byteplusapi.com/?Version=2024-01-01&Action=GetAsset",
  body: '{"Id":"asset-20260929-a1"}',
  accessKey: "AKLTtestaccesskey",
  secretKey: "testsecretkey==",
  region: "ap-southeast-1",
  service: "ark",
  now: new Date("2026-09-29T12:00:00.000Z")
};

describe("signRequest", () => {
  it("produces the pinned headers for a fixed now, keys and body", () => {
    expect(signRequest(BASE)).toEqual({
      "Content-Type": "application/json",
      Host: "ark.ap-southeast-1.byteplusapi.com",
      "X-Date": "20260929T120000Z",
      "X-Content-Sha256": BODY_HASH,
      Authorization: GOLDEN_HEADER
    });
  });

  it("changes X-Content-Sha256 and the signature when the body changes", () => {
    const headers = signRequest({ ...BASE, body: '{"Id":"asset-20260929-a2"}' });

    expect(headers["X-Content-Sha256"]).toBe(
      "14090cd8d7cd8197b470cce081fdf39cb9fa5e1e4d3185f287fdc6f0d845af2d"
    );
    expect(headers.Authorization).toBe(
      "HMAC-SHA256 Credential=AKLTtestaccesskey/20260929/ap-southeast-1/ark/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=e1469ea66833ab1713f0b5db8f2dcc3bc22efad3f8d3cfbd30103ce2a5eabc34"
    );
  });

  it("signs the same whatever order the query is written in", () => {
    const sorted = signRequest({
      ...BASE,
      url: "https://ark.ap-southeast-1.byteplusapi.com/?Action=GetAsset&Version=2024-01-01"
    });
    expect(sorted.Authorization).toBe(GOLDEN_HEADER);
  });

  it("puts the sign region and service in the credential scope", () => {
    const headers = signRequest({
      ...BASE,
      url: "https://open.volcengineapi.com/?Action=GetAsset&Version=2024-01-01",
      region: "cn-beijing"
    });
    expect(headers.Host).toBe("open.volcengineapi.com");
    expect(headers.Authorization).toContain(
      "Credential=AKLTtestaccesskey/20260929/cn-beijing/ark/request,"
    );
    expect(headers.Authorization).not.toBe(GOLDEN_HEADER);
  });

  it("never puts the secret key in a header", () => {
    expect(JSON.stringify(signRequest(BASE))).not.toContain("testsecretkey");
  });
});

describe("canonical parts", () => {
  it("builds the canonical request: method, path, sorted query, headers in order, signed headers, body hash", () => {
    expect(canonicalRequest("POST", new URL(BASE.url), "20260929T120000Z", BODY_HASH)).toBe(
      CANONICAL
    );
  });

  it("sorts the query by key and encodes keys and values per RFC 3986", () => {
    expect(canonicalQuery(new URL("https://h.example/?b=a b&a=x*y&c=%7E"))).toBe(
      "a=x%2Ay&b=a%20b&c=~"
    );
  });

  it("orders repeated keys by value", () => {
    expect(canonicalQuery(new URL("https://h.example/?a=2&b=0&a=1&a=1"))).toBe("a=1&a=1&a=2&b=0");
  });

  it("percent-encodes the characters encodeURIComponent leaves", () => {
    expect(canonicalQuery(new URL("https://h.example/?q=!'()"))).toBe("q=%21%27%28%29");
  });

  it("gives an empty query for a URL without one", () => {
    expect(canonicalQuery(new URL("https://h.example/"))).toBe("");
  });

  it("formats X-Date as YYYYMMDD'T'HHMMSS'Z' in UTC", () => {
    expect(xDateOf(new Date("2026-01-02T03:04:05.678Z"))).toBe("20260102T030405Z");
  });
});
