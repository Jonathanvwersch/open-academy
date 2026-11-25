import { getLessonPrerequisites } from '@academy/aesop/course/index';
import { serializeExercise, serializeLesson } from '@academy/aesop/course/serialize';
import { isTemplate } from '@academy/aesop/course/templates';
import { readLessonReviewStatus } from '@academy/aesop/lessons/run-state';
import { masteryRank } from '@academy/aesop/memory/types';
import { drizzleLearnerStore } from '../../db/learner-store.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';
import { courseTopicState } from '../course/service.js';
import { resolveLessonCourse } from './course-context.js';

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
  const concept = index.conceptsById.get(conceptId);
  if (!concept) return serviceResult({ error: 'Lesson not found' }, 404);
  const checkAnswers = Object.fromEntries(
    lesson.blocks.flatMap((block) =>
      block.kind === 'check' && block.exercise
        ? [[block.exercise, index.exercisesById.get(block.exercise)?.solution ?? '']]
        : [],
    ),
  );
  const visibleChecks = lesson.blocks.filter(
    (block) =>
      block.kind === 'check' &&
      (!lesson.knowledge_points?.length || block.exercise === lesson.final),
  );
  const checks = Object.fromEntries(
    visibleChecks.flatMap((block) => {
      if (block.kind !== 'check') return [];
      const exercise = block.exercise ? index.exercisesById.get(block.exercise) : undefined;
      return exercise && !isTemplate(exercise)
        ? [[exercise.id, serializeExercise(exercise, request.userId)]]
        : [];
    }),
  );
  const store = drizzleLearnerStore(deps.db);
  const runRowsPromise = store.listLessonRuns(request.userId);
  const [runRows, masteryRecords, course] = await Promise.all([
    runRowsPromise,
    runRowsPromise.then((rows) =>
      rows.some((row) => row.conceptId === conceptId) ? [] : request.repo.masteryRecords(),
    ),
    resolveLessonCourse(deps.db, request.repo, index, request.userId, conceptId),
  ]);
  const run = runRows.find((row) => row.conceptId === conceptId);
  const runStatus = await readLessonReviewStatus(store, request.userId, run, lesson, index);
  const topicState = courseTopicState(index, masteryRecords, runRows, new Set())(concept);
  return serviceResult({
    course,
    canRestart:
      runRows.some((row) => row.conceptId === conceptId) ||
      topicState.dimensionStates.some((state) => state !== 'not_assessed'),
    lesson: serializeLesson({
      ...lesson,
      prerequisites: getLessonPrerequisites(index, conceptId),
    }),
    checkAnswers,
    checks,
    runStatus,
    conceptTitle: index.conceptsById.get(conceptId)?.title ?? conceptId,
  });
}
