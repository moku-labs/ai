/**
 * @file ark request signer — HMAC-SHA256 over a canonical request, the
 * signature the Ark asset OpenAPI (BytePlus and Volcengine) takes. A
 * stateless module on `node:crypto`; `now` is injected so the signature is
 * deterministic in tests.
 * @see https://www.volcengine.com/docs/6369/67269
 */
import { createHash, createHmac } from "node:crypto";

/**
 * Everything one signature needs.
 *
 * @example
 * ```ts
 * const input: SignInput = {
 *   method: "POST", url: "https://open.volcengineapi.com/?Action=GetAsset&Version=2024-01-01",
 *   body: '{"Id":"asset-1"}', accessKey: "AK", secretKey: "SK", region: "cn-beijing", service: "ark", now: new Date()
 * };
 * ```
 */
export type SignInput = {
  /** HTTP method. */
  method: string;
  /** Absolute URL, query included. */
  url: string;
  /** The exact body text that is sent. */
  body: string;
  /** Access key id; it appears in the credential. */
  accessKey: string;
  /** Secret access key; it only derives the signing key and never leaves this module. */
  secretKey: string;
  /** Region of the credential scope, e.g. "ap-southeast-1". */
  region: string;
  /** Service of the credential scope, "ark". */
  service: string;
  /** Signing time. */
  now: Date;
};

/**
 * The headers of a signed request.
 *
 * @example
 * ```ts
 * const headers: SignedHeaders = {
 *   "Content-Type": "application/json", Host: "open.volcengineapi.com", "X-Date": "20260929T120000Z",
 *   "X-Content-Sha256": "908d...", Authorization: "HMAC-SHA256 Credential=AK/20260929/cn-beijing/ark/request, ..."
 * };
 * ```
 */
export type SignedHeaders = {
  /** Always "application/json". */
  "Content-Type": string;
  /** Host of the URL. */
  Host: string;
  /** Signing time, `YYYYMMDD'T'HHMMSS'Z'`. */
  "X-Date": string;
  /** Hex sha256 of the body. */
  "X-Content-Sha256": string;
  /** `HMAC-SHA256 Credential=..., SignedHeaders=..., Signature=...`. */
  Authorization: string;
};

/** Signature algorithm name. */
const ALGORITHM = "HMAC-SHA256";

/** The signed headers, lowercase and sorted. */
const SIGNED_HEADER_NAMES = "content-type;host;x-content-sha256;x-date";

/** Content type of every signed call. */
const CONTENT_TYPE = "application/json";

/** Last element of the credential scope. */
const SCOPE_TERMINATOR = "request";

/**
 * Hex sha256 of a text.
 *
 * @param text - UTF-8 text.
 * @returns 64 hex characters.
 * @example
 * ```ts
 * sha256Hex(""); // => "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
 * ```
 */
function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * HMAC-SHA256 of a text under a key.
 *
 * @param key - The key.
 * @param text - UTF-8 text.
 * @returns The raw digest.
 * @example
 * ```ts
 * hmac("key", "text").length; // => 32
 * ```
 */
function hmac(key: string | Buffer, text: string): Buffer {
  return createHmac("sha256", key).update(text, "utf8").digest();
}

/**
 * RFC 3986 percent-encoding: `encodeURIComponent` plus `!'()*`.
 *
 * @param text - A query key or value.
 * @returns The encoded text.
 * @example
 * ```ts
 * encodeRfc3986("a b*"); // => "a%20b%2A"
 * ```
 */
