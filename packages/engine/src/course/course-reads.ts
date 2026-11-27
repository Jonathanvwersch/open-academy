import type {
  CourseCatalogPayload,
  CourseDetailPayload,
  CoursePayload,
} from '@open-academy/engine/api/course';
import { filterMasteryRecordsForContent } from '../graph/content-filters.js';
import { buildCourseStartState } from '../graph/course-start.js';
import { activeCourseFor } from '../graph/prerequisites.js';
import { activePlacementRuns } from '../placement/diagnostic-commands.js';
import { effectiveFocusSubjectId } from '../planner/scheduler.js';
import type { CourseStore } from '../store/course-store.js';
import { orderCourseIdsBySubject } from './course-order.js';
import {
  buildCoursePayload,
  courseQueueStatus,
  courseTopicState,
  placedOutConceptsFromGrants,
  suggestedNextCourses,
} from './course-payload.js';
import { CourseReader, type CourseReadInput } from './course-reader.js';
import { subjectForCourse } from './index.js';

export async function getCourseCatalog(
  store: CourseStore,
  input: CourseReadInput,
): Promise<CourseCatalogPayload> {
  const { content: index } = input;
  const reader = new CourseReader(store, input);
  const now = input.now();
  const snapshot = await loadCourseSnapshot(reader, true);
  const activeCourseId = snapshot.studyCourseIds[0] ?? snapshot.activeCourseId;
  const { payload } = snapshot.buildPayload(activeCourseId);
  await reader.completePayloadCourses(payload, now);
  const enrollmentByCourse = new Map(snapshot.enrollments.map((row) => [row.courseId, row]));
  const completedIds = new Set(
    payload.courses
      .filter((course) => course.topicsTotal > 0 && course.topicsDone === course.topicsTotal)
      .map((course) => course.id),
  );
  const courseOrder = orderCourseIdsBySubject(index);
  const subjects = new Map<
    string,
    Array<{
      id: string;
      title: string;
      description: string;
      topicsDone: number;
      topicsTotal: number;
      status: 'not_started' | 'active' | 'paused' | 'completed';
      startNeeded: boolean;
    }>
  >();
  for (const courseId of courseOrder) {
    const course = index.coursesById.get(courseId);
    const progress = payload.courses.find((item) => item.id === courseId);
    if (!course || !progress) continue;
    const enrollment = enrollmentByCourse.get(courseId);
    const status = completedIds.has(courseId) ? 'completed' : (enrollment?.status ?? 'not_started');
    const startState = buildCourseStartState({
      content: index,
      activeCourseId: courseId,
      mastery: snapshot.mastery,
      lessonRuns: snapshot.runs,
      enrollments: snapshot.enrollments,
      placementRuns: snapshot.placementRuns,
    });
    const subject = subjectForCourse(index, courseId);
    const rows = subjects.get(subject.id) ?? [];
    rows.push({
      id: course.id,
      title: course.title,
      description: course.description,
      topicsDone: progress.topicsDone,
      topicsTotal: progress.topicsTotal,
      status,
      startNeeded: status === 'not_started' && startState.courseStart.needed,
    });
    subjects.set(subject.id, rows);
  }
  const catalogSubjects = index.curriculum?.subjects
    ? index.curriculum.subjects.flatMap((subject) => {
        const courses = subjects.get(subject.id);
        return courses?.length ? [{ id: subject.id, title: subject.title, courses }] : [];
      })
    : [
        {
          id: 'default',
          title: index.curriculum?.subject?.title ?? 'Courses',
          courses: subjects.get('default') ?? [],
        },
      ];
  return { subjects: catalogSubjects };
}

export async function getCourseDetail(
  store: CourseStore,
  input: CourseReadInput,
  courseId: string,
): Promise<CourseDetailPayload | undefined> {
  const { content: index } = input;
  const reader = new CourseReader(store, input);
  const course = index.coursesById.get(courseId);
  if (!course) return;
  const snapshot = await loadCourseSnapshot(reader, true);
  const now = input.now();
  const { payload } = snapshot.buildPayload(courseId);
  await reader.completePayloadCourses(payload, now);
  const completedIds = new Set(
    payload.courses
      .filter((course) => course.topicsTotal > 0 && course.topicsDone === course.topicsTotal)
      .map((course) => course.id),
  );
  const enrollmentByCourse = new Map(snapshot.enrollments.map((row) => [row.courseId, row]));
  const statuses = new Map(
    index.courses.map(
      (course) =>
        [
          course.id,
          completedIds.has(course.id)
            ? 'completed'
            : (enrollmentByCourse.get(course.id)?.status ?? 'not_started'),
        ] as const,
    ),
  );
  const status = statuses.get(courseId) ?? 'not_started';
  const user = await reader.settings();
  const focusSubjectId = effectiveFocusSubjectId(
    user?.prefs as { focusSubjectId?: unknown } | undefined,
    snapshot.studyCourseIds,
    index,
  );
  const queue = courseQueueStatus(
    index,
    course,
    snapshot.studyCourseIds,
    focusSubjectId,
    courseTopicState(index, snapshot.mastery, snapshot.runs, snapshot.placedOutConcepts),
  );
  return {
    ...payload,
    status,
    queue,
    suggestedNext:
      status === 'completed'
        ? suggestedNextCourses(index, courseId, statuses).map((suggestion) => ({
            ...suggestion,
            reason: `Builds on ${course?.title ?? 'this course'}`,
          }))
        : [],
  };
}

