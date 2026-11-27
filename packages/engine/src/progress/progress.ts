import type { ProgressMasteryState, ProgressSubjectPayload } from '../api/progress.js';
import { orderCourseIdsBySubject } from '../course/course-order.js';
import { courseTopicState } from '../course/course-payload.js';
import { subjectForCourse } from '../course/index.js';
import type { ContentIndex } from '../course/types.js';
import { filterMasteryRecordsForContent } from '../graph/content-filters.js';
import { deriveLearningDebt } from '../memory/debt.js';
import { type MasteryEvent, type MasteryRecord, masteryRank } from '../memory/types.js';
import type { CourseStore } from '../store/course-store.js';
import type { LessonRun } from '../store/lesson-store.js';
import { buildStreak } from './streak.js';
import { localDateKey, type XpEventDate } from './xp.js';

export interface ProgressAttempt {
  id: string;
  exerciseId: string;
  conceptId: string;
  dimension: MasteryRecord['dimension'];
  correct: number;
  hintsUsed: number;
  createdAt: Date | string;
}

export interface ProgressEvent extends Omit<MasteryEvent, 'createdAt'> {
  createdAt: Date | string;
}

export function buildProgress(input: {
  content: ContentIndex;
  records: MasteryRecord[];
  events: ProgressEvent[];
  attempts: ProgressAttempt[];
  flags: Array<{ conceptId: string; targetPrereqId?: string | null }>;
  submissions: Array<{ projectId: string; results: unknown }>;
  subjects: ProgressSubjectPayload[];
  xpEvents: readonly XpEventDate[];
  now: Date;
  timeZone: string;
}) {
  const { content, records, attempts, now, timeZone } = input;
  const eventRecords = input.events.map((event) => ({
    ...event,
    attemptId: event.attemptId ?? undefined,
    createdAt: toIso(event.createdAt),
  }));
  const labFailures = input.submissions.flatMap((submission) => {
    const project = content.projectsById.get(submission.projectId);
    if (!project) return [];
    const failed = new Set(
      ((submission.results as { tests?: Array<{ id: string; passed: boolean }> }).tests ?? [])
        .filter((test) => !test.passed)
        .map((test) => test.id),
    );
    const conceptIds = project.tests
      .filter((test) => failed.has(test.id))
      .flatMap((test) => test.concepts);
    return conceptIds.length ? [{ projectId: project.id, conceptIds }] : [];
  });
  const debt = deriveLearningDebt({
    mastery: records,
    events: eventRecords,
    attempts: attempts.map(({ conceptId, dimension, correct, hintsUsed }) => ({
      conceptId,
      dimension,
      correct,
      hintsUsed,
    })),
    remediationFlags: input.flags.map((flag) => ({
      conceptId: flag.conceptId,
      targetPrereqId: flag.targetPrereqId ?? undefined,
    })),
    labFailures,
  });
  const dateKey = (date: Date) => localDateKey(date, timeZone);
  const today = dateKey(now);
  const studyTimeHours = input.xpEvents.reduce((total, event) => total + event.amount, 0) / 60;
  const streak = buildStreak(input.xpEvents, today);
  const orderedCourseIds = orderCourseIdsBySubject(content);
  const courseUrl = (conceptId: string) => {
    const courseId = orderedCourseIds.find((id) =>
      content.coursesById.get(id)?.units.some((unit) => unit.concepts.includes(conceptId)),
    );
    return courseId ? `/courses/${courseId}` : '/courses';
  };
  const courses = input.subjects.flatMap((subject) => subject.courses);
  return {
    topicsDone: courses.reduce((total, course) => total + course.topicsDone, 0),
    topicsTotal: courses.reduce((total, course) => total + course.topicsTotal, 0),
    studyTimeHours,
    subjects: input.subjects,
    debt: debt.map((item) => ({
      ...item,
      title: content.conceptsById.get(item.conceptId)?.title ?? item.conceptId,
      studyUrl: courseUrl(item.conceptId),
    })),
    evidence: attempts.slice(0, 20).map((attempt) => ({
      id: attempt.id,
      exerciseId: attempt.exerciseId,
      conceptId: attempt.conceptId,
      correct: attempt.correct,
      conceptTitle: content.conceptsById.get(attempt.conceptId)?.title ?? attempt.conceptId,
      createdAt: attempt.createdAt,
      event: input.events.find((event) => event.attemptId === attempt.id)?.rule ?? null,
    })),
    streakDays: streak.current,
    streak,
  };
}

