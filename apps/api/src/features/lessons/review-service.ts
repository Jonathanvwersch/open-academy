import { and, eq } from 'drizzle-orm';
import { getLessonPrerequisites } from '../../content/index.js';
import { serializeExercise, serializeLesson } from '../../content/serialize.js';
import { isTemplate } from '../../content/templates.js';
import { lessonProblems, lessonRuns } from '../../db/schema.js';
import { deriveLessonState } from '../../learning/lesson-runner.js';
import { masteryRank } from '../../learning/types.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';
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
  const [run] = lesson.knowledge_points?.length
    ? await deps.db
        .select()
        .from(lessonRuns)
        .where(and(eq(lessonRuns.userId, request.userId), eq(lessonRuns.conceptId, conceptId)))
        .limit(1)
    : [];
  const rows = run
    ? await deps.db.select().from(lessonProblems).where(eq(lessonProblems.runId, run.id))
    : [];
  return serviceResult({
    course: await resolveLessonCourse(deps.db, request.repo, index, request.userId, conceptId),
    lesson: serializeLesson({
      ...lesson,
      prerequisites: getLessonPrerequisites(index, conceptId),
    }),
    checkAnswers,
    checks,
    runStatus: run
      ? deriveLessonState(lesson, rows, index.exercisesById, run.quizPassedAt).status
      : null,
    conceptTitle: index.conceptsById.get(conceptId)?.title ?? conceptId,
  });
}