function encodeRfc3986(text: string): string {
  return encodeURIComponent(text).replaceAll(
    /[!'()*]/g,
    char => `%${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()}`
  );
}

/**
 * Orders two encoded query pairs by key, then by value, in code-unit order.
 *
 * @param a - First pair.
 * @param b - Second pair.
 * @returns Negative, zero or positive.
 * @example
 * ```ts
 * comparePairs(["Action", "x"], ["Version", "y"]); // => -1
 * ```
 */
function comparePairs(a: readonly [string, string], b: readonly [string, string]): number {
  const [keyA, valueA] = a;
  const [keyB, valueB] = b;
  if (keyA !== keyB) return keyA < keyB ? -1 : 1;
  if (valueA === valueB) return 0;
  return valueA < valueB ? -1 : 1;
}

/**
 * The signing time as `YYYYMMDD'T'HHMMSS'Z'` in UTC.
 *
 * @param now - The signing time.
 * @returns The X-Date value.
 * @example
 * ```ts
 * xDateOf(new Date("2026-01-02T03:04:05.678Z")); // => "20260102T030405Z"
 * ```
 */
export function xDateOf(now: Date): string {
  return now
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/**
 * The canonical query: pairs sorted by key (then value), keys and values
 * RFC 3986-encoded, joined with `&`.
 *
 * @param url - The request URL.
 * @returns The canonical query, empty when the URL has none.
 * @example
 * ```ts
 * canonicalQuery(new URL("https://h.example/?Version=2024-01-01&Action=GetAsset")); // => "Action=GetAsset&Version=2024-01-01"
 * ```
 */
export function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .toSorted(comparePairs)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

/**
 * The canonical request: method, path, canonical query, the four canonical
 * headers in sorted order (each `name:value`), an empty line, the signed
 * header names, and the body hash.
 *
 * @param method - HTTP method.
 * @param url - The request URL.
 * @param xDate - The X-Date value.
 * @param bodyHash - Hex sha256 of the body.
 * @returns The canonical request text.
 * @example
 * ```ts
 * canonicalRequest("POST", new URL("https://h.example/?A=1"), "20260929T120000Z", "e3b0...").split("\n")[2]; // => "A=1"
 * ```
 */
export function canonicalRequest(
  method: string,
  url: URL,
  xDate: string,
  bodyHash: string
): string {
  return [
    method.toUpperCase(),
    url.pathname,
    canonicalQuery(url),
    `content-type:${CONTENT_TYPE}`,
    `host:${url.host}`,
    `x-content-sha256:${bodyHash}`,
    `x-date:${xDate}`,
    "",
    SIGNED_HEADER_NAMES,
    bodyHash
  ].join("\n");
}

/**
 * Signs one request and returns the headers to send with it. The signing
 * key is `HMAC(HMAC(HMAC(HMAC(secret, date), region), service), "request")`;
 * the signature is the hex HMAC of the string to sign under it.
 *
 * @param input - Method, URL, body, keys, credential scope and time.
 * @returns Content-Type, Host, X-Date, X-Content-Sha256 and Authorization.
 * @example
 * ```ts
 * signRequest({
 *   method: "POST", url: "https://ark.ap-southeast-1.byteplusapi.com/?Action=GetAsset&Version=2024-01-01",
 *   body: '{"Id":"asset-20260929-a1"}', accessKey: "AKLTtestaccesskey", secretKey: "testsecretkey==",
 *   region: "ap-southeast-1", service: "ark", now: new Date("2026-09-29T12:00:00Z")
 * })["X-Content-Sha256"]; // => "908d4d5d3282f46918bd821ab9a976afe3bf8f49b8b44740b5f358f5a5e9025a"
 * ```
 */
export function signRequest(input: SignInput): SignedHeaders {
  const url = new URL(input.url);
  const xDate = xDateOf(input.now);
  const date = xDate.slice(0, 8);
  const bodyHash = sha256Hex(input.body);

  // The string to sign names the time, the credential scope and the canonical request's hash.
  const scope = `${date}/${input.region}/${input.service}/${SCOPE_TERMINATOR}`;
  const canonical = canonicalRequest(input.method, url, xDate, bodyHash);
  const stringToSign = [ALGORITHM, xDate, scope, sha256Hex(canonical)].join("\n");

  // Derive the signing key from the secret, one scope element at a time.
  const dateKey = hmac(input.secretKey, date);
  const regionKey = hmac(dateKey, input.region);
  const serviceKey = hmac(regionKey, input.service);
  const signingKey = hmac(serviceKey, SCOPE_TERMINATOR);
  const signature = hmac(signingKey, stringToSign).toString("hex");

  return {
    "Content-Type": CONTENT_TYPE,
    Host: url.host,
    "X-Date": xDate,
    "X-Content-Sha256": bodyHash,
    Authorization: `${ALGORITHM} Credential=${input.accessKey}/${scope}, SignedHeaders=${SIGNED_HEADER_NAMES}, Signature=${signature}`
  };
}
