import { describe, expect, it } from "vitest";
import { NonRetryableError, withRetry } from "./retry";

const sleep = async () => {};

describe("withRetry", () => {
  it("retries transient errors and reports the attempt that succeeded", async () => {
    let n = 0;
    const r = await withRetry(async () => (++n < 3 ? Promise.reject(new Error("503")) : "ok"), { sleep });
    expect(r).toEqual({ value: "ok", attempts: 3 });
  });

  it("stops at once on a non-retryable error and reports 1 attempt", async () => {
    let n = 0;
    const err = await withRetry(
      async () => {
        n++;
        throw new NonRetryableError("404");
      },
      { sleep },
    ).catch((e) => e);
    expect(n).toBe(1);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(err.attempts).toBe(1);
  });

  it("gives up after the maximum and reports it", async () => {
    const err = await withRetry(async () => Promise.reject(new Error("down")), { sleep, attempts: 4 }).catch((e) => e);
    expect(err.message).toBe("down");
    expect(err.attempts).toBe(4);
  });

  it("backs off exponentially", async () => {
    const delays: number[] = [];
    await withRetry(async () => Promise.reject(new Error("x")), {
      attempts: 4,
      baseMs: 100,
      sleep: async (ms) => void delays.push(ms),
    }).catch(() => {});
    // 100, 200, 400 plus up to 25% jitter each
    expect(delays).toHaveLength(3);
    [100, 200, 400].forEach((base, i) => {
      expect(delays[i]).toBeGreaterThanOrEqual(base);
      expect(delays[i]).toBeLessThanOrEqual(base * 1.25);
    });
  });
});
