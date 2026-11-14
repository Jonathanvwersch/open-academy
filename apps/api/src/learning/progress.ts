import type { ContentIndex } from '../content/types.js';
import { deriveLearningDebt } from './debt.js';
import { buildStreak } from './streak.js';
import type { MasteryEvent, MasteryRecord, MasteryState } from './types.js';
import { localDateKey, type XpEventDate } from './xp.js';

const states: MasteryState[] = [
  'not_assessed',
  'introduced',
  'assisted',
  'independent',
  'retained',
];

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
  sessions: Array<{ activeSeconds: number; status: string; startedAt: Date | null }>;
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
  const goalConceptIds = [
    ...new Set(content.curriculum?.goals.flatMap((goal) => goal.concepts) ?? []),
  ].filter((id) => content.conceptsById.get(id)?.status === 'authored');
  const mastered = goalConceptIds.filter((conceptId) => {
    const concept = content.conceptsById.get(conceptId);
    return Boolean(
      concept?.dimensions.length &&
        concept.dimensions.every((dimension) =>
          records.some(
            (record) =>
              record.conceptId === conceptId &&
              record.dimension === dimension &&
              (record.state === 'independent' || record.state === 'retained'),
          ),
        ),
    );
  });
  const dateKey = (date: Date) => localDateKey(date, timeZone);
  const today = dateKey(now);
  const seconds = input.sessions.reduce(
    (total, session) =>
      total +
      session.activeSeconds +
      (session.status === 'active' && session.startedAt && dateKey(session.startedAt) === today
        ? Math.max(0, Math.floor((now.getTime() - session.startedAt.getTime()) / 1000))
        : 0),
    0,
  );
  const streak = buildStreak(input.xpEvents, today);
  const domains = (content.curriculum?.domains ?? []).map((domain) => {
    const concepts = content.concepts.filter(
      (concept) => concept.domain === domain.id && concept.status === 'authored',
    );
    const masteryByKey = new Map(
      records.map((record) => [`${record.conceptId}:${record.dimension}`, record.state]),
    );
    const authoredStates = concepts.flatMap((concept) =>
      concept.dimensions.map(
        (dimension) => masteryByKey.get(`${concept.id}:${dimension}`) ?? ('not_assessed' as const),
      ),
    );
    const counts = Object.fromEntries(
      states.map((state) => [
        state,
        authoredStates.filter((masteryState) => masteryState === state).length,
      ]),
    ) as Record<MasteryState, number>;
    return { id: domain.id, title: domain.title, counts };
  });
  return {
    domains,
    goal: { mastered: mastered.length, total: goalConceptIds.length },
    debt: debt.map((item) => ({
      ...item,
      title: content.conceptsById.get(item.conceptId)?.title ?? item.conceptId,
      studyUrl: `/map?concept=${item.conceptId}`,
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
    hours: seconds / 3600,
    planHours: 132,
    streakDays: streak.current,
    streak,
  };
}

function toIso(date: Date | string) {
  return date instanceof Date ? date.toISOString() : date;
}
