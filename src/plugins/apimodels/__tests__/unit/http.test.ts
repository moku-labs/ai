import { describe, expect, it } from "vitest";
import { TerminalProviderError } from "../../errors";
import {
  AUTH_STATUSES,
  BAD_REQUEST,
  PAYMENT_REQUIRED,
  RATE_LIMITED,
  RETRY_STATUS,
  refusal,
  UNAUTHORIZED
} from "../../http";

describe("http vocabulary", () => {
  it("refusal is a terminal 400 that keeps the message as given", () => {
    const error = refusal(
      '[ai] apimodels params.assets names "image" twice.\n  List each input once.'
    );

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error.status).toBe(BAD_REQUEST);
    expect(error.message).toBe(
      '[ai] apimodels params.assets names "image" twice.\n  List each input once.'
    );
    expect(error.failCode).toBeUndefined();
  });

  it("names the statuses the plugin classifies by", () => {
    expect([BAD_REQUEST, UNAUTHORIZED, PAYMENT_REQUIRED, RATE_LIMITED, RETRY_STATUS]).toEqual([
      400, 401, 402, 429, 503
    ]);
    expect([...AUTH_STATUSES]).toEqual([401, 403]);
  });
});
