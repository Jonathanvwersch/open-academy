import type { ProgressSubjectPayload } from '@academy/aesop/api/progress';
import { orderCourseIdsBySubject } from '../course/course-order.js';
import type { ContentIndex } from '../course/types.js';
import { deriveLearningDebt } from '../memory/debt.js';
import type { MasteryEvent, MasteryRecord } from '../memory/types.js';
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
