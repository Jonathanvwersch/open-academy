import { and, count, eq, gte } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { llmCalls } from '../../db/schema.js';
import {
  TUTOR_PROMPT_VERSIONS,
  type TutorPromptId,
  type TutorProvider,
  type TutorResult,
  type TutorUsage,
} from './provider.js';
import type { ExplanationContext, TutorContext, TutorLevel } from './schemas.js';

export function tutorCallAllowed(dailyCount: number, dailyCap: number) {
  return dailyCount < dailyCap;
}

export function startOfLocalDay(now: Date, timeZone: string): Date {
  const format = (date: Date) =>
    Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hourCycle: 'h23',
      })
        .formatToParts(date)
        .map((part) => [part.type, Number(part.value)]),
    ) as Record<string, number>;
  const localNow = format(now);
  const target = Date.UTC(localNow.year, localNow.month - 1, localNow.day);
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = format(new Date(candidate));
    const represented = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    const adjustment = target - represented;
    candidate += adjustment;
    if (adjustment === 0) break;
  }
  return new Date(candidate);
}

export class TutorService {
  constructor(
    private readonly db: Database,
    private readonly provider: TutorProvider,
    private readonly userId: string,
    private readonly dailyCap: number,
    private readonly timeZone: string,
  ) {}

  respond(ctx: TutorContext, level: TutorLevel) {
    return this.invoke('tutor-system', () => this.provider.respond(ctx, level));
  }

  gradeExplanation(ctx: ExplanationContext) {
    return this.invoke('rubric-grader', () => this.provider.gradeExplanation(ctx));
  }

  private async invoke<T>(
    promptId: TutorPromptId,
    call: () => Promise<TutorResult<T>>,
  ): Promise<{ value?: T; status: 'ok' | 'fallback' | 'budget_exceeded'; callId?: string }> {
    const startedAt = performance.now();
    const [daily] = await this.db
      .select({ value: count() })
      .from(llmCalls)
      .where(
        and(
          eq(llmCalls.userId, this.userId),
          gte(llmCalls.createdAt, startOfLocalDay(new Date(), this.timeZone)),
        ),
      );
    if (!tutorCallAllowed(daily?.value ?? 0, this.dailyCap)) {
      const callId = await this.record(promptId, 'budget_exceeded', null, 0);
      return { status: 'budget_exceeded', callId };
    }
    try {
      const result = await call();
      const callId = await this.record(
        promptId,
        'ok',
        result.usage,
        Math.round(performance.now() - startedAt),
      );
      return { value: result.value, status: 'ok', callId };
    } catch (error) {
      const callId = await this.record(
        promptId,
        'fallback',
        null,
        Math.round(performance.now() - startedAt),
        error instanceof Error ? error.name : 'ProviderError',
      );
      return { status: 'fallback', callId };
    }
  }

  private async record(
    promptId: TutorPromptId,
    status: 'ok' | 'fallback' | 'budget_exceeded',
    usage: TutorUsage | null,
    latencyMs: number,
    error: string | null = null,
  ) {
    const [row] = await this.db
      .insert(llmCalls)
      .values({
        userId: this.userId,
        promptId,
        promptVersion: TUTOR_PROMPT_VERSIONS[promptId],
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
    return row?.id;
  }
}
