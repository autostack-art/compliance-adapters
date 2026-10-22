/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

/**
 * @file sep10-auth/examples/redisRevocationStore.ts
 *
 * A Redis-backed implementation of {@link RevocationStore}.
 *
 * The in-memory reference store (InMemoryRevocationStore) is explicit about
 * its limitation: revocations are lost on process restart, which undermines
 * the "cut off access immediately" guarantee for any multi-instance or
 * frequently-deployed service.  This example shows how to back the same
 * interface with Redis so that revocations survive restarts and are
 * automatically shared across every process in your cluster.
 *
 * ## Storage model
 *
 * | operation          | Redis command                              |
 * |--------------------|-------------------------------------------|
 * | permanent revoke   | `SET revoked:<address> 1`                 |
 * | timed revoke       | `SET revoked:<address> 1 PX <millis>`     |
 * | unrevoke           | `DEL revoked:<address>`                   |
 * | check              | `EXISTS revoked:<address>` (returns 0/1)  |
 *
 * The `PX` option (milliseconds precision) mirrors Redis's TTL enforcement,
 * so expiry is handled entirely by Redis — no cron job or background sweep
 * is needed.  A key that no longer exists means "not revoked", exactly as
 * InMemoryRevocationStore behaves when a timed revocation expires.
 *
 * ## Usage
 *
 * Install a Redis client.  This example uses `ioredis` (the most widely
 * used Redis client for Node):
 *
 * ```bash
 * npm install ioredis
 * npm install --save-dev @types/ioredis  # if your project uses TypeScript
 * ```
 *
 * Wire it up alongside `createSep10Middleware`:
 *
 * ```ts
 * import Redis from 'ioredis';
 * import { createSep10Middleware } from 'sep10-auth';
 * import { RedisRevocationStore } from './redisRevocationStore';
 *
 * const redis = new Redis(process.env.REDIS_URL);
 * const revocationStore = new RedisRevocationStore(redis);
 *
 * app.use(
 *   createSep10Middleware({
 *     serverAccountId: process.env.SERVER_ACCOUNT_ID!,
 *     networkPassphrase: Networks.TESTNET,
 *     homeDomains: process.env.HOME_DOMAIN!,
 *     webAuthDomain: process.env.WEB_AUTH_DOMAIN!,
 *     revocationStore,
 *   }),
 * );
 *
 * // Revoke a compromised address immediately (no waiting for token expiry):
 * await revocationStore.revoke('GCOMPROMISED...');
 *
 * // Revoke temporarily — Redis TTL handles the expiry automatically:
 * await revocationStore.revoke('GSUSPICIOUS...', new Date(Date.now() + 15 * 60_000));
 *
 * // Lift a revocation:
 * await revocationStore.unrevoke('GADDRESS...');
 * ```
 *
 * ## Dependency note
 *
 * `ioredis` is **not** a declared dependency of `sep10-auth`.  This file is
 * an example that you copy into your own project and add `ioredis` (or
 * another Redis client) to *your* package.json.  The interface below is
 * intentionally kept to the minimal Redis surface area (`get`, `set`, `del`)
 * so that any client — ioredis, node-redis, upstash, etc. — can be plugged in
 * by implementing `RedisLike`.
 */

import type { RevocationStore } from '../src/revocation';

// ---------------------------------------------------------------------------
// Minimal Redis client interface
// ---------------------------------------------------------------------------

/**
 * The minimal subset of the Redis client API that RedisRevocationStore needs.
 *
 * Both ioredis and node-redis satisfy this interface out of the box:
 *
 * ```ts
 * import Redis from 'ioredis';          // ioredis
 * import { createClient } from 'redis'; // node-redis (v4+)
 * ```
 */
export interface RedisLike {
  /**
   * GET key — returns the string value, or `null` when the key does not
   * exist (whether because it was never set or because its TTL expired).
   */
  get(key: string): Promise<string | null>;

