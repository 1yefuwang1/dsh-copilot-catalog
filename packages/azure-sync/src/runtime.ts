/**
 * Small runtime helpers shared by the plugin. No host service is required for
 * these helpers, so they remain unit-testable without a Cordis composition.
 * @module @1yefuwang1/dsh-azure-sync/runtime
 */
import type { Context } from '@deepseek-ai/cordis';

/** Resolve a mandatory Cordis capability or fail with a clear message. */
export function required<T>(ctx: Context, name: string): T {
  const value = ctx.get(name) as T | undefined;
  if (value === undefined) throw new Error(`azure-sync: required capability "${name}" is not mounted.`);
  return value;
}

/** Current epoch milliseconds, kept integral for Table Int64 fields. */
export function now(): number {
  return Date.now();
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function assertNever(value: never): never {
  throw new Error(`azure-sync: unexpected value ${String(value)}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
