import { createHash } from 'node:crypto';
import type { ContentIndex } from '@open-academy/engine/course/types';
import { calculateCredit } from '@open-academy/engine/memory/mastery';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../src/db/client.js';
import {
  buildTutorInput as buildTutorInputWithContent,
  createTutorProvider,
  FakeProvider,
  OpenAIProvider,
  tutorPromptVersion,
} from '../../src/features/tutor/provider.js';
import {
  RubricJudgementSchema,
  type TutorContext,
  type TutorLevel,
  TutorReplySchema,
} from '../../src/features/tutor/schemas.js';
import {
  startOfLocalDay,
  TutorService,
  tutorCallAllowed,
} from '../../src/features/tutor/service.js';

const tutorContent = {
  subjectsByCourseId: new Map(),
  curriculum: {
    subject: {
      title: 'Fixture subject',
      tutor_context: 'The learner is working through a fixture course.',
    },
  },
} as unknown as ContentIndex;

function buildTutorInput(
  context: TutorContext,
  level: TutorLevel,
  content: ContentIndex = tutorContent,
) {
  return buildTutorInputWithContent(context, level, content);
}

function testDatabase(dailyCount = 0) {
  let loggedCall: Record<string, unknown> | undefined;
  const db = {
    select: () => ({
      from: () => ({
        where: () =>
          Object.assign(Promise.resolve([{ value: dailyCount }]), { for: async () => [] }),
      }),
    }),
    insert: () => ({
      values: (value: Record<string, unknown>) => {
        loggedCall = value;
        return { returning: async () => [{ id: 'call-id' }] };
      },
    }),
    update: () => ({
      set: (value: Record<string, unknown>) => ({
        where: async () => {
          loggedCall = { ...loggedCall, ...value };
        },
      }),
    }),
    transaction: async (run: (tx: Database) => Promise<unknown>) => run(db),
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
    answerKey: '',
    graderFeedback: '',
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
  it('grounds the tutor in the curriculum subject and hashes the rendered prompt', () => {
    const prompt = buildTutorInput(tutorContext(), 'hint')[0]?.content;
    if (!prompt) throw new Error('Missing tutor system prompt');
    expect(prompt).toContain(
      'You are the Academy tutor: a patient, rigorous teacher of Fixture subject for one adult learner.',
    );
    expect(prompt).toContain(
      'About this learner and subject: The learner is working through a fixture course.',
    );
    expect(prompt).toContain(
      'The chat panel is narrow (about 45 characters). Keep each display equation short; split a long one over several lines with `$$\\begin{aligned} … \\\\ … \\end{aligned}$$`, one step per line.',
    );
    expect(prompt).toContain(
      `12. Write the way a friendly human tutor talks: short, plain sentences. Never use em dashes (—) or spaced en dashes ( – ); use a full stop, comma, colon or brackets instead. Don't frame points as "X, not Y" or "it's not X, it's Y" unless you are correcting a specific mistake the learner made. No filler openers ("Great question!") or closing offers ("Let me know if…").`,
    );
    expect(prompt).toContain(
      'Never switch to a different or simpler example unless the learner asks for one.',
    );
    expect(prompt).toContain(
      '14. The learner may send more than one message before you reply, for example to correct or steer a question while you were still answering.',
    );
    expect(prompt).toContain(
      '15. Arithmetic is never the skill being practised. Once the learner has stated a correct method for the current problem',
    );
    expect(prompt).toContain('Never send them to a calculator, a search bar or code instead.');
    expect(prompt).toContain(
      '16. If a rule stops you from doing what the learner asked, say so plainly in your first reply',
    );
    expect(tutorPromptVersion('tutor-system', tutorContent)).toBe(
      createHash('sha256').update(prompt).digest('hex').slice(0, 12),
    );
  });

  it('uses the generic course subject when no title is configured', () => {
    const content = {} as ContentIndex;
    const prompt = buildTutorInput(tutorContext(), 'hint', content)[0]?.content ?? '';
    expect(prompt).toContain(
      'You are the Academy tutor: a patient, rigorous teacher of the subject of this course for one adult learner.',
    );
    expect(prompt).not.toContain('{{subject}}');
  });

  it('tells the tutor to respond honestly to unsubmitted guesses without inventing flaws', () => {
    const prompt = buildTutorInput(tutorContext(), 'hint')[0]?.content ?? '';
    expect(prompt).toContain('say plainly whether their reasoning and their choice are right');
    expect(prompt).toContain('Never invent a flaw in correct reasoning');
    expect(prompt).not.toContain('never confirm or deny it');
    expect(prompt).not.toContain('ask what makes them choose it');
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

describe('OpenAIProvider', () => {
  it('passes the request abort signal to the Responses API', async () => {
    const parse = vi.fn().mockResolvedValue({
      output_parsed: {
        message_md: 'Try the first step.',
        misconception: null,
        suggests_review_of: [],
      },
      usage: null,
    });
    const provider = new OpenAIProvider('test-key', 'test-model', {
      responses: { parse },
    } as never);
    const controller = new AbortController();

    await provider.respond(tutorContext(), 'hint', tutorContent, controller.signal);

    expect(parse).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'test-model', max_output_tokens: 4000 }),
      { signal: controller.signal },
    );
  });

  it('throws when the Responses API returns an incomplete reply', async () => {
    const parse = vi.fn().mockResolvedValue({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output_parsed: null,
      usage: null,
    });
    const provider = new OpenAIProvider('test-key', 'test-model', {
      responses: { parse },
    } as never);

    await expect(provider.respond(tutorContext(), 'hint', tutorContent)).rejects.toThrow(
      'max_output_tokens',
    );
    expect(parse).toHaveBeenCalledWith(expect.objectContaining({ max_output_tokens: 4000 }), {
      signal: undefined,
    });
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
    const result = await service.respond({} as never, 'hint', tutorContent);

    expect(result).toMatchObject({
      status: 'fallback',
      failure: { name: 'Error' },
    });
    expect(result.failure).not.toHaveProperty('message');
  });

  it('returns no provider when the API key is absent', () => {
    expect(createTutorProvider({ model: 'gpt-6.1-terra' })).toBeNull();
  });

  it('logs budget exhaustion without calling the provider', async () => {
    const { db, loggedCall } = testDatabase(200);
    const provider = new FakeProvider();
    const service = new TutorService(db, provider, 'user', 200, 'UTC');
    await expect(service.respond({} as never, 'hint', tutorContent)).resolves.toMatchObject({
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
    await service.respond({} as never, 'hint', tutorContent);
    expect(loggedCall()).toMatchObject({
      promptId: 'tutor-system',
      promptVersion: tutorPromptVersion('tutor-system', tutorContent),
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
    await expect(service.respond({} as never, 'nudge', tutorContent)).resolves.toMatchObject({
      status: 'fallback',
    });
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
    await expect(provider.respond({} as never, 'nudge', tutorContent)).resolves.toMatchObject({
      value: { message_md: expect.any(String) },
      usage: null,
    });
  });
});
