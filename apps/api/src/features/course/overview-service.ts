import { serializeConcept } from '@academy/aesop/course/serialize';
import {
  activeCourseFor,
  compareOutlinePosition,
  courseFoundationIds,
} from '@academy/aesop/graph/prerequisites';
import { deriveLearningDebt } from '@academy/aesop/memory/debt';
import type { MasteryRecord } from '@academy/aesop/memory/types';
import type { StudyMapPayload } from '@academy/contracts/course';
import { eq } from 'drizzle-orm';
import { lessonRuns, placementGrants } from '../../db/schema.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';
import { courseTopicState, placedOutConceptsFromGrants } from './service.js';

export async function getStudyMap(deps: FeatureServices, request: FeatureRequest) {
  const index = await deps.content();
  const courseIds = await request.repo.studyCourseIds(index);
  const payload: StudyMapPayload = { groups: [], nodes: [], edges: [] };
  if (courseIds.length === 0) return serviceResult(payload);
  const [mastery, runs, placements] = await Promise.all([
    request.repo.masteryRecords(),
    deps.db.select().from(lessonRuns).where(eq(lessonRuns.userId, request.userId)),
    deps.db
      .select({
        conceptId: placementGrants.conceptId,
        state: placementGrants.state,
        createdAt: placementGrants.createdAt,
      })
      .from(placementGrants)
      .where(eq(placementGrants.userId, request.userId)),
  ]);
  const topicState = courseTopicState(
    index,
    mastery,
    runs,
    placedOutConceptsFromGrants(placements),
  );
  const groupByConcept = new Map<string, string>();
  const courseConcepts = new Map<string, Set<string>>();
  for (const courseId of courseIds) {
    const course = index.coursesById.get(courseId);
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
  const foundationIds = new Set(courseIds.flatMap((id) => [...courseFoundationIds(index, id)]));
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
    const concept = index.conceptsById.get(id);
    if (!concept) continue;
    const state = topicState(concept);
    payload.nodes.push({
      id,
      title: concept.title,
      groupId,
      status: state.status,
      placedOut: state.placedOut,
      lessonAvailable: index.lessonsByConcept.has(id),
      missingPrereqTitles: state.missingPrereqs
        .sort((left, right) =>
          compareOutlinePosition(
            left.id,
            right.id,
            index,
            groupId === 'foundations' ? courseIds[0] : groupId,
          ),
        )
        .map((prerequisite) => index.conceptsById.get(prerequisite.id)?.title ?? prerequisite.id),
    });
  }
  const nodeIds = new Set(payload.nodes.map((node) => node.id));
  payload.edges = payload.nodes.flatMap((node) =>
    (index.conceptsById.get(node.id)?.prereqs ?? [])
      .filter((prerequisite) => prerequisite.strength === 'hard' && nodeIds.has(prerequisite.id))
      .map((prerequisite) => ({ from: prerequisite.id, to: node.id })),
  );
  return serviceResult(payload);
}

export async function getConceptsById(deps: FeatureServices, request: FeatureRequest) {
  const { content } = deps;
  const index = await content();
  const concept = index.conceptsById.get(request.params.id);
  if (!concept) {
    return serviceResult({ error: 'Concept not found' }, 404);
  }
  const repo = request.repo;
  const debt = deriveLearningDebt({
    mastery: await repo.masteryRecords(),
    events: (await repo.events(concept.id)).map((event) => ({
      conceptId: event.conceptId,
      dimension: event.dimension as MasteryRecord['dimension'],
      fromState: event.fromState,
      toState: event.toState,
      rule: event.rule,
      createdAt: event.createdAt.toISOString(),
    })),
    attempts: (await repo.recentAttempts()).map((attempt) => ({
      conceptId: attempt.conceptId,
      dimension: attempt.dimension as MasteryRecord['dimension'],
      correct: attempt.correct,
      hintsUsed: attempt.hintsUsed,
    })),
    remediationFlags: (await repo.openFlags()).map((flag) => ({
      conceptId: flag.conceptId,
      targetPrereqId: flag.targetPrereqId ?? undefined,
    })),
  });
  return serviceResult({
    concept: serializeConcept(concept),
    lessonAvailable: index.lessonsByConcept.has(concept.id),
    mastery: (await repo.masteryRecords()).filter((record) => record.conceptId === concept.id),
    events: await repo.events(concept.id),
    debt: debt.filter((entry) => entry.conceptId === concept.id),
  });
}

export async function getPlanWeek(deps: FeatureServices, request: FeatureRequest) {
  const { content } = deps;
  const index = await content();
  const state = await request.repo.schedulerState(request.now(), index);
  return serviceResult({
    units: activeCourseFor(index, state.studyCourseIds[0] ?? state.activeCourseId)?.units ?? [],
    mastery: state.mastery,
  });
}
