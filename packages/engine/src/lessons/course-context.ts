import type { ContentIndex } from '../course/types.js';
import { lessonCourseContext } from '../graph/lesson-course-context.js';
import type { CourseStore } from '../store/course-store.js';

export async function resolveLessonCourse(
  store: CourseStore,
  content: ContentIndex,
  input: {
    userId: string;
    conceptId: string;
    activityId?: string;
    studyCourseIds: readonly string[];
  },
) {
  const { userId, conceptId, activityId, studyCourseIds } = input;
  const containing = content.courses.filter((course) =>
    course.units.some((unit) => unit.concepts.includes(conceptId)),
  );
  let preferredCourseId: string | undefined;
  if (containing.length > 1) {
    const [activities, sessions] = await Promise.all([
      store.listActivities(userId, { conceptId }),
      store.listSessions(userId, {}),
    ]);
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    const ordered = activities
      .filter((activity) => !activityId || activity.id === activityId)
      .map((activity) => ({ activity, session: sessionById.get(activity.sessionId) }))
      .filter(({ session }) => session !== undefined)
      .sort(
        (left, right) =>
          (right.session?.startedAt?.getTime() ?? Infinity) -
            (left.session?.startedAt?.getTime() ?? Infinity) ||
          right.activity.idx - left.activity.idx,
      );
    preferredCourseId = ordered
      .map(({ activity }) => {
        const value = (activity.reason as { courseId?: unknown }).courseId;
        return typeof value === 'string' ? value : undefined;
      })
      .find((value) => value !== undefined);
  }
  const result = lessonCourseContext(content, { conceptId, preferredCourseId, studyCourseIds });
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
