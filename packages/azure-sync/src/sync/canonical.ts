/**
 * Canonical, deterministic event bytes. Identity is over logical events and
 * the canonical JSONL payload, never over gzip frames or SDK serialization.
 * @module @1yefuwang1/dsh-azure-sync/sync/canonical
 */
import { createHash } from 'node:crypto';
import { AzureSyncError } from '../azure/errors.js';

/** SHA-256 over raw byte parts; the result is lowercase hex. */
export function sha256Hex(...parts: readonly (string | Uint8Array)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(typeof part === 'string' ? Buffer.from(part, 'utf8') : part);
  return hash.digest('hex');
}

/** Convert one stored 64-hex digest into its raw 32 bytes. */
export function bytes32(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/u.test(hex)) throw new AzureSyncError('INVALID_RECORD', 'A chain hash must be 64 lowercase hex characters.');
  return Buffer.from(hex, 'hex');
}

function encode(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string': return JSON.stringify(value);
    case 'boolean': return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isFinite(value)) throw new AzureSyncError('INVALID_RECORD', `A non-finite number appears at ${path}.`);
      // Pin to the runtime's JSON number spelling so two devices cannot disagree.
      return JSON.stringify(value);
    }
    case 'bigint':
    case 'function':
    case 'symbol':
    case 'undefined':
      throw new AzureSyncError('INVALID_RECORD', `A non-JSON value appears at ${path}.`);
    case 'object': {
      if (ancestors.has(value)) throw new AzureSyncError('INVALID_RECORD', `A cycle appears at ${path}.`);
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          // Array.from visits holes as undefined; encode then rejects them instead of
          // letting a sparse array collide with an empty array.
          return `[${Array.from(value, (item, index) => encode(item, `${path}[${index}]`, ancestors)).join(',')}]`;
        }
        const prototype = Object.getPrototypeOf(value) as unknown;
        if (prototype !== Object.prototype && prototype !== null) {
          throw new AzureSyncError('INVALID_RECORD', `A non-plain object appears at ${path}.`);
        }
        const object = value as Record<string, unknown>;
        const fields: string[] = [];
        for (const key of Object.keys(object).sort()) {
          const item = object[key];
          if (item === undefined) continue;
          fields.push(`${JSON.stringify(key)}:${encode(item, `${path}.${key}`, ancestors)}`);
        }
        return `{${fields.join(',')}}`;
      } finally {
        ancestors.delete(value);
      }
    }
  }
  throw new AzureSyncError('INVALID_RECORD', `A non-JSON value appears at ${path}.`);
}

/** Deterministic JSON: sorted keys, undefined object properties omitted, non-JSON rejected. */
export function canonicalJson(value: unknown): string {
  return encode(value, '$', new Set<object>());
}

/** Canonical JSONL payload bytes: one JSON record plus one newline per event, in order. */
export function payloadBytes(events: readonly unknown[]): Buffer {
  return Buffer.concat(events.map((event) => Buffer.from(canonicalJson(event) + '\n', 'utf8')));
}

export function payloadHash(events: readonly unknown[]): string {
  return sha256Hex(payloadBytes(events));
}

/** One logical event's identity. */
export function eventHash(event: unknown): string {
  return sha256Hex('event\0', canonicalJson(event));
}
