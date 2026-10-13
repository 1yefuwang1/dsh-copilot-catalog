import assert from 'node:assert/strict';
import type {} from '@deepseek-ai/dsh-sandbox-policy';
import type {} from '@deepseek-ai/dsh-user-approval';
import type {} from '@deepseek-ai/dsh-plan-mode';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-goal';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-permission-presets';
import type {} from '@deepseek-ai/dsh-commands';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session, SessionHeader, SessionSeq } from '@deepseek-ai/dsh-session';

/** Detached fixture headers deliberately remain mutable for corruption/adoption tests. */
export type MutableHeader = { -readonly [K in keyof SessionHeader]: SessionHeader[K] };

/** Fail at the fixture boundary instead of silently asserting away missing map/array entries. */
export function presentValue<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null, 'Expected an existing fixture value');
  return value;
}

interface AgentMock {
  id: string;
  ctx: Context;
  status: string;
  session: { header: object };
  inbox: { nextTurn: unknown[]; nextStep: unknown[] };
}

/**
 * Dynamic registry boundary: these tests implement only the Agent capabilities
 * exercised by session bootstrap/Local claims, not a complete production driver.
 * Keep the concrete mock shape alongside the public Agent type for typed assertions.
 */
export function mockAgent<T extends AgentMock>(value: T): T & Agent {
  return value as T & Agent;
}

export function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

interface TitleFixturePayload { title: string; messageSeqs: SessionSeq[]; source: { kind: 'user' } }

/** The title provider is not a direct dependency; keep its dynamic event boundary explicit. */
export function appendSessionTitle(session: Session, data: TitleFixturePayload): void {
  const append = session.append as unknown as (type: 'session/title', payload: TitleFixturePayload) => unknown;
  append.call(session, 'session/title', data);
}

/** Native deferred used by cancellation/publication-gate tests. */
export function deferred<T = void>() {
  return Promise.withResolvers<T>();
}
