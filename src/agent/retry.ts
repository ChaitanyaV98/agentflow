/**
 * Retry with exponential backoff and jitter, for flaky tool calls (network blips, 5xx, rate limits).
 *
 * Delay before attempt n+1 ≈ baseMs × 2^(n-1), plus up to 25% random jitter so many clients
 * retrying at once don't hit the server in lockstep.
 *
 * Errors marked `retryable: false` (e.g. 404, bad input) fail immediately — retrying can't fix them.
 *
 * Note: LLM calls are retried by the AI SDK itself (`maxRetries`), so this is only used for tools.
 */
export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class NonRetryableError extends Error {
  readonly retryable = false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<{ value: T; attempts: number }> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 500;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return { value: await fn(), attempts: i };
    } catch (e) {
      lastError = e;
      const retryable = !(e instanceof NonRetryableError);
      if (!retryable || i === attempts) break;
      const delay = baseMs * 2 ** (i - 1);
      await sleep(delay + Math.random() * delay * 0.25);
    }
  }
  throw Object.assign(lastError instanceof Error ? lastError : new Error(String(lastError)), {
    attempts,
  });
}
