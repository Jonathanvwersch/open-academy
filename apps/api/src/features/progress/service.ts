import type {
  ProgressMasteryState,
  ProgressSubjectPayload,
} from '@open-academy/engine/api/progress';
import { orderCourseIdsBySubject } from '@open-academy/engine/course/course-order';
import { courseTopicState } from '@open-academy/engine/course/course-payload';
import { subjectForCourse } from '@open-academy/engine/course/index';
import type { ContentIndex } from '@open-academy/engine/course/types';
import { filterMasteryRecordsForContent } from '@open-academy/engine/graph/content-filters';
import { type MasteryRecord, masteryRank } from '@open-academy/engine/memory/types';
import { buildProgress } from '@open-academy/engine/progress/progress';
import { and, desc, eq } from 'drizzle-orm';
import { drizzleLearnerStore } from '../../db/learner-store.js';
import {
  attempts,
  lessonRuns,
  masteryEvents,
  projectSubmissions,
  remediationFlags,
} from '../../db/schema.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';

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
  runs: Array<typeof lessonRuns.$inferSelect>,
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

export async function getProgress(deps: FeatureServices, request: FeatureRequest) {
  const { db, content } = deps;
  const index = await content();
  const repo = request.repo;
  const store = drizzleLearnerStore(db);
  const [records, recent, events, flags, submissions, earnedXp, runs, activeCourseIds] =
    await Promise.all([
      store.listMastery(request.userId),
      db
        .select()
        .from(attempts)
        .where(eq(attempts.userId, request.userId))
        .orderBy(desc(attempts.createdAt))
        .limit(100),
      db
        .select()
        .from(masteryEvents)
        .where(eq(masteryEvents.userId, request.userId))
        .orderBy(desc(masteryEvents.createdAt))
        .limit(100),
      db
        .select()
        .from(remediationFlags)
        .where(
          and(eq(remediationFlags.userId, request.userId), eq(remediationFlags.status, 'open')),
        ),
      db
        .select()
        .from(projectSubmissions)
        .where(eq(projectSubmissions.userId, request.userId))
        .orderBy(desc(projectSubmissions.createdAt))
        .limit(50),
      store.listXpEvents(request.userId, {}),
      db.select().from(lessonRuns).where(eq(lessonRuns.userId, request.userId)),
      repo.studyCourseIds(index),
    ]);
  const masteryRecords = filterMasteryRecordsForContent(index, records);
  const contentRuns = runs.filter((run) => index.conceptsById.has(run.conceptId));
  const contentAttempts = recent.filter((attempt) => {
    const exercise = index.exercisesById.get(attempt.exerciseId);
    return index.conceptsById.has(attempt.conceptId) && exercise?.concept === attempt.conceptId;
  });
  return serviceResult(
    buildProgress({
      content: index,
      records: masteryRecords,
      events: events
        .filter((event) => index.conceptsById.has(event.conceptId))
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
          index.conceptsById.has(flag.conceptId) &&
          (!flag.targetPrereqId || index.conceptsById.has(flag.targetPrereqId)),
      ),
      submissions: submissions.filter((submission) => index.projectsById.has(submission.projectId)),
      subjects: buildProgressSubjects(index, activeCourseIds, masteryRecords, contentRuns),
      xpEvents: earnedXp,
      now: request.now(),
      timeZone: request.timeZone,
    }),
  );
}
