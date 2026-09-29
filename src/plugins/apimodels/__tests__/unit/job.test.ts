import { describe, expect, it } from "vitest";
import { TerminalProviderError } from "../../types";
import { decodeJobId, encodeJobId, readChargeUsd, readTask } from "../../video/job";
import { thrownBy } from "./fixtures";

describe("encodeJobId / decodeJobId", () => {
  it("round-trips taskId, model alias and assetUsd as JSON", () => {
    const job = { taskId: "task-1", model: "seedance-2.5", assetUsd: 0.02 };
    const jobId = encodeJobId(job);
    expect(JSON.parse(jobId)).toEqual(job);
    expect(decodeJobId(jobId)).toEqual(job);
  });

  it.each([
    ["not JSON", "nope"],
    ["missing taskId", JSON.stringify({ model: "seedance-2.5", assetUsd: 0 })],
    ["empty taskId", JSON.stringify({ taskId: "", model: "seedance-2.5", assetUsd: 0 })],
    ["missing model", JSON.stringify({ taskId: "t", assetUsd: 0 })],
    ["assetUsd not a number", JSON.stringify({ taskId: "t", model: "m", assetUsd: "0" })],
    ["negative assetUsd", JSON.stringify({ taskId: "t", model: "m", assetUsd: -1 })],
    ["a JSON array", "[]"]
  ])("throws a terminal 400 for a malformed id (%s)", (_label, jobId) => {
    const error = thrownBy(() => decodeJobId(jobId));
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as TerminalProviderError).status).toBe(400);
    expect((error as Error).message).toMatch(
      /^\[ai\] apimodels job id ".*" is not valid\.\n {2}Expected the JSON job id returned by apimodels submit\.$/
    );
  });

  it("quotes at most 80 characters of a bad id", () => {
    const error = thrownBy(() => decodeJobId("x".repeat(500)));
    expect((error as Error).message).toContain(`"${"x".repeat(80)}"`);
    expect((error as Error).message).not.toContain("x".repeat(81));
  });
});

describe("readTask", () => {
  it("narrows a completed task to its first result URL", () => {
    expect(
      readTask({
        taskId: "t1",
        state: "completed",
        resultUrls: ["https://r2/a.mp4", "https://r2/b.mp4"]
      })
    ).toEqual({
      taskId: "t1",
      state: "completed",
      resultUrl: "https://r2/a.mp4",
      failCode: undefined,
      failMsg: undefined,
      retryable: undefined
    });
  });

  it("narrows a failed task to its failCode, failMsg and retryable flag", () => {
    expect(
      readTask({
        taskId: "t1",
        state: "failed",
        failCode: "UPSTREAM_BUSY",
        failMsg: "busy",
        retryable: true
      })
    ).toMatchObject({
      state: "failed",
      failCode: "UPSTREAM_BUSY",
      failMsg: "busy",
      retryable: true
    });
  });

  it("reads anything else as empty fields", () => {
    expect(readTask(undefined)).toEqual({
      taskId: undefined,
      state: undefined,
      resultUrl: undefined,
      failCode: undefined,
      failMsg: undefined,
      retryable: undefined
    });
    expect(readTask({ resultUrls: [42], retryable: "yes" })).toMatchObject({
      resultUrl: undefined,
      retryable: undefined
    });
  });
});

describe("readChargeUsd", () => {
  it("returns credits when the charge is settled in USD", () => {
    expect(readChargeUsd({ settled: true, credits: 2.16, currency: "USD" })).toBe(2.16);
  });

  it.each([
    ["not settled", { settled: false, credits: 2.16, currency: "USD" }],
    // eslint-disable-next-line unicorn/no-null -- apimodels sends credits: null before a charge settles
    ["credits null", { settled: true, credits: null, currency: "USD" }],
    ["another currency", { settled: true, credits: 2.16, currency: "CNY" }],
    ["no body", undefined]
  ])("returns undefined when %s", (_label, data) => {
    expect(readChargeUsd(data)).toBeUndefined();
  });
});