function toIso(date: Date | string) {
  return date instanceof Date ? date.toISOString() : date;
}

const masteryStates: ProgressMasteryState[] = [
  'not_assessed',
  'introduced',
  'assisted',
  'independent',
  'retained',
];

export function buildProgressSubjects(
  content: ContentIndex,
  courseIds: readonly string[],
  records: MasteryRecord[],
  runs: LessonRun[],
): ProgressSubjectPayload[] {
  const topicState = courseTopicState(content, records, runs, new Set());
  const masteryByKey = new Map(
    records.map((record) => [`${record.conceptId}:${record.dimension}`, record.state]),
  );
  const subjects = new Map<string, ProgressSubjectPayload>();
  for (const courseId of orderCourseIdsBySubject(content, courseIds)) {
    const course = content.coursesById.get(courseId);
    if (!course) continue;
    const subject = subjectForCourse(content, courseId);
    let group = subjects.get(subject.id);
    if (!group) {
      group = { id: subject.id, title: subject.title, courses: [] };
      subjects.set(subject.id, group);
    }
    const conceptIds = course.units.flatMap((unit) => unit.concepts);
    const masteryCounts = Object.fromEntries(masteryStates.map((state) => [state, 0])) as Record<
      ProgressMasteryState,
      number
    >;
    let lessonsComingSoon = 0;
    let topicsDone = 0;
    for (const conceptId of conceptIds) {
      const concept = content.conceptsById.get(conceptId);
      if (!concept) continue;
      if (topicState(concept).status === 'complete') topicsDone += 1;
      if (concept.status === 'stub') {
        lessonsComingSoon += 1;
        continue;
      }
      const bestState = concept.dimensions
        .map(
          (dimension) =>
            masteryByKey.get(`${concept.id}:${dimension}`) ?? ('not_assessed' as const),
        )
        .reduce<ProgressMasteryState>(
          (best, state) => (masteryRank(state) > masteryRank(best) ? state : best),
          'not_assessed',
        );
      masteryCounts[bestState] += 1;
    }
    group.courses.push({
      id: course.id,
      title: course.title,
      topicsDone,
      topicsTotal: conceptIds.length,
      masteryCounts,
      lessonsComingSoon,
    });
  }
  return [...subjects.values()];
}

export async function readProgress(
  store: CourseStore,
  input: {
    userId: string;
    content: ContentIndex;
    timeZone: string;
    now: () => Date;
    studyCourseIds: () => Promise<readonly string[]>;
  },
) {
  const { userId, content, timeZone } = input;
  const [records, recent, events, flags, submissions, xpEvents, runs, studyCourseIds] =
    await Promise.all([
      store.listMastery(userId),
      store.listAttempts(userId, { order: 'recent', limit: 100 }),
      store.listMasteryEvents(userId, { limit: 100 }),
      store.listRemediationFlags(userId, { status: 'open' }),
      store.listProjectSubmissions(userId, { limit: 50 }),
      store.listXpEvents(userId, {}),
      store.listLessonRuns(userId),
      input.studyCourseIds(),
    ]);
  recent.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  const masteryRecords = filterMasteryRecordsForContent(content, records);
  const contentRuns = runs.filter((run) => content.conceptsById.has(run.conceptId));
  const contentAttempts = recent.filter((attempt) => {
    const exercise = content.exercisesById.get(attempt.exerciseId);
    return content.conceptsById.has(attempt.conceptId) && exercise?.concept === attempt.conceptId;
  });
  const now = input.now();
  events.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  submissions.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  return buildProgress({
    content,
    records: masteryRecords,
    events: events
      .filter((event) => content.conceptsById.has(event.conceptId))
      .map((event) => ({
        ...event,
        attemptId: event.attemptId ?? undefined,
        dimension: event.dimension as MasteryRecord['dimension'],
      })),
    attempts: contentAttempts.map((attempt) => ({
      ...attempt,
      dimension: attempt.dimension as MasteryRecord['dimension'],
    })),
    flags: flags.filter(
      (flag) =>
        content.conceptsById.has(flag.conceptId) &&
        (!flag.targetPrereqId || content.conceptsById.has(flag.targetPrereqId)),
    ),
    submissions: submissions.filter((submission) => content.projectsById.has(submission.projectId)),
    subjects: buildProgressSubjects(content, studyCourseIds, masteryRecords, contentRuns),
    xpEvents,
    now,
    timeZone,
  });
}
