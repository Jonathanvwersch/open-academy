import { courseHasEvidence } from '../graph/course-start.js';
import type { MasteryRecord } from '../memory/types.js';
import type { Enrollment, Settings } from '../store/core-store.js';
import type { LessonStore } from '../store/lesson-store.js';
import type { ContentIndex } from './types.js';

function courseOrder(content: ContentIndex) {
  return content.curriculum?.courses ?? content.courses.map(({ id }) => id);
}

export function activeStudyCourseIds(content: ContentIndex, enrollments: readonly Enrollment[]) {
  const active = new Set(
    enrollments.filter(({ status }) => status === 'active').map(({ courseId }) => courseId),
  );
  return courseOrder(content).filter((id) => active.has(id));
}

export function studySetBackfill(
  content: ContentIndex,
  enrollments: readonly Enrollment[],
  mastery: readonly Pick<MasteryRecord, 'conceptId' | 'state'>[],
  runs: readonly { conceptId: string }[],
) {
  const started = new Set(enrollments.map(({ courseId }) => courseId));
  for (const course of content.courses) {
    if (
      courseHasEvidence(
        course.units.flatMap(({ concepts }) => concepts),
        mastery,
        runs,
      )
    ) {
      started.add(course.id);
    }
  }
  return courseOrder(content).filter((id) => started.has(id));
}

export async function studyCourseIds(
  store: LessonStore,
  learnerId: string,
  content: ContentIndex,
  now: () => Date,
  settings: Settings | undefined,
) {
  if (!settings) return [];
  let enrollments: Enrollment[] | undefined;
  if (!settings.studySetInitializedAt) {
    const [existing, mastery, runs] = await Promise.all([
      store.listEnrollments(learnerId),
      store.listMastery(learnerId),
      store.listLessonRuns(learnerId),
    ]);
    enrollments = existing;
    const backfill = studySetBackfill(content, existing, mastery, runs);
    if (backfill.length > 0) {
      const startedAt = now();
      await store.writeEnrollments(learnerId, {
        kind: 'insert_missing',
        rows: backfill.map((courseId) => ({
          courseId,
          status: 'active',
          startMethod: 'beginning',
          startedAt,
          completedAt: null,
        })),
      });
      enrollments = undefined;
    }
    await store.patchSettings(learnerId, { studySetInitializedAt: now() });
  }
  enrollments ??= await store.listEnrollments(learnerId);
  return activeStudyCourseIds(content, enrollments);
}
