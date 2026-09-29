import { describe, expect, it } from "vitest";
import { accountOf, ownAccount } from "../../account";
import {
  CN_ACCOUNT,
  createFakeEnv,
  createTestCtx,
  INTL_ACCOUNT,
  TEST_ACCESS_KEY
} from "../fixtures";

describe("accountOf", () => {
  it("is the pinned 12-hex fingerprint of region + key", () => {
    expect(accountOf("intl", TEST_ACCESS_KEY)).toBe(INTL_ACCOUNT);
    expect(accountOf("cn", TEST_ACCESS_KEY)).toBe(CN_ACCOUNT);
  });

  it("is stable and 12 lowercase hex characters", () => {
    const first = accountOf("intl", "AKLTanother");
    expect(accountOf("intl", "AKLTanother")).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{12}$/);
  });

  it("differs by region and by key", () => {
    expect(accountOf("intl", TEST_ACCESS_KEY)).not.toBe(accountOf("cn", TEST_ACCESS_KEY));
    expect(accountOf("intl", TEST_ACCESS_KEY)).not.toBe(accountOf("intl", "AKLTother"));
  });

  it("never contains the key", () => {
    const key = "abcdef012345";
    expect(accountOf("intl", key)).not.toContain(key);
    expect(accountOf("intl", TEST_ACCESS_KEY)).not.toContain(TEST_ACCESS_KEY.slice(0, 6));
  });
});

describe("ownAccount", () => {
  it("reads the access key through ctx.env and caches the fingerprint in state", () => {
    const ctx = createTestCtx();

    expect(ownAccount(ctx)).toBe(INTL_ACCOUNT);
    expect(ctx.state.account).toBe(INTL_ACCOUNT);
  });

  it("uses the configured region and access key env var", () => {
    const ctx = createTestCtx({
      config: { region: "cn", accessKeyEnv: "MY_AK" },
      env: createFakeEnv({ MY_AK: TEST_ACCESS_KEY })
    });
    expect(ownAccount(ctx)).toBe(CN_ACCOUNT);
  });

  it("returns the cached fingerprint without reading the env again", () => {
    const ctx = createTestCtx({ env: createFakeEnv({}), state: { account: "cached000000" } });
    expect(ownAccount(ctx)).toBe("cached000000");
  });

  it("throws when the access key is not set", () => {
    const ctx = createTestCtx({ env: createFakeEnv({}) });
    expect(() => ownAccount(ctx)).toThrow('required variable "ARK_ACCESS_KEY"');
  });
});
