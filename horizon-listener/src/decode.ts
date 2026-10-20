/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

import { scValToNative, xdr } from '@stellar/stellar-sdk';

/** How {@link RpcEventSource} surfaces event topics and values. */
export type EventDecodeMode = 'none' | 'native';

export type JsonSafeValue =
  string | number | boolean | null | JsonSafeValue[] | { [key: string]: JsonSafeValue };

/**
 * Converts the output of `scValToNative` into a JSON-serializable value:
 * bigint (i128/u128/i64/u64...) becomes a decimal string, bytes become a hex
 * string, Maps become plain objects with stringified keys, and arrays/objects
 * are converted recursively.
 */
export function toJsonSafe(value: unknown): JsonSafeValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value instanceof Map) {
    const out: { [key: string]: JsonSafeValue } = {};
    for (const [k, v] of value) out[keyToString(k)] = toJsonSafe(v);
    return out;
  }
  if (typeof value === 'object') {
    const out: { [key: string]: JsonSafeValue } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toJsonSafe(v);
    return out;
  }
  return String(value);
}

function keyToString(key: unknown): string {
  const safe = toJsonSafe(key);
  return typeof safe === 'string' ? safe : JSON.stringify(safe);
}

function toScVal(value: unknown): xdr.ScVal | undefined {
  if (value instanceof xdr.ScVal) return value;
  if (typeof value === 'string') {
    try {
      return xdr.ScVal.fromXDR(value, 'base64');
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Decodes an ScVal (instance or base64 XDR) to a JSON-safe native value.
 * Values that are not ScVals are passed through {@link toJsonSafe} unchanged.
 */
export function decodeScValToJson(value: unknown): JsonSafeValue {
  const scVal = toScVal(value);
  return toJsonSafe(scVal ? scValToNative(scVal) : value);
}

/** Decodes a topic segment to a string (non-string values are JSON-encoded). */
export function decodeTopicToString(value: unknown): string {
  const decoded = decodeScValToJson(value);
  return typeof decoded === 'string' ? decoded : JSON.stringify(decoded);
}
