import { serializeConcept } from '../../content/serialize.js';
import { deriveLearningDebt } from '../../learning/debt.js';
import { activeCourseFor } from '../../learning/prerequisites.js';
import { currentLearnerUnit } from '../../learning/scheduler.js';
import type { MasteryRecord } from '../../learning/types.js';
import { initialMastery, masteryRank } from '../../learning/types.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';

export async function getMap(deps: FeatureServices, request: FeatureRequest) {
  const { content } = deps;
  const index = await content();
  const requestedDomain = request.query.domain;
  const state = await request.repo.schedulerState(request.now(), index);
  const courseId = state.studyCourseIds[0] ?? state.activeCourseId;
  const activeCourse = activeCourseFor(index, courseId);
  const currentUnit = currentLearnerUnit({ ...state, activeCourseId: courseId }, index);
  const currentUnitDomain =
    activeCourse?.units[currentUnit - 1]?.concepts
      .map((id) => index.conceptsById.get(id)?.domain)
      .find((value): value is string => Boolean(value)) ??
    index.curriculum?.domains[0]?.id ??
    '';
  const domain = requestedDomain === 'all' ? '' : (requestedDomain ?? currentUnitDomain);
  const concepts = domain
    ? index.concepts.filter((concept) => concept.domain === domain)
    : index.concepts;
  const byKey = new Map(
    state.mastery.map((record) => [`${record.conceptId}:${record.dimension}`, record]),
  );
  const nodes = concepts.map((concept) => {
    const dimensions = Object.fromEntries(
      concept.dimensions.map((dimension) => [
        dimension,
        byKey.get(`${concept.id}:${dimension}`) ?? initialMastery(concept.id, dimension),
      ]),
    );
    const prereqs = concept.prereqs.filter((prereq) => prereq.strength === 'hard');
    const available = prereqs.every((prereq) =>
      index.conceptsById.get(prereq.id)?.dimensions.some((dimension) => {
        const record = byKey.get(`${prereq.id}:${dimension}`);
        return (
          record?.inferred ||
          masteryRank(record?.state ?? 'not_assessed') >= masteryRank('assisted')
        );
      }),
    );
    return {
      ...serializeConcept(concept),
      dimensions,
      available,
      hasLesson: index.lessonsByConcept.has(concept.id),
    };
  });
  return serviceResult({
    nodes,
    edges: index.edges.filter((edge) => concepts.some((concept) => concept.id === edge.conceptId)),
    domains: (index.curriculum?.domains ?? []).map(({ id, title }) => ({ id, title })),
    currentWeekDomain: currentUnitDomain,
  });
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