export async function getCourse(
  store: CourseStore,
  input: CourseReadInput,
  requestedCourseId?: string,
): Promise<CoursePayload> {
  const { content: index } = input;
  const reader = new CourseReader(store, input);
  const snapshot = await loadCourseSnapshot(reader, false);
  const courseId =
    requestedCourseId && index.coursesById.has(requestedCourseId)
      ? requestedCourseId
      : snapshot.activeCourseId;
  const { payload } = snapshot.buildPayload(courseId);
  await reader.completePayloadCourses(payload, input.now());
  return payload;
}

export async function setActiveCourse(store: CourseStore, userId: string, courseId: string) {
  await store.patchSettings(userId, { activeCourseId: courseId });
  return { courseId };
}

export async function startCourseFromBeginning(
  store: CourseStore,
  input: CourseReadInput,
  courseId: string,
) {
  const now = input.now();
  const runs = await activePlacementRuns(store, input.userId);
  await Promise.all(
    runs
      .filter((run) => run.courseId === courseId)
      .map((run) => store.patchDiagnosticRun(input.userId, run.id, { status: 'abandoned' })),
  );
  return enrollFromBeginning(store, input.userId, courseId, now);
}

export async function startActiveCourseFromBeginning(
  store: CourseStore,
  input: CourseReadInput,
  requestedCourseId?: string,
) {
  const { content, userId } = input;
  const reader = new CourseReader(store, input);
  const courseId =
    requestedCourseId && content.coursesById.has(requestedCourseId)
      ? requestedCourseId
      : await reader.activeCourseId();
  const course = activeCourseFor(content, courseId);
  if (!course) return;
  return enrollFromBeginning(store, userId, course.id, input.now());
}

async function enrollFromBeginning(
  store: CourseStore,
  userId: string,
  courseId: string,
  now: Date,
) {
  await store.writeEnrollments(userId, {
    kind: 'start',
    row: {
      courseId,
      status: 'active',
      startMethod: 'beginning',
      startedAt: now,
      completedAt: null,
    },
  });
  return { courseId, method: 'beginning' as const };
}

async function loadCourseSnapshot(reader: CourseReader, alwaysReadFlags: boolean) {
  const {
    store,
    input: { userId, content: index },
  } = reader;
  const studyCourseIds = await reader.studyCourseIds();
  const [
    masteryRows,
    activeCourseId,
    runsRaw,
    paperRows,
    projectRowsRaw,
    enrollments,
    placementRuns,
    completedPlacementRuns,
    initialFlags,
  ] = await Promise.all([
    store.listMastery(userId),
    reader.activeCourseId(),
    store.listLessonRuns(userId),
    store.listPaperProgress(userId),
    store.listProjectProgress(userId),
    reader.enrollments(),
    activePlacementRuns(store, userId),
    store.listPlacementGrants(userId),
    alwaysReadFlags ? store.listRemediationFlags(userId, { status: 'open' }) : [],
  ]);
  const mastery = filterMasteryRecordsForContent(index, masteryRows);
  const runs = runsRaw.filter((run) => index.conceptsById.has(run.conceptId));
  const openRemediationFlags =
    !alwaysReadFlags && runs.some((run) => run.status === 'needs_retry')
      ? await store.listRemediationFlags(userId, { status: 'open' })
      : initialFlags;
  const projectRows = projectRowsRaw.filter((project) => index.projectsById.has(project.projectId));
  const paperStatuses = new Map<string, 'not_started' | 'reading' | 'completed'>(
    paperRows
      .filter((row) => index.papersById.has(row.paperId))
      .map((row) => [row.paperId, row.completedAt ? 'completed' : 'reading'] as const),
  );
  const projectStatuses = new Map(projectRows.map((row) => [row.projectId, row.status]));
  const placedOutConcepts = placedOutConceptsFromGrants(completedPlacementRuns);

  return {
    studyCourseIds,
    activeCourseId: activeCourseId && index.coursesById.has(activeCourseId) ? activeCourseId : null,
    mastery,
    runs,
    paperStatuses,
    projectStatuses,
    enrollments,
    placementRuns,
    placedOutConcepts,
    openRemediationFlags,
    buildPayload(courseId: string | null | undefined) {
      const startState = buildCourseStartState({
        content: index,
        activeCourseId: courseId,
        mastery,
        lessonRuns: runs,
        enrollments,
        placementRuns,
      });
      return {
        startState,
        payload: buildCoursePayload(
          index,
          courseId,
          mastery,
          runs,
          paperStatuses,
          projectStatuses,
          placedOutConcepts,
          startState.startedCourseIds,
          startState.courseStart,
          openRemediationFlags,
        ),
      };
    },
  };
}
