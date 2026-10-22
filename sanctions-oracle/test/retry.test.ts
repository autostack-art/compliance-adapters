import { withRetry } from '../src/retry';

const instantSleep = async (): Promise<void> => {};

describe('withRetry', () => {
  it('succeeds on the first try without retrying', async () => {
    const fn = jest.fn().mockResolvedValue('ok');

    const result = await withRetry(fn, { sleepFn: instantSleep });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('succeeds after a couple of failures, within maxAttempts', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce('ok');

    const result = await withRetry(fn, { maxAttempts: 5, sleepFn: instantSleep });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rethrows the last error once maxAttempts is exhausted', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValueOnce(new Error('third'));

    await expect(withRetry(fn, { maxAttempts: 3, sleepFn: instantSleep })).rejects.toThrow(
      'third',
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('waits between attempts using exponential backoff', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce('ok');
    const sleepFn = jest.fn().mockResolvedValue(undefined);

    await withRetry(fn, { maxAttempts: 3, baseMs: 100, jitter: false, sleepFn });

    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).toHaveBeenCalledWith(100);
  });
});
