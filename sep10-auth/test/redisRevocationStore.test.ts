/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

import { RedisRevocationStore } from '../examples/redisRevocationStore';
import type { RedisLike } from '../examples/redisRevocationStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADDRESS = 'GDNOTPRESENTINANYMOCKWATCHLISTAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'GOTHERADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/**
 * Builds a minimal in-memory Redis stub so the tests never need a real
 * Redis process.  Only the three methods the store actually calls
 * (`get`, `set`, `del`) are implemented.
 */
function makeRedisStub(): jest.Mocked<RedisLike> {
  const store = new Map<string, string>();

  return {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    scan: jest.fn(async (_cursor: string, _mode: 'MATCH', pattern: string) => {
      const prefix = pattern.slice(0, -1);
      return ['0', [...store.keys()].filter((k) => k.startsWith(prefix))] as [string, string[]];
    }),
    del: jest.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RedisRevocationStore', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // --- isRevoked -----------------------------------------------------------

  it('reports an address as not revoked before any revoke() call', async () => {
    const redis = makeRedisStub();
    const store = new RedisRevocationStore(redis);

    expect(await store.isRevoked(ADDRESS)).toBe(false);
    expect(redis.get).toHaveBeenCalledWith(`sep10:revoked:${ADDRESS}`);
  });

  it('reports an address as revoked after a permanent revoke()', async () => {
    const redis = makeRedisStub();
    const store = new RedisRevocationStore(redis);

    await store.revoke(ADDRESS);

    expect(await store.isRevoked(ADDRESS)).toBe(true);
  });

  // --- permanent revoke ----------------------------------------------------

  it('calls SET without TTL arguments for a permanent revocation', async () => {
    const redis = makeRedisStub();
    const store = new RedisRevocationStore(redis);

    await store.revoke(ADDRESS);

    expect(redis.set).toHaveBeenCalledWith(`sep10:revoked:${ADDRESS}`, '1');
    // Must NOT pass PX / TTL
    expect(redis.set).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'PX',
      expect.anything(),
    );
  });

  // --- timed revoke --------------------------------------------------------

  it('calls SET with PX and the remaining-ms TTL for a future expiry', async () => {
    const redis = makeRedisStub();
    const store = new RedisRevocationStore(redis);
    const until = new Date('2026-01-01T00:10:00.000Z'); // 10 min from now

    await store.revoke(ADDRESS, until);

    expect(redis.set).toHaveBeenCalledWith(
      `sep10:revoked:${ADDRESS}`,
      '1',
      'PX',
      10 * 60 * 1_000, // 600 000 ms
    );
  });

  it('is a no-op (skips the Redis write) when until is already in the past', async () => {
    const redis = makeRedisStub();
    const store = new RedisRevocationStore(redis);
    const past = new Date('2025-12-31T23:59:59.000Z'); // 1 second before "now"

    await store.revoke(ADDRESS, past);

    expect(redis.set).not.toHaveBeenCalled();
  });

  it('is a no-op when until equals exactly the current time', async () => {
    const redis = makeRedisStub();
    const store = new RedisRevocationStore(redis);
    const now = new Date('2026-01-01T00:00:00.000Z'); // same as faked "now"

    await store.revoke(ADDRESS, now);

    expect(redis.set).not.toHaveBeenCalled();
  });

  // --- unrevoke ------------------------------------------------------------

  it('calls DEL on the address key when unrevoke() is called', async () => {
    const redis = makeRedisStub();
    const store = new RedisRevocationStore(redis);

    await store.revoke(ADDRESS);
    await store.unrevoke(ADDRESS);

    expect(redis.del).toHaveBeenCalledWith(`sep10:revoked:${ADDRESS}`);
    expect(await store.isRevoked(ADDRESS)).toBe(false);
  });

  it('unrevoke() on an address that was never revoked is a no-op (calls DEL safely)', async () => {
    const redis = makeRedisStub();
    const store = new RedisRevocationStore(redis);

    await expect(store.unrevoke(ADDRESS)).resolves.not.toThrow();
    expect(redis.del).toHaveBeenCalledTimes(1);
  });

  // --- key prefix ----------------------------------------------------------

  it('uses sep10:revoked: as the default key prefix', async () => {
    const redis = makeRedisStub();
    const store = new RedisRevocationStore(redis);

    await store.revoke(ADDRESS);

    expect(redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^sep10:revoked:/),
      expect.anything(),
    );
  });

  it('respects a custom key prefix supplied in options', async () => {
    const redis = makeRedisStub();
    const store = new RedisRevocationStore(redis, { keyPrefix: 'myapp:revoked:' });

    await store.revoke(ADDRESS);

    expect(redis.set).toHaveBeenCalledWith(
      `myapp:revoked:${ADDRESS}`,
      '1',
    );
  });

  // --- isolation -----------------------------------------------------------

  it('tracks multiple addresses independently', async () => {
    const redis = makeRedisStub();
    const store = new RedisRevocationStore(redis);

    await store.revoke(ADDRESS);

    expect(await store.isRevoked(ADDRESS)).toBe(true);
    expect(await store.isRevoked(OTHER)).toBe(false);
  });

  it('list() returns revoked addresses without the key prefix', async () => {
    const store = new RedisRevocationStore(makeRedisStub());
    await store.revoke(ADDRESS);
    await store.revoke(OTHER);
    expect((await store.list()).sort()).toEqual([ADDRESS, OTHER].sort());
    await store.unrevoke(ADDRESS);
    expect(await store.list()).toEqual([OTHER]);
  });
});
