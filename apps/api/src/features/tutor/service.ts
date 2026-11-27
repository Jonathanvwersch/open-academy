import type { ContentIndex } from '@open-academy/engine/course/types';
import { and, count, eq, gte, ne } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { llmCalls, users } from '../../db/schema.js';
import {
  type TutorPromptId,
  type TutorProvider,
  type TutorResult,
  type TutorUsage,
  tutorPromptVersion,
} from './provider.js';
import type { ExplanationContext, TutorContext, TutorLevel } from './schemas.js';

export type TutorFailureDetails = {
  name: string;
  status?: number | string;
  code?: string;
  reason?: string;
};

export function tutorFailureDetails(error: unknown, fallbackStatus?: string): TutorFailureDetails {
  const failure =
    error && typeof error === 'object'
      ? (error as {
          name?: unknown;
          status?: unknown;
          code?: unknown;
          reason?: unknown;
          incomplete_details?: { reason?: unknown } | null;
        })
      : null;
  const reason = failure?.reason ?? failure?.incomplete_details?.reason;
  return {
    name: typeof failure?.name === 'string' ? failure.name : 'ProviderError',
    status: typeof failure?.status === 'number' ? failure.status : fallbackStatus,
    code: typeof failure?.code === 'string' ? failure.code : undefined,
    reason: typeof reason === 'string' ? reason : fallbackStatus,
  };
}

export function tutorCallAllowed(dailyCount: number, dailyCap: number) {
  return dailyCount < dailyCap;
}

export function startOfLocalDay(now: Date, timeZone: string): Date {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  const dateKey = (timestamp: number) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(timestamp).map((part) => [part.type, Number(part.value)]),
    );
    return parts.year * 10_000 + parts.month * 100 + parts.day;
  };
  const today = dateKey(now.getTime());
  // Midnight can be skipped by a DST transition. Find the first actual instant
  // of this local date rather than solving for a wall-clock time that may not exist.
  let before = now.getTime() - 48 * 60 * 60 * 1000;
  let within = now.getTime();
  while (within - before > 1) {
    const midpoint = before + Math.floor((within - before) / 2);
    if (dateKey(midpoint) < today) before = midpoint;
    else within = midpoint;
  }
  return new Date(within);
}

export class TutorService {
  constructor(
    private readonly db: Database,
    private readonly provider: TutorProvider,
    private readonly userId: string,
    private readonly dailyCap: number,
    private readonly timeZone: string,
  ) {}

  respond(ctx: TutorContext, level: TutorLevel, content: ContentIndex, signal?: AbortSignal) {
    return this.invoke(
      'tutor-system',
      () => this.provider.respond(ctx, level, content, signal),
      content,
    );
  }

  gradeExplanation(ctx: ExplanationContext) {
    return this.invoke('rubric-grader', () => this.provider.gradeExplanation(ctx));
  }

  private async invoke<T>(
    promptId: TutorPromptId,
    call: () => Promise<TutorResult<T>>,
    content?: ContentIndex,
  ): Promise<{
    value?: T;
    status: 'ok' | 'fallback' | 'budget_exceeded';
    callId?: string;
    failure?: TutorFailureDetails;
  }> {
    const startedAt = performance.now();
    const promptVersion = tutorPromptVersion(promptId, content);
    // Reserve a call before contacting the provider. The learner row serializes
    // reservations across requests and server instances without holding a lock
    // while the provider runs.
    const reservation = await this.db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, this.userId)).for('update');
      const [daily] = await tx
        .select({ value: count() })
        .from(llmCalls)
        .where(
          and(
            eq(llmCalls.userId, this.userId),
            gte(llmCalls.createdAt, startOfLocalDay(new Date(), this.timeZone)),
            ne(llmCalls.status, 'budget_exceeded'),
          ),
        );
      const allowed = tutorCallAllowed(daily?.value ?? 0, this.dailyCap);
      const callId = await this.record(
        promptId,
        promptVersion,
        allowed ? 'pending' : 'budget_exceeded',
        null,
        0,
        null,
        tx,
      );
      return { allowed, callId };
    });
    const { callId } = reservation;
    if (!reservation.allowed) return { status: 'budget_exceeded', callId };
    try {
      const result = await call();
      await this.db
        .update(llmCalls)
        .set({
          status: 'ok',
          inputTokens: result.usage?.inputTokens ?? null,
          outputTokens: result.usage?.outputTokens ?? null,
          latencyMs: Math.round(performance.now() - startedAt),
        })
        .where(eq(llmCalls.id, callId));
      return { value: result.value, status: 'ok', callId };
    } catch (error) {
      const failure = tutorFailureDetails(error);
      await this.db
        .update(llmCalls)
        .set({
          status: 'fallback',
          latencyMs: Math.round(performance.now() - startedAt),
          error: failure.name,
        })
        .where(eq(llmCalls.id, callId));
      return { status: 'fallback', callId, failure };
    }
  }

  private async record(
    promptId: TutorPromptId,
    promptVersion: string,
    status: 'pending' | 'budget_exceeded',
    usage: TutorUsage | null,
    latencyMs: number,
    error: string | null = null,
    db: Pick<Database, 'insert'> = this.db,
  ) {
    const [row] = await db
      .insert(llmCalls)
      .values({
        userId: this.userId,
        promptId,
        promptVersion,
        provider: 'openai',
        model: this.provider.model,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        costUsd: null,
        latencyMs,
        status,
        error,
      })
      .returning({ id: llmCalls.id });
    return row.id;
  }
}
