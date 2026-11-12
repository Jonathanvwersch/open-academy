import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/server/db/client.js';
import { calculateCredit } from '../src/server/learning/mastery.js';
import {
  buildTutorInput,
  createTutorProvider,
  FakeProvider,
  TUTOR_PROMPT_VERSIONS,
} from '../src/server/tutor/provider.js';
import {
  RubricJudgementSchema,
  type TutorContext,
  TutorReplySchema,
} from '../src/server/tutor/schemas.js';
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

function tutorContext(overrides: Partial<TutorContext> = {}): TutorContext {
  return {
    conceptTitle: 'Linear regression',
    objectives: ['Understand the slope'],
    lessonSummary: 'A line models the relationship between two variables.',
    exercisePrompt: 'What does the slope represent?',
    exerciseLabel: 'Question 4',
    exerciseOptions: [],
    hintLevel: 1,
    authoredHints: ['Think about how y changes as x changes.'],
    solution: 'The slope is the change in y for each unit change in x.',
    recentMistakes: [],
    history: [],
    problem_status: 'unanswered',
    page: 'none',
    page_content: '',
    ...overrides,
  };
}

describe('buildTutorInput', () => {
  it('guides the tutor to keep display math narrow and hashes the current prompt', () => {
    const prompt = buildTutorInput(tutorContext(), 'hint')[0]?.content;
    if (!prompt) throw new Error('Missing tutor system prompt');
    expect(prompt).toContain(
      'The chat panel is narrow (about 45 characters). Keep each display equation short; split a long one over several lines with `$$\\begin{aligned} … \\\\ … \\end{aligned}$$`, one step per line.',
    );
    expect(TUTOR_PROMPT_VERSIONS['tutor-system']).toBe(
      createHash('sha256').update(prompt).digest('hex').slice(0, 12),
    );
  });

  it('sends context, history, and the latest learner message as separate turns', () => {
    const input = buildTutorInput(
      tutorContext({
        history: [
          { role: 'learner', content: 'I do not understand the slope.' },
          { role: 'tutor', content: 'What changes when x increases?' },
        ],
        question: 'ah true makes sense',
      }),
      'hint',
    );

    expect(input.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'system',
      'user',
    ]);
    expect(input.at(-1)).toEqual({ role: 'user', content: 'ah true makes sense' });
    const contextMessage = input.at(-2);
    if (!contextMessage) throw new Error('Missing tutor context message');
    expect(contextMessage.role).toBe('system');
    const contextPrefix =
      "Context for the learner's next message — what is on their screen right now:\n";
    expect(contextMessage.content.startsWith(contextPrefix)).toBe(true);
    const context = JSON.parse(contextMessage.content.slice(contextPrefix.length)) as Record<
      string,
      unknown
    >;
    expect(context).not.toHaveProperty('history');
    expect(context).not.toHaveProperty('question');
    expect(context).toMatchObject({
      conceptTitle: 'Linear regression',
      exerciseLabel: 'Question 4',
      requested_help_level: 'hint',
    });
  });

  it('adds the hint-button message when there is no question or history', () => {
    const input = buildTutorInput(tutorContext({ history: [], question: undefined }), 'nudge');

    expect(input).toHaveLength(3);
    expect(input.map((message) => message.role)).toEqual(['system', 'system', 'user']);
    expect(input.at(-1)).toEqual({
      role: 'user',
      content:
        '(No chat message: the learner pressed the hint button. Give help at requested_help_level.)',
    });
  });

  it('places context before the latest question when history is empty', () => {
    const input = buildTutorInput(
      tutorContext({ history: [], question: 'Can you explain this?' }),
      'hint',
    );

    expect(input.map((message) => message.role)).toEqual(['system', 'system', 'user']);
    expect(input.at(-1)).toEqual({ role: 'user', content: 'Can you explain this?' });
    expect(input.at(-2)?.content).toContain(
      "Context for the learner's next message — what is on their screen right now:\n",
    );
  });

  it('maps tutor turns to assistant and learner turns to user', () => {
    const input = buildTutorInput(
      tutorContext({
        history: [
          { role: 'tutor', content: 'Consider the slope.' },
          { role: 'learner', content: 'I see it now.' },
        ],
        question: 'Thanks.',
      }),
      'nudge',
    );

    expect(input.slice(1, 3)).toEqual([
      { role: 'assistant', content: 'Consider the slope.' },
      { role: 'user', content: 'I see it now.' },
    ]);
  });
});

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
