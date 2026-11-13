import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { apiFetch } from '../authenticated-fetch.js';
import { ExerciseForm, FeedbackPanel, LessonBlock, Markdown } from '../components.js';
import {
  type LessonRunPayload,
  lessonQueryOptions,
  lessonRunQueryOptions,
  sessionQueryOptions,
} from '../queries.js';
import { SessionActivityHeader } from '../session/SessionActivityHeader.js';
import { LessonSkeletonBody } from '../skeletons.js';
import { TutorLauncher, useTutorSidebar } from '../tutor/TutorSidebar.js';
import { Alert, AlertDescription } from '../ui/alert.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardContent } from '../ui/card.js';

function problemLabel(problem: { position: number }) {
  return `Question ${problem.position}`;
}

export function LessonRunner({
  conceptId,
  activityId,
  sessionId,
  title,
  activityLabel,
  lessonHref,
  tutorEnabled,
  finalAnswered,
  onContinue,
}: {
  conceptId: string;
  activityId: string;
  sessionId: string;
  title: string;
  activityLabel: string;
  lessonHref?: string;
  tutorEnabled: boolean;
  finalAnswered: boolean;
  onContinue: (status: 'quiz' | 'completed', stage: 'final' | 'done') => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const tutorSidebar = useTutorSidebar();
  const queryOptions = lessonRunQueryOptions(conceptId);
  const query = useSuspenseQuery(queryOptions);
  const lesson = useSuspenseQuery(lessonQueryOptions(conceptId)).data;
  const state = query.data.run;
  const starting = useRef(false);
  const visibleProblemId =
    state?.pendingPracticeProblem?.id ??
    state?.pendingProblem?.id ??
    state?.lastAnsweredProblem?.id;
  const previousProblemId = useRef(visibleProblemId);
  const problemCardRef = useRef<HTMLDivElement>(null);
  const problemPromptRef = useRef<HTMLDivElement>(null);
  const previousCurrentPointId = useRef(state?.currentPointId);
  const [stableCardHeights, setStableCardHeights] = useState<{
    pointId: string;
    prompt: number;
    inputs: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<'submit' | 'next' | 'continue' | null>(null);
  const [error, setError] = useState('');
  const [viewingPointId, setViewingPointId] = useState<string | null>(null);
  const [practicePointId, setPracticePointId] = useState<string | null>(null);
  const [quizReview, setQuizReview] = useState<{
    attemptId: string;
    items: Array<{
      id: string;
      position: number;
      pointId: string;
      title: string;
      exercise: { prompt: string; type: string };
      yourAnswer: string;
      correctAnswer: string;
      solution: string;
      correct: number | null;
    }>;
  } | null>(null);
  const activePoint = state
    ? (lesson?.knowledge_points?.find((point) => point.id === state.currentPointId) ?? undefined)
    : undefined;
  const answeredPoint =
    state?.lastAnsweredProblem && !state.pendingProblem
      ? lesson?.knowledge_points?.find(
          (point) => point.id === state.lastAnsweredProblem?.knowledgePointId,
        )
      : undefined;
  const point = answeredPoint ?? activePoint ?? state?.currentPoint;
  const nextPoint = state?.currentPointId
    ? lesson?.knowledge_points?.find((item) => item.id === state.currentPointId)
    : undefined;
  const contextProblem = state?.pendingProblem ?? state?.lastAnsweredProblem;
  const currentPointIndex = state?.currentPointId
    ? state.points.findIndex((point) => point.id === state.currentPointId)
    : -1;
  const viewingPointIndex = viewingPointId
    ? (state?.points.findIndex((item) => item.id === viewingPointId) ?? -1)
    : -1;
  const viewingPoint = viewingPointId
    ? lesson?.knowledge_points?.find((item) => item.id === viewingPointId)
    : undefined;
  const viewingPastStep = Boolean(viewingPointId && viewingPointId !== state?.currentPointId);
  const practiceMode = Boolean(viewingPointId && viewingPointId === practicePointId);
  const practiceProblem =
    state?.pendingPracticeProblem ??
    (state?.lastAnsweredProblem?.practiceOnly ? state.lastAnsweredProblem : undefined);
  const pendingPracticePointId = state?.pendingPracticeProblem?.knowledgePointId;
  const displayedPoint = viewingPastStep ? viewingPoint : point;
  const pageLabel =
    state && currentPointIndex >= 0
      ? `${title} · step ${currentPointIndex + 1} of ${state.points.length}`
      : title;
  const tutorContextProblem = practiceMode
    ? practiceProblem
    : viewingPastStep
      ? undefined
      : contextProblem;
  const tutorContextQuestionLabel = tutorContextProblem
    ? problemLabel(tutorContextProblem)
    : undefined;
  const tutorContextPointId = viewingPastStep ? viewingPointId : state?.currentPointId;
  const tutorContextPageLabel =
    viewingPastStep && state && viewingPointIndex >= 0
      ? `${title} · step ${viewingPointIndex + 1} of ${state.points.length}`
      : pageLabel;

  useEffect(() => {
    if (previousProblemId.current && visibleProblemId !== previousProblemId.current) {
      const cardTop = problemCardRef.current?.getBoundingClientRect().top;
      const navHeight =
        document.querySelector('nav[aria-label="Main navigation"]')?.getBoundingClientRect()
          .height ?? 0;
      if (cardTop !== undefined && cardTop < navHeight) {
        window.scrollBy({ top: cardTop - navHeight, behavior: 'auto' });
      }
    }
    previousProblemId.current = visibleProblemId;
  }, [visibleProblemId]);

  useEffect(() => {
    if (previousCurrentPointId.current === state?.currentPointId) return;
    previousCurrentPointId.current = state?.currentPointId;
    setViewingPointId(null);
  }, [state?.currentPointId]);

  useEffect(() => {
    if (!pendingPracticePointId) return;
    setPracticePointId(pendingPracticePointId);
    setViewingPointId(pendingPracticePointId);
  }, [pendingPracticePointId]);

  useEffect(() => {
    tutorSidebar.setContext({
      conceptId,
      conceptTitle: title,
      activityId,
      exerciseId: tutorContextProblem?.exerciseId,
      questionLabel: tutorContextQuestionLabel,
      lessonProblemId: tutorContextProblem?.id,
      page: 'session',
      knowledgePointId: tutorContextPointId ?? undefined,
      pageLabel: tutorContextPageLabel,
      allowed: !state?.quiz.current,
      enabled: tutorEnabled,
    });
    return () => tutorSidebar.clearContext();
  }, [
    activityId,
    conceptId,
    tutorContextProblem?.exerciseId,
    tutorContextProblem?.id,
    tutorContextPageLabel,
    tutorContextPointId,
    tutorContextQuestionLabel,
    state?.quiz.current,
    title,
    tutorEnabled,
    tutorSidebar,
  ]);

  const updateState = useCallback(
    async (run: NonNullable<LessonRunPayload['run']>) => {
      queryClient.setQueryData(queryOptions.queryKey, { run });
      await queryClient.invalidateQueries({ queryKey: queryOptions.queryKey });
    },
    [queryClient, queryOptions.queryKey],
  );

  useEffect(() => {
    if (!state && !starting.current) {
      starting.current = true;
      setBusy(true);
      void apiFetch(`/api/lessons/${encodeURIComponent(conceptId)}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ activityId }),
      })
        .then(async (response) => {
          const data = (await response.json()) as LessonRunPayload;
          if (!response.ok || !data.run) throw new Error('Could not start this lesson.');
          await updateState(data.run);
        })
        .catch((cause: unknown) =>
          setError(cause instanceof Error ? cause.message : 'Could not start this lesson.'),
        )
        .finally(() => setBusy(false));
    }
  }, [activityId, conceptId, state, updateState]);

  const submit = async (answer: unknown) => {
    const pending = practiceMode ? state?.pendingPracticeProblem : state?.pendingProblem;
    if (!state || !pending) return;
    setBusy(true);
    setBusyAction('submit');
    setError('');
    try {
      const response = await apiFetch(`/api/lessons/${encodeURIComponent(conceptId)}/run/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ problemId: pending.id, answer, activityId }),
      });
      const data = (await response.json()) as {
        state?: NonNullable<LessonRunPayload['run']>;
        error?: string;
      };
      if (!response.ok || !data.state) throw new Error(data.error ?? 'Your answer was not saved.');
      await updateState(data.state);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your answer was not saved.');
    } finally {
      setBusyAction(null);
      setBusy(false);
    }
  };

  const startQuiz = async () => {
    setBusy(true);
    setBusyAction('next');
    setError('');
    setQuizReview(null);
    try {
      const response = await apiFetch(`/api/lessons/${encodeURIComponent(conceptId)}/quiz/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ activityId }),
      });
      const data = (await response.json()) as LessonRunPayload & { error?: string };
      if (!response.ok || !data.run) throw new Error(data.error ?? 'Could not start the quiz.');
      await updateState(data.run);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start the quiz.');
    } finally {
      setBusyAction(null);
      setBusy(false);
    }
  };

  const submitQuizResult = async () => {
    const response = await apiFetch(`/api/lessons/${encodeURIComponent(conceptId)}/quiz/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activityId }),
    });
    const data = (await response.json()) as LessonRunPayload & { error?: string };
    if (!response.ok || !data.run) throw new Error(data.error ?? 'Could not submit the quiz.');
    await updateState(data.run);
    await queryClient.invalidateQueries({ queryKey: sessionQueryOptions(sessionId).queryKey });
  };

  const submitQuiz = async () => {
    setBusy(true);
    setBusyAction('submit');
    setError('');
    try {
      await submitQuizResult();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not submit the quiz.');
    } finally {
      setBusyAction(null);
      setBusy(false);
    }
  };

  const submitQuizAnswer = async (itemId: string, answer: unknown, last: boolean) => {
    setBusy(true);
    setBusyAction('submit');
    setError('');
    try {
      const response = await apiFetch(`/api/lessons/${encodeURIComponent(conceptId)}/quiz/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId, answer, activityId }),
      });
      const data = (await response.json()) as {
        run?: NonNullable<LessonRunPayload['run']>;
        error?: string;
      };
      if (!response.ok || !data.run) throw new Error(data.error ?? 'Your answer was not saved.');
      await updateState(data.run);
      if (last || data.run.quiz.current?.items.every((item) => item.answered)) {
        await submitQuizResult();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your answer was not saved.');
    } finally {
      setBusyAction(null);
      setBusy(false);
    }
  };

  const startPractice = async (pointId: string) => {
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch(
        `/api/lessons/${encodeURIComponent(conceptId)}/run/practice`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pointId, activityId }),
        },
      );
      const data = (await response.json()) as LessonRunPayload & { error?: string };
      if (!response.ok || !data.run) {
        throw new Error(data.error ?? 'Could not load a practice question.');
      }
      setPracticePointId(pointId);
      await updateState(data.run);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load a practice question.');
    } finally {
      setBusy(false);
    }
  };

  const showQuizReview = async (attemptId: string) => {
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch(
        `/api/lessons/${encodeURIComponent(conceptId)}/quiz/${encodeURIComponent(attemptId)}/review`,
      );
      const data = (await response.json()) as NonNullable<typeof quizReview> & { error?: string };
      if (!response.ok) throw new Error(data.error ?? 'Could not load quiz answers.');
      setQuizReview(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load quiz answers.');
    } finally {
      setBusy(false);
    }
  };

  const next = async () => {
    if (!state) return;
    if (state.status === 'quiz' && !finalAnswered) {
      setBusy(true);
      setBusyAction('continue');
      setError('');
      try {
        await onContinue('quiz', 'final');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not save lesson progress.');
      } finally {
        setBusyAction(null);
        setBusy(false);
      }
      return;
    }
    if (state.status === 'completed' || (state.status === 'quiz' && finalAnswered)) {
      setBusy(true);
      setBusyAction('continue');
      setError('');
      try {
        await onContinue(state.status, 'done');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not save lesson progress.');
      } finally {
        setBusyAction(null);
        setBusy(false);
      }
      return;
    }
    const answeredPointId = state.lastAnsweredProblem?.knowledgePointId;
    const answeredPointIndex = state.points.findIndex((item) => item.id === answeredPointId);
    const answeredPoint = state.points[answeredPointIndex];
    const checkpointDetails =
      answeredPoint?.status === 'passed' && nextPoint
        ? {
            xpEarned: answeredPoint.xpEarned,
            pointNumber: answeredPointIndex + 1,
            pointCount: state.points.length,
          }
        : null;
    const heightPointId = point?.id ?? state.currentPointId;
    if (heightPointId) {
      const promptHeight = problemPromptRef.current?.getBoundingClientRect().height ?? 0;
      const inputAreaHeight =
        problemCardRef.current
          ?.querySelector('[data-testid="exercise-inputs"]')
          ?.getBoundingClientRect().height ?? 0;
      setStableCardHeights((current) => ({
        pointId: heightPointId,
        prompt: Math.max(current?.pointId === heightPointId ? current.prompt : 0, promptHeight),
        inputs: Math.max(current?.pointId === heightPointId ? current.inputs : 0, inputAreaHeight),
      }));
    }
    setBusy(true);
    setBusyAction('next');
    setError('');
    try {
      const response = await apiFetch(`/api/lessons/${encodeURIComponent(conceptId)}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ activityId }),
      });
      const data = (await response.json()) as LessonRunPayload;
      if (!response.ok || !data.run) throw new Error('Could not load the next problem.');
      await updateState(data.run);
      if (checkpointDetails) {
        window.scrollTo({ top: 0 });
        const freshSession = await queryClient.fetchQuery({
          ...sessionQueryOptions(sessionId),
          staleTime: 0,
        });
        toast.success(`Step ${checkpointDetails.pointNumber} done`, {
          description: `+${checkpointDetails.xpEarned} XP · Today: ${freshSession.xp.today} / ${freshSession.xp.goal} XP`,
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load the next problem.');
    } finally {
      setBusyAction(null);
      setBusy(false);
    }
  };

  if (!state) {
    return (
      <section aria-busy="true" className="space-y-6">
        <SessionActivityHeader
          title={title}
          label={activityLabel}
          lessonHref={lessonHref}
          subtitleSkeleton
        />
        <LessonSkeletonBody />
      </section>
    );
  }

  const pointStatus = state.points.find((item) => item.id === displayedPoint?.id);
  const shownProblem = practiceMode
    ? practiceProblem
    : (state.pendingProblem ?? state.lastAnsweredProblem);
  const showingAnswer = practiceMode
    ? Boolean(
        state.lastAnsweredProblem?.practiceOnly &&
          state.lastAnsweredProblem.id === shownProblem?.id &&
          state.lastAnsweredProblem.knowledgePointId === practicePointId,
      )
    : Boolean(
        state.lastAnsweredProblem &&
          !state.pendingProblem &&
          state.lastAnsweredProblem.id === shownProblem?.id,
      );
  const quizItems = state.quiz.current?.items ?? [];
  const unansweredQuizIndex = quizItems.findIndex((item) => !item.answered);
  const quizQuestionIndex =
    unansweredQuizIndex >= 0 ? unansweredQuizIndex : Math.max(0, quizItems.length - 1);
  const currentQuizItem = quizItems[quizQuestionIndex];
  const quizAllAnswered = quizItems.length > 0 && quizItems.every((item) => item.answered);
  const stableHeightForCurrentPoint =
    stableCardHeights?.pointId === state.currentPointId ? stableCardHeights : null;
  const backButtonLabel = 'Back';
  const stepContent = displayedPoint ? (
    <section data-testid="lesson-step-content" className="space-y-4">
      {displayedPoint.id === lesson?.knowledge_points?.[0]?.id &&
      (lesson?.where_this_fits ?? state.where_this_fits) ? (
        <LessonBlock
          kind="fits"
          md={lesson?.where_this_fits ?? state.where_this_fits}
          prerequisites={state.prerequisites ?? lesson?.prerequisites}
        />
      ) : null}
      <Markdown>{displayedPoint.explain}</Markdown>
      <LessonBlock kind="worked" md={displayedPoint.worked} />
    </section>
  ) : null;
  const sessionSubtitle = viewingPastStep
    ? displayedPoint?.title
    : state.status === 'completed'
      ? 'Lesson complete'
      : displayedPoint?.title;

  const viewStep = (stepId: string) => {
    const nextViewingPointId = stepId === state.currentPointId ? null : stepId;
    if (viewingPointId !== nextViewingPointId) window.scrollTo({ top: 0 });
    setViewingPointId(nextViewingPointId);
  };

  const returnToCurrentStep = () => {
    setViewingPointId(null);
    window.scrollTo({ top: 0 });
  };

  return (
    <section className="space-y-6">
      <SessionActivityHeader
        title={title}
        label={activityLabel}
        lessonHref={lessonHref}
        subtitle={sessionSubtitle}
      />
      <ol aria-label="Lesson steps" className="flex flex-wrap gap-2">
        {state.points.map((item, index) => (
          <li key={item.id}>
            {item.status === 'passed' ||
            item.id === state.currentPointId ||
            state.status === 'quiz' ||
            state.status === 'completed' ? (
              <Badge
                asChild
                variant="outline"
                className={`${
                  item.status === 'passed'
                    ? 'border-green-300 bg-green-50 text-green-900'
                    : item.id === state.currentPointId
                      ? 'border-primary bg-muted text-foreground'
                      : 'border-border text-muted-foreground'
                } cursor-pointer hover:brightness-95 ${
                  viewingPastStep && item.id === viewingPointId ? 'ring-1 ring-primary' : ''
                }`}
              >
                <button
                  type="button"
                  aria-label={`Step ${index + 1} of ${state.points.length}, ${
                    item.status === 'passed'
                      ? 'passed'
                      : item.id === state.currentPointId
                        ? 'current'
                        : 'locked'
                  }`}
                  aria-current={
                    (viewingPastStep && item.id === viewingPointId) ||
                    (!viewingPastStep &&
                      state.status === 'in_progress' &&
                      item.id === (point?.id ?? state.currentPointId))
                      ? 'step'
                      : undefined
                  }
                  onClick={() => viewStep(item.id)}
                >
                  {item.status === 'passed' ? '✓ ' : ''}
                  Step {index + 1}
                </button>
              </Badge>
            ) : (
              <Badge variant="outline" className="border-border text-muted-foreground">
                Step {index + 1}
              </Badge>
            )}
          </li>
        ))}
        <li>
          {state.status === 'completed' || state.quiz.bestPassed ? (
            <Badge
              variant="outline"
              data-testid="lesson-quiz-chip"
              aria-label="Lesson quiz, passed"
              className="border-green-300 bg-green-50 text-green-900"
            >
              ✓ Quiz
            </Badge>
          ) : state.status === 'quiz' ? (
            viewingPastStep ? (
              <Badge
                asChild
                variant="outline"
                data-testid="lesson-quiz-chip"
                aria-label="Lesson quiz, current"
                className="cursor-pointer border-primary bg-muted text-foreground hover:brightness-95"
              >
                <button type="button" onClick={returnToCurrentStep}>
                  Quiz
                </button>
              </Badge>
            ) : (
              <Badge
                variant="outline"
                data-testid="lesson-quiz-chip"
                aria-label="Lesson quiz, current"
                className="border-primary bg-muted text-foreground"
              >
                Quiz
              </Badge>
            )
          ) : (
            <Badge
              variant="outline"
              data-testid="lesson-quiz-chip"
              aria-label="Lesson quiz, upcoming"
              className="border-border text-muted-foreground"
            >
              Quiz
            </Badge>
          )}
        </li>
      </ol>

      {viewingPastStep ? (
        <>
          <Button type="button" onClick={returnToCurrentStep}>
            {state.status === 'quiz' ? 'Back to quiz results' : backButtonLabel}
          </Button>
          {stepContent}
          {practiceMode && shownProblem ? (
            <Card
              data-testid="lesson-problem"
              data-exercise-container=""
              data-problem-id={shownProblem.id}
            >
              <CardContent className="space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-sm font-medium">{problemLabel(shownProblem)}</h3>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <div
                      role="img"
                      aria-label={`${pointStatus?.streak ?? 0} correct in a row`}
                      className="flex gap-2"
                    >
                      {[0, 1].map((index) => (
                        <span
                          key={index}
                          className={`h-3 w-3 rounded-full border ${
                            index < (pointStatus?.streak ?? 0)
                              ? 'border-green-600 bg-green-500'
                              : 'border-border bg-background'
                          }`}
                        />
                      ))}
                    </div>
                    <span>2 in a row to finish this step</span>
                  </div>
                </div>
                <div data-testid="lesson-problem-prompt">
                  <Markdown>{shownProblem.exercise.prompt}</Markdown>
                </div>
                <ExerciseForm
                  key={shownProblem.id}
                  exercise={shownProblem.exercise}
                  onSubmit={submit}
                  loading={busyAction === 'submit'}
                  disabled={busy && busyAction !== 'submit'}
                  locked={showingAnswer}
                  submittedAnswer={
                    showingAnswer ? state.lastAnsweredProblem?.result.yourAnswer : undefined
                  }
                  answerOptions={
                    showingAnswer ? state.lastAnsweredProblem?.result.answerOptions : undefined
                  }
                  submitLabel="Submit answer"
                  actions={
                    tutorEnabled ? (
                      <TutorLauncher
                        context={{
                          conceptId,
                          activityId,
                          lessonProblemId: shownProblem.id,
                          allowed: true,
                          enabled: tutorEnabled,
                        }}
                      />
                    ) : null
                  }
                />
                {showingAnswer && state.lastAnsweredProblem ? (
                  <FeedbackPanel
                    result={state.lastAnsweredProblem.result}
                    hideAnswerLines={['mc', 'debug', 'explain'].includes(
                      state.lastAnsweredProblem.exercise.type,
                    )}
                  />
                ) : null}
              </CardContent>
            </Card>
          ) : null}
          {pointStatus?.status === 'passed' && displayedPoint ? (
            <Button
              type="button"
              disabled={busy}
              onClick={() => void startPractice(displayedPoint.id)}
            >
              Practise this step
            </Button>
          ) : null}
          <Button type="button" onClick={returnToCurrentStep}>
            {backButtonLabel}
          </Button>
        </>
      ) : state.quiz.current ? (
        quizAllAnswered ? (
          <Card>
            <CardContent className="space-y-4">
              <p>All questions are answered.</p>
              <Button
                type="button"
                loading={busyAction === 'submit'}
                disabled={busy}
                onClick={() => void submitQuiz()}
              >
                Submit quiz
              </Button>
            </CardContent>
          </Card>
        ) : currentQuizItem?.exercise ? (
          <Card data-testid="lesson-quiz-question">
            <CardContent className="space-y-5">
              <h2 className="text-lg font-semibold">
                Question {quizQuestionIndex + 1} of {quizItems.length}
              </h2>
              <div data-testid="lesson-quiz-prompt">
                <Markdown>{currentQuizItem.exercise.prompt}</Markdown>
              </div>
              <ExerciseForm
                key={currentQuizItem.id}
                exercise={currentQuizItem.exercise}
                onSubmit={(answer) =>
                  submitQuizAnswer(
                    currentQuizItem.id,
                    answer,
                    quizQuestionIndex === quizItems.length - 1,
                  )
                }
                loading={busyAction === 'submit'}
                disabled={busy && busyAction !== 'submit'}
                submitLabel={quizQuestionIndex === quizItems.length - 1 ? 'Submit quiz' : 'Next'}
              />
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="space-y-4">
              <p>Could not load this quiz question.</p>
            </CardContent>
          </Card>
        )
      ) : quizReview ? (
        <Card data-testid="lesson-quiz-review">
          <CardContent className="space-y-5">
            <h2 className="text-xl font-semibold">See answers</h2>
            <Button type="button" variant="outline" onClick={() => setQuizReview(null)}>
              Back to results
            </Button>
            {quizReview.items.map((item, index) => (
              <article key={item.id} className="space-y-3 border-t pt-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-semibold">Question {index + 1}</h3>
                  {item.correct != null && item.correct >= 1 ? (
                    <span
                      data-testid="quiz-review-mark"
                      data-correct="true"
                      className="flex items-center gap-1 text-sm font-medium text-green-700"
                    >
                      <Check aria-hidden="true" className="size-4" />
                      Correct
                    </span>
                  ) : item.correct === 0 ? (
                    <span
                      data-testid="quiz-review-mark"
                      data-correct="false"
                      className="flex items-center gap-1 text-sm font-medium text-red-700"
                    >
                      <X aria-hidden="true" className="size-4" />
                      Incorrect
                    </span>
                  ) : null}
                </div>
                <Markdown>{item.exercise.prompt}</Markdown>
                <p className={item.correct === 0 ? 'text-red-700' : undefined}>
                  <span className="font-medium">Your answer: </span>
                  <Markdown inline>{item.yourAnswer}</Markdown>
                </p>
                {item.correct != null && item.correct >= 1 ? null : (
                  <p>
                    <span className="font-medium">Correct answer: </span>
                    <Markdown inline>{item.correctAnswer}</Markdown>
                  </p>
                )}
                <div>
                  <p className="font-medium">Working</p>
                  <Markdown>{item.solution}</Markdown>
                </div>
              </article>
            ))}
          </CardContent>
        </Card>
      ) : state.status === 'completed' && state.quiz.last && !state.quiz.last.passed ? (
        <Card className="border-amber-300 bg-amber-50" data-testid="lesson-quiz-results">
          <CardContent className="space-y-4 text-amber-950">
            <h2 className="text-xl font-semibold">
              Retake not passed · {state.quiz.last.correctCount} of {state.quiz.last.total}
            </h2>
            <p>Your lesson quiz is already passed. Here&apos;s how this retake went:</p>
            <div className="space-y-2">
              {state.quiz.last.perStep.map((step, index) => (
                <Button
                  key={step.pointId}
                  type="button"
                  variant="link"
                  className="h-auto whitespace-normal p-0 text-left text-amber-950"
                  onClick={() => viewStep(step.pointId)}
                >
                  Step {index + 1} · {step.title}: {step.correct} of {step.total} right
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div />
              <div className="ml-auto flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void startQuiz()}
                >
                  Retake quiz
                </Button>
                <Button type="button" disabled={busy} onClick={() => void next()}>
                  Continue
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : state.status === 'completed' ? (
        <Card className="border-green-300 bg-green-50" data-testid="lesson-quiz-results">
          <CardContent className="space-y-4 text-green-950">
            <h2 className="text-xl font-semibold">
              {state.quiz.last?.passed
                ? `Quiz passed · ${state.quiz.last.correctCount} of ${state.quiz.last.total}`
                : 'Quiz passed'}
            </h2>
            {state.quiz.xpAwarded > 0 ? (
              <p className="text-sm opacity-70">+{state.quiz.xpAwarded} XP</p>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              {state.quiz.last?.passed ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    const attemptId = state.quiz.last?.attemptId;
                    if (attemptId) void showQuizReview(attemptId);
                  }}
                >
                  See answers
                </Button>
              ) : (
                <div />
              )}
              <div className="ml-auto flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void startQuiz()}
                >
                  Retake quiz
                </Button>
                <Button type="button" disabled={busy} onClick={() => void next()}>
                  Continue
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : state.quiz.last && !state.quiz.last.passed ? (
        <Card className="border-amber-300 bg-amber-50" data-testid="lesson-quiz-results">
          <CardContent className="space-y-4 text-amber-950">
            <h2 className="text-xl font-semibold">
              Not passed yet · {state.quiz.last.correctCount} of {state.quiz.last.total}
            </h2>
            <p>
              You need {Math.ceil(state.quiz.passMark * state.quiz.last.total)}. Here&apos;s how
              each step went:
            </p>
            {state.quiz.reviewRequired.length > 0 ? (
              <p>Before you retake it, answer 3 more questions on each step you missed.</p>
            ) : null}
            <div className="space-y-2">
              {state.quiz.last.perStep.map((step, index) => {
                const review = state.quiz.reviewRequired.find(
                  (item) => item.pointId === step.pointId,
                );
                return (
                  <div
                    key={step.pointId}
                    className="flex flex-wrap items-center justify-between gap-2"
                  >
                    <p className="min-w-0 flex-1">
                      Step {index + 1} · {step.title}: {step.correct} of {step.total} right
                    </p>
                    {review ? (
                      review.answered >= review.needed ? (
                        <span className="text-sm text-muted-foreground">✓ Reviewed</span>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => viewStep(step.pointId)}
                        >
                          Review · {review.answered}/{review.needed}
                        </Button>
                      )
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div />
              <div className="ml-auto flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    busy || state.quiz.reviewRequired.some((step) => step.answered < step.needed)
                  }
                  onClick={() => void startQuiz()}
                >
                  Retake quiz
                </Button>
                <Button type="button" disabled={busy} onClick={() => void next()}>
                  Continue
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : state.status === 'quiz' && !finalAnswered ? (
        <Card data-testid="lesson-steps-complete">
          <CardContent className="space-y-4">
            <h2 className="text-xl font-semibold">Lesson steps complete</h2>
            <p>Continue to the Explain it self-check before the lesson quiz.</p>
            <Button
              type="button"
              loading={busyAction === 'continue'}
              disabled={busy}
              onClick={() => void next()}
            >
              Continue
            </Button>
          </CardContent>
        </Card>
      ) : state.status === 'quiz' ? (
        <Card data-testid="lesson-quiz-intro">
          <CardContent className="space-y-4">
            <h2 className="text-xl font-semibold">Lesson quiz</h2>
            <p>
              {state.quiz.questionCount} questions from the whole lesson. You&apos;ll see your score
              at the end, not after each question. Pass with{' '}
              {Math.ceil(state.quiz.passMark * state.quiz.questionCount)} of{' '}
              {state.quiz.questionCount}.
            </p>
            <Button
              type="button"
              loading={busyAction === 'next'}
              disabled={busy}
              onClick={() => void startQuiz()}
            >
              {state.quiz.bestPassed ? 'Retake quiz' : 'Start quiz'}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {stepContent}
          {shownProblem ? (
            <div ref={problemCardRef}>
              <Card
                className="space-y-5"
                data-testid="lesson-problem"
                data-exercise-container=""
                data-problem-id={shownProblem.id}
              >
                <CardContent className="space-y-5">
                  <div
                    data-testid="lesson-problem-header"
                    className="flex flex-wrap items-center justify-between gap-3"
                  >
                    <h3 className="text-sm font-medium">{problemLabel(shownProblem)}</h3>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <div
                        role="img"
                        aria-label={`${pointStatus?.streak ?? 0} correct in a row`}
                        className="flex gap-2"
                      >
                        {[0, 1].map((index) => (
                          <span
                            key={index}
                            className={`h-3 w-3 rounded-full border ${
                              index < (pointStatus?.streak ?? 0)
                                ? 'border-green-600 bg-green-500'
                                : 'border-border bg-background'
                            }`}
                          />
                        ))}
                      </div>
                      <span>2 in a row to finish this step</span>
                    </div>
                  </div>
                  <div
                    ref={problemPromptRef}
                    data-testid="lesson-problem-prompt"
                    style={{ minHeight: stableHeightForCurrentPoint?.prompt }}
                  >
                    <Markdown>{shownProblem.exercise.prompt}</Markdown>
                  </div>
                  <ExerciseForm
                    key={shownProblem.id}
                    exercise={shownProblem.exercise}
                    onSubmit={submit}
                    loading={busyAction === 'submit'}
                    disabled={busy && busyAction !== 'submit'}
                    locked={showingAnswer}
                    submittedAnswer={
                      showingAnswer ? state.lastAnsweredProblem?.result.yourAnswer : undefined
                    }
                    answerOptions={
                      showingAnswer ? state.lastAnsweredProblem?.result.answerOptions : undefined
                    }
                    submitLabel="Submit answer"
                    inputAreaMinHeight={stableHeightForCurrentPoint?.inputs}
                    primaryAction={
                      showingAnswer
                        ? {
                            label:
                              pointStatus?.status === 'passed' && nextPoint
                                ? `Next: ${nextPoint.title}`
                                : pointStatus?.status === 'passed'
                                  ? 'Next step'
                                  : 'Next problem',
                            onClick: () => void next(),
                            loading: busyAction === 'next',
                            disabled: busy && busyAction !== 'next',
                          }
                        : undefined
                    }
                    actions={
                      tutorEnabled ? (
                        <TutorLauncher
                          context={{
                            conceptId,
                            activityId,
                            lessonProblemId: shownProblem.id,
                            allowed: true,
                            enabled: tutorEnabled,
                          }}
                          greeting={
                            showingAnswer
                              ? 'What would you like to know about this answer?'
                              : undefined
                          }
                        />
                      ) : null
                    }
                  />
                  {showingAnswer && state.lastAnsweredProblem ? (
                    <FeedbackPanel
                      result={state.lastAnsweredProblem.result}
                      xp={pointStatus?.status === 'passed' ? pointStatus.xpEarned : undefined}
                      hideAnswerLines={['mc', 'debug', 'explain'].includes(
                        state.lastAnsweredProblem.exercise.type,
                      )}
                    />
                  ) : null}
                </CardContent>
              </Card>
            </div>
          ) : null}
        </>
      )}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
