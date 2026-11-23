import { expect, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { loadContent } from '../../apps/api/src/content/load.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { sessionActivities, studySessions, users } from '../../apps/api/src/db/schema.js';
import { enrollInDefaultCourse } from './course-start.js';

test('a wrong review answer links back to its lesson step', async ({ page }) => {
  const content = await loadContent('tests/fixtures/content');
  const defaultCourseId = content.curriculum?.default_course;
  const defaultCourse = defaultCourseId ? content.coursesById.get(defaultCourseId) : undefined;
  if (!defaultCourseId || !defaultCourse) throw new Error('Missing default course');
  const conceptIds = defaultCourse.units.flatMap((unit) => unit.concepts);
  const candidate = conceptIds
    .flatMap((conceptId) =>
      (content.lessonsByConcept.get(conceptId)?.knowledge_points ?? []).slice(1).flatMap((point) =>
        point.problems.length > 1
          ? point.problems.map((id) => ({
              conceptId,
              point,
              exercise: content.exercisesById.get(id),
            }))
          : [],
      ),
    )
    .find((item) => item.exercise?.type === 'mc');
  if (candidate?.exercise?.type !== 'mc') {
    throw new Error('Expected a multiple-choice exercise in a later lesson step');
  }
  const { conceptId, point, exercise } = candidate;
  const secondExerciseId = point.problems.find((id) => id !== exercise.id);
  if (!secondExerciseId) throw new Error(`Missing second problem in ${point.id}`);
  const wrongOption = exercise.options.find((option) => !option.correct);
  if (!wrongOption) throw new Error(`No incorrect option in ${exercise.id}`);

  const db = createDb(env.TEST_DATABASE_URL);
  await db.delete(users);
  const [user] = await db
    .insert(users)
    .values({
      displayName: 'Remediation E2E learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
      prefs: { scheduleMinutes: 60 },
    })
    .returning({ id: users.id });
  if (!user) throw new Error('Could not create remediation learner');
  await enrollInDefaultCourse(db, user.id);
  const [session] = await db
    .insert(studySessions)
    .values({
      userId: user.id,
      kind: 'weekday',
      plannedMinutes: 10,
      status: 'active',
      startedAt: new Date('2026-01-01T12:00:00.000Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create review session');
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 0,
    kind: 'review',
    conceptId,
    exerciseIds: [exercise.id, secondExerciseId],
    plannedMinutes: 10,
    status: 'in_progress',
  });
  await db.$client.end();

  await page.goto(`/session/${session.id}`);
  await expect(page.locator(`#${exercise.id}-${wrongOption.id}`)).toBeVisible();
  await page.locator(`label[for="${exercise.id}-${wrongOption.id}"]`).click();
  await page.getByRole('button', { name: 'Submit answer' }).click();
  const reReadLink = page.getByRole('link', { name: `Re-read: ${point.title}` });
  await expect(reReadLink).toBeVisible();
  await reReadLink.click();
  await expect(page).toHaveURL(new RegExp(`step=${point.id}`));
  await expect(page.locator(`#${point.id}`)).toBeInViewport();
});
