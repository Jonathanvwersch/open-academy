import type { ContentIndex } from '@open-academy/engine/course/types';
import type { EngineLearnerRepository } from '@open-academy/engine/engine/repository';
import { lessonCourseContext } from '@open-academy/engine/graph/lesson-course-context';
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { sessionActivities, studySessions } from '../../db/schema.js';

export async function resolveLessonCourse(
  db: Database,
  repo: EngineLearnerRepository,
  content: ContentIndex,
  userId: string,
  conceptId: string,
  activityId?: string,
) {
  const containing = content.courses.filter((course) =>
    course.units.some((unit) => unit.concepts.includes(conceptId)),
  );
  let preferredCourseId: string | undefined;
  let studyCourseIds: string[] = [];
  // A unique course cannot be changed by activity history or study membership.
  if (containing.length > 1) {
    const activities = await db
      .select({ reason: sessionActivities.reason })
      .from(sessionActivities)
      .innerJoin(studySessions, eq(studySessions.id, sessionActivities.sessionId))
      .where(
        and(
          eq(studySessions.userId, userId),
          eq(sessionActivities.conceptId, conceptId),
          activityId ? eq(sessionActivities.id, activityId) : undefined,
        ),
      )
      .orderBy(desc(studySessions.startedAt), desc(sessionActivities.idx));
    preferredCourseId = activities
      .map(({ reason }) => {
        const value = (reason as { courseId?: unknown }).courseId;
        return typeof value === 'string' ? value : undefined;
      })
      .find((value) => value !== undefined);
    studyCourseIds = await repo.activeStudyCourseIds(content);
  }
  const result = lessonCourseContext(content, {
    conceptId,
    preferredCourseId,
    studyCourseIds,
  });
  return result
    ? {
        id: result.courseId,
        title: result.courseTitle,
        unitNumber: result.unitNumber,
        unitTitle: result.unitTitle,
        position: result.position,
      }
    : null;
}
