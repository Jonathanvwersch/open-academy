import type { LessonRunPayload } from '@academy/contracts/lessons';
import type { SessionActivity } from '@academy/contracts/sessions';
import { expect, test } from 'vitest';
import {
  selectSessionActivity,
  sessionActivityCandidates,
  usesLessonRunner,
} from './activity-selection.js';

const activity = (id: string, overrides: Partial<SessionActivity> = {}): SessionActivity => ({
  id,
  idx: 0,
  kind: 'learn',
  conceptId: id,
  exerciseIds: ['final'],
  plannedMinutes: 10,
  status: 'planned',
  lessonAvailable: true,
  progress: {},
  ...overrides,
});
const runs = new Map<string, LessonRunPayload['run'] | undefined>();

test('only the current planned activity blocks entry; later lessons and projects do not', () => {
  const current = activity('current');
  const later = activity('later');
  const project = activity('project', { kind: 'lab' });
  expect(sessionActivityCandidates([current, later, project])).toEqual([current]);
  expect(selectSessionActivity([current, later, project], runs).activity).toBe(current);
});

test('a completed final question keeps priority over the next planned lesson', () => {
  const final = activity('final', {
    status: 'completed',
    progress: { lessonRunnerContinued: true, completedExerciseIds: ['final'] },
  });
  const next = activity('next');
  expect(sessionActivityCandidates([final, next])).toEqual([final, next]);
  expect(selectSessionActivity([final, next], runs).activity).toBe(final);
});

test('completed deep links load their own activity without pulling in other future lessons', () => {
  const prior = activity('prior', { kind: 'practice', status: 'completed' });
  const current = activity('current');
  const later = activity('later');
  expect(sessionActivityCandidates([prior, current, later], prior.id)).toEqual([prior, current]);
  expect(selectSessionActivity([prior, current, later], runs, prior.id).activity).toBe(prior);
});

test('an uncontinued completed quiz takes priority until its Continue action is acknowledged', () => {
  const quiz = activity('quiz', {
    status: 'completed',
    progress: { finalQuestionContinued: true },
  });
  const current = activity('current');
  const statuses = new Map([['quiz', { status: 'completed' as const }]]);
  expect(selectSessionActivity([quiz, current], statuses).activity).toBe(quiz);
  const continued = { ...quiz, progress: { ...quiz.progress, quizContinued: true } };
  expect(sessionActivityCandidates([continued, current])).toEqual([current]);
  expect(selectSessionActivity([continued, current], statuses).activity).toBe(current);
});

test('the standalone final exercise is needed only between lesson steps and the quiz', () => {
  const lesson = {
    blocks: [],
    knowledge_points: [{ id: 'point', title: '', explain: '', worked: '', problems: [] }],
  };
  expect(usesLessonRunner(activity('current'), lesson)).toBe(true);
  expect(
    usesLessonRunner(activity('current', { progress: { lessonRunnerContinued: true } }), lesson),
  ).toBe(false);
  expect(
    usesLessonRunner(
      activity('current', {
        progress: { lessonRunnerContinued: true, finalQuestionContinued: true },
      }),
      lesson,
    ),
  ).toBe(true);
});
