import { getLessonPrerequisites } from '../../content/index.js';
import { serializeLesson } from '../../content/serialize.js';
import { masteryRank } from '../../learning/types.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';

export async function getLessonsByConceptId(deps: FeatureServices, request: FeatureRequest) {
  const { content } = deps;
  const index = await content();
  const conceptId = request.params.conceptId;
  const lesson = index.lessonsByConcept.get(conceptId);
  const priorEvidence = (await request.repo.masteryRecords()).some(
    (record) =>
      record.conceptId === conceptId &&
      (record.inferred || masteryRank(record.state) >= masteryRank('assisted')),
  );
  const presentedLesson =
    lesson && priorEvidence
      ? {
          ...lesson,
          blocks: lesson.blocks.filter(
            (block) =>
              block.kind === 'objective' ||
              block.kind === 'summary' ||
              !lesson.fast_path.includes(block.kind),
          ),
        }
      : lesson;
  return presentedLesson
    ? serviceResult(
        serializeLesson({
          ...presentedLesson,
          prerequisites: getLessonPrerequisites(index, conceptId),
        }),
      )
    : serviceResult({ error: 'Lesson not found' }, 404);
}

export async function getLessonsByConceptIdReview(deps: FeatureServices, request: FeatureRequest) {
  const { content } = deps;
  const index = await content();
  const conceptId = request.params.conceptId;
  const lesson = index.lessonsByConcept.get(conceptId);
  if (!lesson) return serviceResult({ error: 'Lesson not found' }, 404);
  const checkAnswers = Object.fromEntries(
    lesson.blocks.flatMap((block) =>
      block.kind === 'check' && block.exercise
        ? [[block.exercise, index.exercisesById.get(block.exercise)?.solution ?? '']]
        : [],
    ),
  );
  return serviceResult({
    lesson: serializeLesson({
      ...lesson,
      prerequisites: getLessonPrerequisites(index, conceptId),
    }),
    checkAnswers,
    conceptTitle: index.conceptsById.get(conceptId)?.title ?? conceptId,
  });
}
