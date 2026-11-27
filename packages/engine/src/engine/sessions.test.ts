import { expect, test } from 'vitest';
import type { SessionActivity } from '../api/sessions.js';
import { currentActivity } from './sessions.js';

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

const lesson = {
  concept: 'lesson',
  version: 1,
  blocks: [],
  fast_path: [],
  contentVersion: '1',
  knowledge_points: [{ id: 'point', title: 'Point', explain: '', worked: '', problems: [] }],
};

const content = {
  lessonsByConcept: new Map([
    ['lesson', lesson],
    ['quiz', { ...lesson, concept: 'quiz' }],
  ]),
};

const noRuns = new Map<string, { status: string }>();

test('uses the active activity unless a completed lesson or final is pinned', () => {
  const current = activity('current');
  const later = activity('later');
  const project = activity('project', { kind: 'lab' });
  const result = currentActivity([current, later, project], noRuns, content);

  expect(result.current).toEqual({
    activityId: 'current',
    openableIds: ['current', 'later', 'project'],
  });
  expect(result.activities[2]).not.toHaveProperty('lessonRunner');
});

test('has no openable activities when there is no active activity', () => {
  expect(
    currentActivity([activity('done', { kind: 'practice', status: 'completed' })], noRuns, content)
      .current,
  ).toEqual({ openableIds: [] });
});

test('a completed final question keeps priority over the next planned lesson', () => {
  const final = activity('final', {
    status: 'completed',
    progress: { lessonRunnerContinued: true, completedExerciseIds: ['final'] },
  });
  const next = activity('next');

  expect(currentActivity([final, next], noRuns, content).current).toEqual({
    activityId: 'final',
    completedFinalId: 'final',
    openableIds: [],
  });
});

test('session activities expose the next incomplete or completed final exercise', () => {
  const current = activity('current', {
    kind: 'practice',
    status: 'in_progress',
    exerciseIds: ['done', 'next'],
    progress: { completedExerciseIds: ['done'] },
  });
  const final = activity('final', {
    exerciseIds: ['final', 'later'],
    status: 'completed',
    progress: { lessonRunnerContinued: true, completedExerciseIds: ['final'] },
  });
  const result = currentActivity([current, final], noRuns, content);

  expect(result.activities).toMatchObject([
    { id: 'current', exerciseId: 'next' },
    { id: 'final', exerciseId: 'final' },
  ]);
  expect(result.current.completedFinalId).toBe('final');
});

test('completed deep links stay openable without changing the current activity', () => {
  const prior = activity('prior', { kind: 'practice', status: 'completed' });
  const current = activity('current');
  const later = activity('later');

  expect(currentActivity([prior, current, later], noRuns, content).current).toEqual({
    activityId: 'current',
    openableIds: ['prior', 'current', 'later'],
  });
});

test('planned lesson deep links stay openable while another activity is active', () => {
  const lesson = activity('lesson');
  const project = activity('project', { kind: 'lab', status: 'in_progress' });

  expect(currentActivity([lesson, project], noRuns, content).current).toEqual({
    activityId: 'project',
    openableIds: ['lesson', 'project'],
  });
});

test('an uncontinued completed quiz keeps priority until its Continue action is acknowledged', () => {
  const quiz = activity('quiz', {
    status: 'completed',
    progress: { finalQuestionContinued: true },
  });
  const current = activity('current');
  const statuses = new Map([['quiz', { status: 'completed' }]]);
  expect(currentActivity([quiz, current], statuses, content).current).toEqual({
    activityId: 'quiz',
    openableIds: [],
  });

  const continued = { ...quiz, progress: { ...quiz.progress, quizContinued: true } };
  expect(currentActivity([continued, current], statuses, content).current).toEqual({
    activityId: 'current',
    openableIds: ['quiz', 'current'],
  });
});

test('lesson runner and quiz flags move to learn activities from lesson state', () => {
  const lesson = activity('lesson');
  const result = currentActivity([lesson], new Map([['lesson', { status: 'quiz' }]]), content);
  expect(result.activities[0]).toMatchObject({ lessonRunner: true, lessonQuiz: true });

  const continued = activity('lesson', {
    progress: { lessonRunnerContinued: true },
  });
  expect(
    currentActivity([continued], new Map([['lesson', { status: 'completed' }]]), content)
      .activities[0]?.lessonRunner,
  ).toBe(false);

  const final = activity('lesson', {
    progress: { lessonRunnerContinued: true, finalQuestionContinued: true },
  });
  expect(
    currentActivity([final], new Map([['lesson', { status: 'quiz' }]]), content).activities[0],
  ).toMatchObject({ lessonRunner: true, lessonQuiz: true });

  const quizContinued = activity('lesson', {
    progress: {
      lessonRunnerContinued: true,
      finalQuestionContinued: true,
      quizContinued: true,
    },
  });
  expect(
    currentActivity([quizContinued], new Map([['lesson', { status: 'quiz' }]]), content)
      .activities[0],
  ).toMatchObject({ lessonRunner: false, lessonQuiz: false });
});
