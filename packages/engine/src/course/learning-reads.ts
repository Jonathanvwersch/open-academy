import type { StudyMapPayload } from '../api/course.js';
import {
  activeCourseFor,
  compareOutlinePosition,
  courseFoundationIds,
} from '../graph/prerequisites.js';
import { deriveLearningDebt } from '../memory/debt.js';
import type { MasteryRecord } from '../memory/types.js';
import type { SchedulerState } from '../planner/scheduler.js';
import type { CourseStore } from '../store/course-store.js';
import { courseTopicState, placedOutConceptsFromGrants } from './course-payload.js';
import { serializeConcept } from './serialize.js';
import type { ContentIndex } from './types.js';

export async function studyMap(
  store: CourseStore,
  input: { userId: string; content: ContentIndex; courseIds: readonly string[] },
): Promise<StudyMapPayload> {
  const { userId, content, courseIds } = input;
  const payload: StudyMapPayload = { groups: [], nodes: [], edges: [] };
  if (courseIds.length === 0) return payload;
  const [mastery, runs, placements] = await Promise.all([
    store.listMastery(userId),
    store.listLessonRuns(userId),
    store.listPlacementGrants(userId),
  ]);
  const topicState = courseTopicState(
    content,
    mastery,
    runs,
    placedOutConceptsFromGrants(placements),
  );
  const groupByConcept = new Map<string, string>();
  const courseConcepts = new Map<string, Set<string>>();
  for (const courseId of courseIds) {
    const course = content.coursesById.get(courseId);
    if (!course) continue;
    const concepts = new Set(course.units.flatMap((unit) => unit.concepts));
    courseConcepts.set(courseId, concepts);
    payload.groups.push({
      id: courseId,
      title: course.title,
      kind: 'course',
      sharedTopicGroupIds: [],
    });
    for (const id of concepts) {
      const owner = groupByConcept.get(id);
      if (!owner || concepts.size < (courseConcepts.get(owner)?.size ?? Infinity))
        groupByConcept.set(id, courseId);
    }
  }
  const foundationIds = new Set(courseIds.flatMap((id) => [...courseFoundationIds(content, id)]));
  for (const id of foundationIds) {
    if (!groupByConcept.has(id)) groupByConcept.set(id, 'foundations');
  }
  if ([...groupByConcept.values()].includes('foundations')) {
    payload.groups.unshift({
      id: 'foundations',
      title: 'Foundations',
      kind: 'foundations',
      sharedTopicGroupIds: [],
    });
  }
  for (const group of payload.groups) {
    const owners = new Set(
      [...(courseConcepts.get(group.id) ?? [])].map((id) => groupByConcept.get(id)),
    );
    group.sharedTopicGroupIds = payload.groups
      .filter((other) => other.id !== group.id && owners.has(other.id))
      .map((other) => other.id);
  }
  for (const [id, groupId] of groupByConcept) {
    const concept = content.conceptsById.get(id);
    if (!concept) continue;
    const state = topicState(concept);
    payload.nodes.push({
      id,
      title: concept.title,
      groupId,
      status: state.status,
      placedOut: state.placedOut,
      lessonAvailable: content.lessonsByConcept.has(id),
      missingPrereqTitles: state.missingPrereqs
        .sort((left, right) =>
          compareOutlinePosition(
            left.id,
            right.id,
            content,
            groupId === 'foundations' ? courseIds[0] : groupId,
          ),
        )
        .map((prerequisite) => content.conceptsById.get(prerequisite.id)?.title ?? prerequisite.id),
    });
  }
  const nodeIds = new Set(payload.nodes.map((node) => node.id));
  payload.edges = payload.nodes.flatMap((node) =>
    (content.conceptsById.get(node.id)?.prereqs ?? [])
      .filter((prerequisite) => prerequisite.strength === 'hard' && nodeIds.has(prerequisite.id))
      .map((prerequisite) => ({ from: prerequisite.id, to: node.id })),
  );
  return payload;
}

export async function conceptDetail(
  store: CourseStore,
  input: { userId: string; content: ContentIndex; conceptId: string },
) {
  const { userId, content, conceptId } = input;
  const concept = content.conceptsById.get(conceptId);
  if (!concept) return undefined;
  const [mastery, events, attempts, flags] = await Promise.all([
    store.listMastery(userId),
    store.listMasteryEvents(userId, { conceptId }),
    store.listAttempts(userId, { order: 'recent', limit: 100 }),
    store.listRemediationFlags(userId, { status: 'open' }),
  ]);
  events.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  attempts.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  const debt = deriveLearningDebt({
    mastery,
    events: events.map((event) => ({
      conceptId: event.conceptId,
      dimension: event.dimension as MasteryRecord['dimension'],
      fromState: event.fromState,
      toState: event.toState,
      rule: event.rule,
      createdAt: event.createdAt.toISOString(),
    })),
    attempts: attempts.map((attempt) => ({
      conceptId: attempt.conceptId,
      dimension: attempt.dimension as MasteryRecord['dimension'],
      correct: attempt.correct,
      hintsUsed: attempt.hintsUsed,
    })),
    remediationFlags: flags.map((flag) => ({
      conceptId: flag.conceptId,
      targetPrereqId: flag.targetPrereqId ?? undefined,
    })),
  });
  return {
    concept: serializeConcept(concept),
    lessonAvailable: content.lessonsByConcept.has(concept.id),
    mastery: mastery.filter((record) => record.conceptId === concept.id),
    events,
    debt: debt.filter((entry) => entry.conceptId === concept.id),
  };
}

export function planWeek(content: ContentIndex, state: SchedulerState) {
  return {
    units: activeCourseFor(content, state.studyCourseIds[0] ?? state.activeCourseId)?.units ?? [],
    mastery: state.mastery,
  };
}
