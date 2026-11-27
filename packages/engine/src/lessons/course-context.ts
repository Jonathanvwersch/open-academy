import type { ContentIndex } from '../course/types.js';
import { lessonCourseContext } from '../graph/lesson-course-context.js';
import type { CourseStore } from '../store/course-store.js';

function coursesForConcept(content: ContentIndex, conceptId: string) {
  return content.courses.filter((course) =>
    course.units.some((unit) => unit.concepts.includes(conceptId)),
  );
}

export async function lessonStudyCourseIds(
  content: ContentIndex,
  conceptId: string,
  loadStudyCourseIds: () => Promise<readonly string[]>,
) {
  return coursesForConcept(content, conceptId).length > 1 ? loadStudyCourseIds() : [];
}

export async function resolveLessonCourse(
  store: CourseStore,
  content: ContentIndex,
  input: {
    userId: string;
    conceptId: string;
    activityId?: string;
    includeActivitiesWithoutSession?: boolean;
    studyCourseIds: readonly string[];
  },
) {
  const {
    userId,
    conceptId,
    activityId,
    includeActivitiesWithoutSession = false,
    studyCourseIds,
  } = input;
  const containing = coursesForConcept(content, conceptId);
  let preferredCourseId: string | undefined;
  if (containing.length > 1) {
    const activities = await store.listActivities(userId, {
      conceptId,
      ...(activityId ? { ids: [activityId] } : {}),
    });
    const sessions = await store.listSessions(userId, {
      ids: [...new Set(activities.map((activity) => activity.sessionId))],
    });
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    preferredCourseId = activities
      .map((activity) => ({ activity, session: sessionById.get(activity.sessionId) }))
      .filter(({ session }) => includeActivitiesWithoutSession || session !== undefined)
      .sort(
        (left, right) =>
          (right.session?.startedAt?.getTime() ?? Number.POSITIVE_INFINITY) -
            (left.session?.startedAt?.getTime() ?? Number.POSITIVE_INFINITY) ||
          right.activity.idx - left.activity.idx,
      )
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
