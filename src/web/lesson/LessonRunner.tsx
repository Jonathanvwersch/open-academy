import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../authenticated-fetch.js';
import { ExerciseForm, FeedbackPanel, LessonBlock, Markdown } from '../components.js';
import { type LessonRunPayload, lessonQueryOptions, lessonRunQueryOptions } from '../queries.js';
import { SessionActivityHeader } from '../session/SessionActivityHeader.js';
import { LessonSkeletonBody } from '../skeletons.js';
import { TutorLauncher, useTutorSidebar } from '../tutor/TutorSidebar.js';
import { Alert, AlertDescription } from '../ui/alert.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardContent } from '../ui/card.js';

export function LessonRunner({
  conceptId,
  activityId,
  title,
  activityLabel,
  activityPosition,
  activityCount,
  lessonHref,
  tutorEnabled,
  resumeRetry,
  onContinue,
}: {
  conceptId: string;
  activityId: string;
  title: string;
  activityLabel: string;
  activityPosition: number;
  activityCount: number;
  lessonHref?: string;
  tutorEnabled: boolean;
  resumeRetry: boolean;
  onContinue: (status: 'completed' | 'needs_retry') => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const tutorSidebar = useTutorSidebar();
  const queryOptions = lessonRunQueryOptions(conceptId);
  const query = useSuspenseQuery(queryOptions);
  const lesson = useSuspenseQuery(lessonQueryOptions(conceptId)).data;
  const state = query.data.run;
  const starting = useRef(false);
  const visibleProblemId = state?.pendingProblem?.id ?? state?.lastAnsweredProblem?.id;
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
  const pointId = point?.id;
  const basicsExerciseId = lesson?.knowledge_points?.find((item) => item.id === pointId)
    ?.problems[0];
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
  const displayedPoint = viewingPastStep ? viewingPoint : point;
  const pageLabel =
    state && currentPointIndex >= 0
      ? `${title} · step ${currentPointIndex + 1} of ${state.points.length}`
      : title;
  const tutorContextProblem = viewingPastStep ? undefined : contextProblem;
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
    tutorSidebar.setContext({
      conceptId,
      conceptTitle: title,
      activityId,
      exerciseId: tutorContextProblem?.exerciseId,
      lessonProblemId: tutorContextProblem?.id,
      page: 'session',
      knowledgePointId: tutorContextPointId ?? undefined,
      pageLabel: tutorContextPageLabel,
      allowed: true,
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
    const retryBelongsToAnotherActivity =
      state?.status === 'needs_retry' &&
      resumeRetry &&
      state.lastAnsweredProblem?.activityId !== activityId;
    if ((!state || retryBelongsToAnotherActivity) && !starting.current) {
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
  }, [activityId, conceptId, resumeRetry, state, updateState]);

  const submit = async (answer: unknown) => {
    if (!state?.pending) return;
    setBusy(true);
    setBusyAction('submit');
    setError('');
    try {
      const response = await apiFetch(`/api/lessons/${encodeURIComponent(conceptId)}/run/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ problemId: state.pending.id, answer, activityId }),
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

  const next = async () => {
    if (!state) return;
    if (state.status === 'needs_retry' || state.status === 'completed') {
      setBusy(true);
      setBusyAction('continue');
      setError('');
      try {
        await onContinue(state.status === 'completed' ? 'completed' : 'needs_retry');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not save lesson progress.');
      } finally {
        setBusyAction(null);
        setBusy(false);
      }
      return;
    }
    if (state.currentPointId) {
      const promptHeight = problemPromptRef.current?.getBoundingClientRect().height ?? 0;
      const inputAreaHeight =
        problemCardRef.current
          ?.querySelector('[data-testid="exercise-inputs"]')
          ?.getBoundingClientRect().height ?? 0;
      setStableCardHeights((current) => ({
        pointId: state.currentPointId as string,
        prompt: Math.max(
          current?.pointId === state.currentPointId ? current.prompt : 0,
          promptHeight,
        ),
        inputs: Math.max(
          current?.pointId === state.currentPointId ? current.inputs : 0,
          inputAreaHeight,
        ),
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
        <LessonSkeletonBody />
      </section>
    );
  }

  const pointStatus = state.points.find((item) => item.id === point?.id);
  const shownProblem = state.pendingProblem ?? state.lastAnsweredProblem;
  const showingAnswer = Boolean(state.lastAnsweredProblem && !state.pendingProblem);
  const stableHeightForCurrentPoint =
    stableCardHeights?.pointId === state.currentPointId ? stableCardHeights : null;
  const problemLabel = (exerciseId: string, pending = false) => {
    if (basicsExerciseId === exerciseId) return 'Basics question';
    return `Problem ${(pointStatus?.answered ?? 0) + (pending ? 1 : 0)} · up to 5`;
  };
  const backButtonLabel =
    state.status === 'completed'
      ? 'Back to summary'
      : `Back to step ${Math.max(0, currentPointIndex) + 1}`;
  const stepContent = displayedPoint ? (
    <section data-testid="lesson-step-content" className="space-y-4">
      <h2 className="text-xl font-semibold">{displayedPoint.title}</h2>
      {displayedPoint.id === lesson?.knowledge_points?.[0]?.id &&
      (lesson?.where_this_fits ?? state.where_this_fits) ? (
        <LessonBlock kind="fits" md={lesson?.where_this_fits ?? state.where_this_fits} />
      ) : null}
      <Markdown>{displayedPoint.explain}</Markdown>
      <LessonBlock kind="worked" md={displayedPoint.worked} />
    </section>
  ) : null;

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
        position={activityPosition}
        total={activityCount}
        lessonHref={lessonHref}
      />
      <ol aria-label="Lesson steps" className="flex flex-wrap gap-2">
        {state.points.map((item, index) => (
          <li key={item.id}>
            {item.status === 'passed' ||
            item.status === 'failed' ||
            item.id === state.currentPointId ||
            state.status === 'completed' ? (
              <Badge
                asChild
                variant="outline"
                className={`${
                  item.status === 'passed'
                    ? 'border-green-300 bg-green-50 text-green-900'
                    : item.status === 'failed'
                      ? 'border-red-300 bg-red-50 text-red-900'
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
                      : item.status === 'failed'
                        ? 'failed'
                        : item.id === state.currentPointId
                          ? 'current'
                          : 'completed'
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
                  {item.status === 'passed' ? '✓ ' : item.status === 'failed' ? '! ' : ''}
                  Step {index + 1} of {state.points.length}
                </button>
              </Badge>
            ) : (
              <Badge variant="outline" className="border-border text-muted-foreground">
                Step {index + 1} of {state.points.length}
              </Badge>
            )}
          </li>
        ))}
      </ol>

      {viewingPastStep ? (
        <>
          <Button type="button" onClick={returnToCurrentStep}>
            {backButtonLabel}
          </Button>
          {stepContent}
          <Button type="button" onClick={returnToCurrentStep}>
            {backButtonLabel}
          </Button>
        </>
      ) : state.status === 'completed' ? (
        <Card className="border-green-300 bg-green-50">
          <CardContent className="space-y-3 text-green-950">
            <h2 className="text-xl font-semibold">Lesson complete · +{state.xpEarned} XP</h2>
            <p>Your progress and experience points have been saved.</p>
            {state.lastAnsweredProblem ? (
              <>
                <div
                  data-testid="lesson-problem"
                  data-problem-id={state.lastAnsweredProblem.id}
                  className="rounded-lg border border-green-200 bg-background p-4"
                >
                  <p className="mb-2 text-sm font-medium">
                    {problemLabel(state.lastAnsweredProblem.exercise.id)}
                  </p>
                  <div data-testid="lesson-problem-prompt">
                    <Markdown>{state.lastAnsweredProblem.exercise.prompt}</Markdown>
                  </div>
                </div>
                <FeedbackPanel result={state.lastAnsweredProblem.result} />
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : state.status === 'needs_retry' ? (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="space-y-2 text-amber-950">
            <h2 className="text-xl font-semibold">Try again later</h2>
            <p>This step comes back in your next session.</p>
            {state.lastAnsweredProblem ? (
              <>
                <div
                  data-testid="lesson-problem"
                  data-problem-id={state.lastAnsweredProblem.id}
                  className="rounded-lg border border-amber-200 bg-background p-4"
                >
                  <p className="mb-2 text-sm font-medium">
                    {problemLabel(state.lastAnsweredProblem.exercise.id)}
                  </p>
                  <div data-testid="lesson-problem-prompt">
                    <Markdown>{state.lastAnsweredProblem.exercise.prompt}</Markdown>
                  </div>
                </div>
                <FeedbackPanel result={state.lastAnsweredProblem.result} />
              </>
            ) : null}
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
                data-problem-id={shownProblem.id}
              >
                <CardContent className="space-y-5">
                  <div
                    data-testid="lesson-problem-header"
                    className="flex flex-wrap items-center justify-between gap-3"
                  >
                    <h3 className="text-sm font-medium">
                      {problemLabel(shownProblem.exercise.id, Boolean(state.pendingProblem))}
                    </h3>
                    {basicsExerciseId !== shownProblem.exercise.id ? (
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
                        <span>2 in a row to move on</span>
                      </div>
                    ) : null}
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
                            label: pointStatus?.status === 'passed' ? 'Next step' : 'Next problem',
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
      {!viewingPastStep && error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {!viewingPastStep &&
      !state.pendingProblem &&
      (state.status === 'completed' || state.status === 'needs_retry') ? (
        <Button
          type="button"
          onClick={() => void next()}
          loading={busyAction === 'next' || busyAction === 'continue'}
          disabled={busy && busyAction !== 'next' && busyAction !== 'continue'}
        >
          {state.status === 'completed'
            ? 'Continue'
            : state.status === 'needs_retry'
              ? 'Continue'
              : pointStatus?.status === 'passed'
                ? 'Next step'
                : 'Next problem'}
        </Button>
      ) : null}
    </section>
  );
}
