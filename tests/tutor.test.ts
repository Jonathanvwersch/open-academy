import { describe, expect, it } from 'vitest';
import type { Database } from '../src/server/db/client.js';
import { calculateCredit } from '../src/server/learning/mastery.js';
import {
  createTutorProvider,
  FakeProvider,
  TUTOR_PROMPT_VERSIONS,
} from '../src/server/tutor/provider.js';
import { RubricJudgementSchema, TutorReplySchema } from '../src/server/tutor/schemas.js';
import { scoreRubric } from '../src/server/tutor/scoring.js';
import { startOfLocalDay, TutorService, tutorCallAllowed } from '../src/server/tutor/service.js';

function testDatabase(dailyCount = 0) {
  let loggedCall: Record<string, unknown> | undefined;
  const db = {
    select: () => ({ from: () => ({ where: async () => [{ value: dailyCount }] }) }),
    insert: () => ({
      values: (value: Record<string, unknown>) => {
        loggedCall = value;
        return { returning: async () => [{ id: 'call-id' }] };
      },
    }),
  } as unknown as Database;
  return { db, loggedCall: () => loggedCall };
}

describe('tutor contracts', () => {
  it('accepts only the prompt-defined tutor reply shape', () => {
    expect(
      TutorReplySchema.safeParse({
        message_md: 'Try the first step.',
        misconception: null,
        suggests_review_of: [],
        correct: true,
      }).success,
    ).toBe(false);
  });

  it('validates rubric judgements and rejects unknown fields', () => {
    expect(
      RubricJudgementSchema.safeParse({
        criteria: [{ id: 'a', judgement: 'met', evidence: 'Identified the slope.' }],
        feedback_md: 'Good.',
        score: 1,
      }).success,
    ).toBe(false);
  });

  it('supports a provider error fallback path', async () => {
    const provider = new FakeProvider(undefined, undefined, new Error('offline'));
    const service = new TutorService(testDatabase().db, provider, 'user', 200, 'UTC');
    await expect(service.respond({} as never, 'hint')).resolves.toMatchObject({
      status: 'fallback',
    });
  });

  it('returns no provider when the API key is absent', () => {
    expect(createTutorProvider({ model: 'gpt-5.4-mini' })).toBeNull();
  });

  it('logs budget exhaustion without calling the provider', async () => {
    const { db, loggedCall } = testDatabase(200);
    const provider = new FakeProvider();
    const service = new TutorService(db, provider, 'user', 200, 'UTC');
    await expect(service.respond({} as never, 'hint')).resolves.toMatchObject({
      status: 'budget_exceeded',
    });
    expect(loggedCall()).toMatchObject({
      promptId: 'tutor-system',
      provider: 'openai',
      status: 'budget_exceeded',
    });
  });

  it('logs prompt version and provider metadata on a successful call', async () => {
    const { db, loggedCall } = testDatabase();
    const service = new TutorService(db, new FakeProvider(), 'user', 200, 'UTC');
    await service.respond({} as never, 'hint');
    expect(loggedCall()).toMatchObject({
      promptId: 'tutor-system',
      promptVersion: TUTOR_PROMPT_VERSIONS['tutor-system'],
      provider: 'openai',
      model: 'fake-provider',
      status: 'ok',
      inputTokens: null,
      outputTokens: null,
    });
  });

  it('stops tutor calls at the daily cap', () => {
    expect(tutorCallAllowed(199, 200)).toBe(true);
    expect(tutorCallAllowed(200, 200)).toBe(false);
  });

  it('treats malformed fake-provider output as a schema violation', async () => {
    const provider = new FakeProvider({
      message_md: 'Here is the answer.',
      misconception: null,
      suggests_review_of: [],
      correct: true,
    } as never);
    const service = new TutorService(testDatabase().db, provider, 'user', 200, 'UTC');
    await expect(service.respond({} as never, 'nudge')).resolves.toMatchObject({
      status: 'fallback',
    });
  });
  it('scores weighted rubric judgements in application code', () => {
    const rubric = [
      { id: 'required', criterion: 'Names slope', weight: 1, required: true },
      { id: 'reason', criterion: 'Explains change', weight: 3, required: false },
    ];
    expect(
      scoreRubric(rubric, {
        criteria: [
          { id: 'required', judgement: 'missing', evidence: null },
          { id: 'reason', judgement: 'met', evidence: 'Explained.' },
        ],
        feedback_md: 'Needs a slope.',
      }).score,
    ).toBe(0);
    expect(
      scoreRubric(rubric, {
        criteria: [
          { id: 'required', judgement: 'met', evidence: 'Correct.' },
          { id: 'reason', judgement: 'partial', evidence: 'Some explanation.' },
        ],
        feedback_md: 'Good start.',
      }).score,
    ).toBe(0.625);
  });

  it('counts a tutor-generated hint at the normal authored hint credit', () => {
    expect(
      calculateCredit({ correct: 1, hintsUsed: 1, attemptNo: 1, gradedBy: 'deterministic' }),
    ).toBe(0.7);
  });

  it('uses the learner timezone to determine the daily call boundary', () => {
    expect(
      startOfLocalDay(new Date('2026-01-02T02:00:00.000Z'), 'America/Los_Angeles').toISOString(),
    ).toBe('2026-01-01T08:00:00.000Z');
  });

  it('keeps FakeProvider deterministic for tests', async () => {
    const provider = new FakeProvider();
    await expect(provider.respond({} as never, 'nudge')).resolves.toMatchObject({
      value: { message_md: expect.any(String) },
      usage: null,
    });
  });
});
