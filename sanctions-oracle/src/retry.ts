/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

import { computeBackoffDelayMs } from '@compliance-adapters/backoff';

export interface RetryOptions {
  /** Total attempts before giving up, including the first. Defaults to 3. */
  maxAttempts?: number;
  baseMs?: number;
  maxMs?: number;
  jitter?: boolean;
  randomFn?: () => number;
  /** Injectable so tests don't have to wait out real backoff delays. */
  sleepFn?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Runs `fn`, retrying on rejection up to `maxAttempts` total attempts with
 * exponential backoff between tries. Rethrows the last error if every
 * attempt fails.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseMs = options.baseMs ?? 500;
  const maxMs = options.maxMs ?? 30000;
  const jitter = options.jitter ?? true;
  const randomFn = options.randomFn ?? Math.random;
  const sleepFn = options.sleepFn ?? defaultSleep;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt >= maxAttempts) {
        throw err;
      }
      const delay = computeBackoffDelayMs(attempt - 1, { baseMs, maxMs, jitter, randomFn });
      await sleepFn(delay);
    }
  }
}
