import type {
  CourseOutlineUnit,
  PaperTutorContext,
  TutorContextInput,
  TutorPrompt,
  TutorTurn,
} from '../api/tutor.js';
import { buildCoursePayload } from '../course/course-payload.js';
import { onScreenOptions } from '../course/option-order.js';
import { serializedOptionOrder } from '../course/serialize.js';
import { instantiateExercise, isTemplate } from '../course/templates.js';
import { type EngineRequest, type EngineResult, respond } from '../engine/types.js';
import { courseFoundationIds } from '../graph/prerequisites.js';
import { attemptAllowsRetry } from '../memory/retry.js';
import type { Attempt } from '../store/core-store.js';
import type { LessonProblem } from '../store/lesson-store.js';
import {
  formatGraderFeedback,
  graderVerdictFor,
  tutorAnswerFor,
  tutorAnswerKeyFor,
  tutorSolutionFor,
} from './feedback-context.js';
import { buildTutorPageContent } from './page-context.js';

const tutorActivityKinds = new Set(['learn', 'practice', 'remediate', 'transfer', 'teachback']);

export async function tutorContextOperation(
  request: EngineRequest,
  input: TutorContextInput,
): Promise<EngineResult> {
  const { store, userId, content: index } = request;
  if (input.page === 'paper' && !input.paperId) {
    return respond({ error: 'Paper id is required for paper context' }, 400);
  }
  if (input.page === 'paper' && !index.papersById.has(input.paperId ?? '')) {
    return respond({ error: 'Paper not found' }, 404);
  }

  let exerciseId = input.exerciseId;
  let lessonProblem: LessonProblem | undefined;
  let currentAttempt: Attempt | undefined;
  let activityId = input.activityId;
  let status: 'unanswered' | 'retrying' | 'answered' | 'none' = 'none';

  if (input.lessonProblemId) {
    const runs = await store.listLessonRuns(userId);
    const problems = await store.listCourseLessonProblems(
      userId,
      runs.map(({ id }) => id),
    );
    const problem = problems.find(({ id }) => id === input.lessonProblemId);
    if (!problem) return respond({ error: 'Problem not found' }, 404);
    if (input.exerciseId && input.exerciseId !== problem.exerciseId) {
      return respond({ error: 'Lesson problem does not match the exercise.' }, 403);
    }
    lessonProblem = problem;
    exerciseId = problem.exerciseId;
    status = problem.answeredAt ? 'answered' : 'unanswered';
    if (problem.attemptId) {
      [currentAttempt] = await store.listAttempts(userId, { ids: [problem.attemptId] });
    }
    activityId = currentAttempt?.activityId ?? activityId;
  } else if (input.exerciseId) {
    if (!input.activityId) return respond({ error: 'Activity required' }, 400);
    const [activity] = await store.listActivities(userId, { ids: [input.activityId] });
    if (!activity || !tutorActivityKinds.has(activity.kind)) {
      return respond({ error: 'Tutor unavailable for this activity' }, 403);
    }
    const attempts = await store.listAttempts(userId, {
      activityIds: [input.activityId],
      exerciseIds: [input.exerciseId],
    });
    currentAttempt = attempts.sort((left, right) => right.attemptNo - left.attemptNo)[0];
    status = !currentAttempt
      ? 'unanswered'
      : attemptAllowsRetry(currentAttempt)
        ? 'retrying'
        : 'answered';
  }

  let exercise = exerciseId ? index.exercisesById.get(exerciseId) : undefined;
  if (exercise && isTemplate(exercise)) {
    if (!lessonProblem) {
      return respond({ error: 'Template exercises require a lesson problem.' }, 400);
    }
    const template = exercise;
    const concrete = instantiateExercise(template, lessonProblem.seed ?? 0).exercise;
    exercise = {
      ...concrete,
      concept: template.concept,
      contentVersion: template.contentVersion,
    };
  }
  if (exercise?.role === 'recall') {
    return respond({ error: 'Review recall exercises are not available to the tutor.' }, 403);
  }
  if (exercise?.role === 'diagnostic') {
    return respond({ error: 'Placement check exercises do not allow tutor answers.' }, 403);
  }
  if (activityId) {
    const [activity] = await store.listActivities(userId, { ids: [activityId] });
    if (!activity || !tutorActivityKinds.has(activity.kind)) {
      return respond({ error: 'Tutor unavailable for this activity' }, 403);
    }
  }
  if (exerciseId && !exercise) return respond({ error: 'Exercise not found' }, 404);

  const conceptId = exercise?.concept ?? input.conceptId ?? input.threadConceptId ?? null;
  const concept = conceptId ? index.conceptsById.get(conceptId) : undefined;
  const lesson = conceptId ? index.lessonsByConcept.get(conceptId) : undefined;
  const pageConceptId = exercise?.concept ?? input.conceptId ?? null;
  const courseState =
    input.page === 'course' ? await request.repo.schedulerState(request.now(), index) : undefined;
  const matchingCourseIds =
    input.page === 'paper' && input.paperId
      ? index.courses
          .filter((candidate) =>
            candidate.units.some((unit) => unit.papers?.includes(input.paperId ?? '')),
          )
          .map((candidate) => candidate.id)
      : pageConceptId
        ? index.courses
            .filter((candidate) =>
              candidate.units.some((unit) => unit.concepts.includes(pageConceptId)),
            )
            .map((candidate) => candidate.id)
        : [];
  const contextCourseId = courseState
    ? (courseState.studyCourseIds.find(
        (courseId) =>
          matchingCourseIds.includes(courseId) ||
          (pageConceptId && courseFoundationIds(index, courseId).has(pageConceptId)),
      ) ??
      matchingCourseIds[0] ??
      courseState.studyCourseIds[0] ??
      courseState.activeCourseId)
    : undefined;
  const courseUnits: CourseOutlineUnit[] | undefined = courseState
    ? buildCoursePayload(
        index,
        contextCourseId,
        courseState.mastery,
        await store.listLessonRuns(userId),
      ).units
    : undefined;

  let paperContext: PaperTutorContext | undefined;
  if (input.page === 'paper' && input.paperId) {
    const paper = index.papersById.get(input.paperId);
    if (paper) {
      const learnerPaper = await request.tutorPaper?.(paper.id, input.pageNumber ?? 1);
      paperContext = {
        title: paper.title,
        authors: paper.authors,
        year: paper.year,
        whyThisWeek: paper.why_this_week,
        questions: paper.questions,
        notes: learnerPaper?.notes ?? {},
        summary: learnerPaper?.summary,
        feedback: learnerPaper?.feedback,
        pages: learnerPaper?.pages ?? [],
      };
    }
  }

  const pageContent = buildTutorPageContent({
    page: input.page,
    index,
    conceptId: pageConceptId,
    knowledgePointId: lessonProblem?.knowledgePointId ?? input.knowledgePointId,
    lessonStage: input.lessonStage,
    exerciseId,
    exercisePrompt: exercise?.prompt,
    questionLabel: input.questionLabel,
    courseUnits,
    paper: paperContext,
    paperId: input.paperId,
    pageNumber: input.pageNumber,
    selection: input.selection,
  });
  const correct = currentAttempt?.correct ?? lessonProblem?.correct;
  const optionTexts =
    exercise?.type === 'mc'
      ? onScreenOptions(serializedOptionOrder(exercise.options, userId, exercise.id), exercise.id)
      : exercise?.type === 'debug'
        ? onScreenOptions(exercise.fix_options, exercise.id)
        : [];

  const prompt: TutorPrompt = {
    conceptTitle: concept?.title ?? 'General',
    objectives: concept?.objectives.map((objective) => objective.text) ?? [],
    lessonSummary:
      lesson?.blocks
        .filter((block) => block.kind === 'summary')
        .map((block) => block.md)
        .join('\n') ?? '',
    exercisePrompt: exercise?.prompt ?? '',
    exerciseLabel: exercise ? input.questionLabel || 'Current question' : '',
    exerciseOptions: optionTexts.map(
      ({ text }, position) => `${String.fromCharCode(65 + position)}. ${text}`,
    ),
    answerKey: tutorAnswerKeyFor(exercise, optionTexts),
    learnerAnswer:
      (status === 'retrying' || status === 'answered') && currentAttempt && exercise
        ? tutorAnswerFor(exercise, currentAttempt.answer)
        : '',
    graderVerdict: status === 'retrying' || status === 'answered' ? graderVerdictFor(correct) : '',
    graderFeedback:
      (status === 'retrying' || status === 'answered') && currentAttempt
        ? formatGraderFeedback(currentAttempt.feedback, status === 'retrying')
        : '',
    hintLevel: 0,
    authoredHints: status === 'unanswered' || status === 'retrying' ? (exercise?.hints ?? []) : [],
    solution: status === 'unanswered' || status === 'retrying' ? '' : tutorSolutionFor(exercise),
    recentMistakes: [],
    mode: 'practice',
    problem_status: status,
    page: input.page ?? 'none',
    page_content: pageContent,
  };

  const turn: TutorTurn = {
    conceptId,
    ...(activityId === undefined ? {} : { activityId }),
    ...(exerciseId === undefined ? {} : { exerciseId }),
    level: status === 'unanswered' ? 'nudge' : status === 'retrying' ? 'hint' : 'worked_step',
    prompt,
  };
  return respond(turn);
}