  /**
   * SET key value [PX milliseconds] — stores a string value with an optional
   * TTL.  When `pxMs` is omitted the key persists until explicitly deleted.
   *
   * This signature matches ioredis's overloaded `set` when called as:
   *   `redis.set(key, value)`            // no TTL
   *   `redis.set(key, value, 'PX', ms)` // millisecond TTL
   *
   * node-redis users should wrap their client:
   *   ```ts
   *   set: (key, value, pxMs?) =>
   *     pxMs !== undefined
   *       ? redisClient.set(key, value, { PX: pxMs })
   *       : redisClient.set(key, value)
   *   ```
   */
  set(key: string, value: string, exMode?: 'PX', pxMs?: number): Promise<unknown>;

  /**
   * SCAN cursor MATCH pattern — iterates keys matching `pattern`. Both
   * ioredis and node-redis (via a small wrapper) can provide this shape:
   * `redis.scan(cursor, 'MATCH', pattern)` resolving to `[nextCursor, keys]`.
   */
  scan(cursor: string, matchMode: 'MATCH', pattern: string): Promise<[string, string[]]>;

  /** DEL key — removes a key; no-op if the key does not exist. */
  del(key: string): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// RedisRevocationStore
// ---------------------------------------------------------------------------

export interface RedisRevocationStoreOptions {
  /**
   * Prefix applied to every key written to Redis.
   * Defaults to `"sep10:revoked:"`.
   */
  keyPrefix?: string;
}

/**
 * Redis-backed {@link RevocationStore}.
 *
 * Revocations persist across restarts and are visible to every process that
 * shares the same Redis instance, making this suitable for production
 * deployments with multiple app-server replicas or frequent redeploys.
 */
export class RedisRevocationStore implements RevocationStore {
  private readonly redis: RedisLike;
  private readonly keyPrefix: string;

  constructor(redis: RedisLike, options: RedisRevocationStoreOptions = {}) {
    this.redis = redis;
    this.keyPrefix = options.keyPrefix ?? 'sep10:revoked:';
  }

  // --------------------------------------------------------------------------
  // RevocationStore implementation
  // --------------------------------------------------------------------------

  /**
   * Returns `true` when a revocation record exists in Redis for `address`.
   * Redis automatically removes keys whose TTL has elapsed, so an expired
   * timed revocation is indistinguishable from "never revoked".
   */
  async isRevoked(address: string): Promise<boolean> {
    const value = await this.redis.get(this.key(address));
    return value !== null;
  }

  /**
   * Writes a revocation record to Redis.
   *
   * - When `until` is **omitted** the key persists indefinitely (permanent
   *   revocation; must be lifted with `unrevoke()`).
   * - When `until` is a **future Date** the key carries a TTL equal to the
   *   remaining milliseconds.  Redis will delete it automatically at expiry.
   * - When `until` is a **past Date** the method is a no-op: the revocation
   *   would expire immediately, so we skip the write entirely.  This mirrors
   *   how `InMemoryRevocationStore` handles the same edge case.
   */
  async revoke(address: string, until?: Date): Promise<void> {
    if (until !== undefined) {
      const ttlMs = until.getTime() - Date.now();
      if (ttlMs <= 0) {
        // Already expired — skip the write.
        return;
      }
      await this.redis.set(this.key(address), '1', 'PX', ttlMs);
    } else {
      await this.redis.set(this.key(address), '1');
    }
  }

  /**
   * Removes the revocation record from Redis.  No-op when the address was
   * never revoked or when the TTL has already elapsed.
   */
  async unrevoke(address: string): Promise<void> {
    await this.redis.del(this.key(address));
  }

  /**
   * Enumerates currently revoked addresses by SCANning the `keyPrefix`
   * namespace. Expired timed revocations are already gone from Redis.
   */
  async list(): Promise<string[]> {
    const addresses = new Set<string>();
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${this.keyPrefix}*`);
      for (const key of keys) addresses.add(key.slice(this.keyPrefix.length));
      cursor = next;
    } while (cursor !== '0');
    return [...addresses];
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private key(address: string): string {
    return `${this.keyPrefix}${address}`;
  }
}
