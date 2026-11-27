import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { activityRow, sessionRow } from '../store/learner-store.contract.js';
import { memoryStore } from '../store/memory-store.js';
import { getLearnHome } from './learn-home.js';
import { loadContentFromDirectory } from './load.js';

it('projects Done today from original timed quiz XP in memory, without counting a retake', async () => {
  const content = await loadContentFromDirectory(
    fileURLToPath(new URL('../../../../tests/fixtures/content', import.meta.url)),
  );
  const now = new Date('2026-01-17T12:00:00Z');
  const userId = 'learner';
  const store = memoryStore({
    settings: new Map([
      [
        userId,
        {
          activeCourseId: null,
          studySetInitializedAt: now,
          startDate: '2026-01-17',
          timeZone: 'UTC',
          prefs: {},
        },
      ],
    ]),
  });
  const session = await store.insertSession(userId, sessionRow(now));
  const [activity] = await store.insertActivities(userId, session.id, [
    activityRow(0, {
      kind: 'mixed_quiz',
      conceptId: null,
      exerciseIds: [],
      status: 'completed',
      completedAt: now,
    }),
  ]);
  const quiz = {
    activityId: activity.id,
    retakeOf: null,
    seed: 1,
    difficulty: 2,
    plannedMinutes: 10,
    startedAt: now,
    deadline: now,
    finalizedAt: now,
    score: 0.75,
    xpAwarded: 8,
  };
  const original = await store.insertTimedQuiz(userId, quiz, []);
  const retake = await store.insertTimedQuiz(userId, { ...quiz, retakeOf: original.id }, []);
  for (const [id, amount] of [
    [original.id, 8],
    [retake.id, 5],
  ] as const) {
    await store.insertXpEventOnce(userId, {
      kind: 'mixed_quiz',
      sourceKey: `mixed-quiz:${id}`,
      conceptId: null,
      amount,
      earnedAt: now,
      localDate: '2026-01-17',
    });
  }
  const home = await getLearnHome(store, { userId, content, timeZone: 'UTC', now: () => now });
  expect(home.doneToday).toEqual([
    {
      activityId: activity.id,
      label: 'Quiz',
      title: 'Timed quiz',
      xp: 8,
      completedAt: now.toISOString(),
    },
  ]);
  expect(home.xp.today).toBe(13);
});
