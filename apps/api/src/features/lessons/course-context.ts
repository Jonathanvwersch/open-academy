import { and, desc, eq } from 'drizzle-orm';
import type { ContentIndex } from '../../content/types.js';
import type { Database } from '../../db/client.js';
import type { LearnerRepository } from '../../db/repository.js';
import { sessionActivities, studySessions } from '../../db/schema.js';
import { lessonCourseContext } from '../../learning/lesson-course-context.js';

export async function resolveLessonCourse(
  db: Database,
  repo: LearnerRepository,
  content: ContentIndex,
  userId: string,
  conceptId: string,
  activityId?: string,
) {
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
  const preferredCourseId = activities
    .map(({ reason }) => {
      const value = (reason as { courseId?: unknown }).courseId;
      return typeof value === 'string' ? value : undefined;
    })
    .find((value) => value !== undefined);
  const result = lessonCourseContext(content, {
    conceptId,
    preferredCourseId,
    studyCourseIds: await repo.studyCourseIds(content),
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
