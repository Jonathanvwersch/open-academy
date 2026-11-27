import { Rating } from 'ts-fsrs';
import { expect, test } from 'vitest';
import type { ContentIndex, IndexedConcept, IndexedExercise } from '../course/types.js';
import {
  nextQuizDifficulty,
  quizAnswerIsLate,
  quizDurationMs,
  quizItemOutcome,
  quizRetakeEligible,
  quizScore,
  quizXp,
  quizXpBalance,
  selectQuizQuestions,
} from './mixed-quiz.js';

test('carries eligible XP across original quiz cycles', () => {
  expect(quizXpBalance(179, 1)).toBe(29);
  expect(quizXp(12, 0.625, false)).toBe(8);
  expect(quizXp(12, 1, true)).toBe(0);
  expect(nextQuizDifficulty({ difficulty: 3, score: 0.875 })).toBe(4);
  expect(nextQuizDifficulty({ difficulty: 3, score: 0.75 })).toBe(2);
});

test('selects distinct learned and uncovered topics with fresh retake questions', () => {
  const concepts = Array.from({ length: 10 }, (_, i) => ({
    id: `topic-${i}`,
    status: 'authored',
    prereqs: i === 1 ? [{ id: 'topic-0', strength: 'hard' }] : [],
  })) as IndexedConcept[];
  const exercisesByConcept = new Map(
    concepts.map(({ id }) => [
      id,
      [1, 2].map((variant) => ({
        id: `${id}-${variant}`,
        concept: id,
        prompt: `Question ${id}-${variant}`,
        type: 'numeric',
        difficulty: 2,
      })) as IndexedExercise[],
    ]),
  );
  const content = {
    concepts,
    conceptsById: new Map(concepts.map((concept) => [concept.id, concept])),
    exercisesByConcept,
    coursesById: new Map(),
  } as ContentIndex;
  const input = {
    content,
    completedTopics: new Set(concepts.slice(0, 8).map(({ id }) => id)),
    confirmedPlacementTopics: new Set(['topic-8']),
    courseId: null,
    seed: 42,
    difficulty: 2,
    exposure: new Map<string, number>(),
    usedKeys: new Set<string>(),
  };
  expect(selectQuizQuestions({ ...input, confirmedPlacementTopics: new Set() })).toBeUndefined();
  const selected = selectQuizQuestions(input);
  expect(selected).toHaveLength(8);
  expect(selected).toEqual(selectQuizQuestions(input));
  const topics = selected?.map(({ question }) => question.exercise.concept);
  expect(topics).toContain('topic-8');
  expect(topics).not.toContain('topic-9');
  expect(topics?.includes('topic-0') && topics?.includes('topic-1')).toBe(false);
  expect(
    new Set(selected?.flatMap(({ question, reserve }) => [question.key, reserve.key])).size,
  ).toBe(16);
  expect(quizDurationMs(selected?.map(({ question }) => question) ?? [], 1.5)).toBe(1_080_000);
});

test('rates item outcomes and keeps retakes locked until all follow-ups are complete', () => {
  expect(quizAnswerIsLate(new Date(1000), new Date(1000))).toBe(true);
  const good = quizItemOutcome(true, 90_000, 90);
  const hard = quizItemOutcome(true, 90_001, 90);
  const again = quizItemOutcome(false, null, 90);
  expect([good.rating, hard.rating, again.rating]).toEqual([
    Rating.Good,
    Rating.Hard,
    Rating.Again,
  ]);
  expect(quizScore([good, hard, again])).toBe(2 / 3);
  expect(
    quizRetakeEligible(
      [
        { ...again, reviewed: true },
        { ...hard, reviewed: false },
      ],
      false,
    ),
  ).toBe(false);
  expect(
    quizRetakeEligible(
      [
        { ...again, reviewed: true },
        { ...hard, reviewed: true },
      ],
      false,
    ),
  ).toBe(true);
  expect(quizRetakeEligible([{ ...again, reviewed: true }], true)).toBe(false);
});
