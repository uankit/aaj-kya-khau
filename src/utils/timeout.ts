/**
 * Generic Promise timeout helpers.
 *
 * Prefer `AbortSignal.timeout()` when the underlying API accepts an
 * AbortSignal (fetch, Vercel AI SDK, pg query cancellation). Use
 * `withTimeout()` below when the API doesn't take a signal (e.g. Twilio
 * SDK method calls).
 */

export class TimeoutError extends Error {
  readonly isTimeout = true;
  constructor(label: string, ms: number) {
    super(`Timeout after ${ms}ms: ${label}`);
    this.name = 'TimeoutError';
  }
}

/**
 * Races a promise against a timeout. Rejects with TimeoutError if exceeded.
 * Note: this can't actually *cancel* the underlying work — it just stops
 * waiting on it. For true cancellation use AbortSignal where the API
 * supports it.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Simple delay helper used for exponential backoff. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries an async function with exponential backoff (base 500ms).
 * Returns the successful result or throws the last error.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  attempts: number,
  label: string,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      const wait = 500 * Math.pow(2, i); // 500, 1000, 2000...
      await sleep(wait);
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${String(lastErr)}`);
}
