import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ExerciseForm, FeedbackPanel, Markdown } from '../components.js';
import { type LessonRunPayload, lessonQueryOptions, lessonRunQueryOptions } from '../queries.js';

export function LessonRunner({
  conceptId,
  activityId,
  title,
  tutorEnabled,
  resumeRetry,
  onTutor,
  onContinue,
}: {
  conceptId: string;
  activityId: string;
  title: string;
  tutorEnabled: boolean;
  resumeRetry: boolean;
  onTutor: (lessonProblemId: string) => ReactNode;
  onContinue: () => void;
}) {
  const queryClient = useQueryClient();
  const queryOptions = lessonRunQueryOptions(conceptId);
  const query = useSuspenseQuery(queryOptions);
  const lesson = useSuspenseQuery(lessonQueryOptions(conceptId)).data;
  const starting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showTutor, setShowTutor] = useState(false);
  const state = query.data.run;

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
      void fetch(`/api/lessons/${encodeURIComponent(conceptId)}/run`, {
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
    setError('');
    try {
      const response = await fetch(`/api/lessons/${encodeURIComponent(conceptId)}/run/answer`, {
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
      setBusy(false);
    }
  };

  const next = async () => {
    if (!state) return;
    if (state.status === 'needs_retry' || state.status === 'completed') {
      onContinue();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/lessons/${encodeURIComponent(conceptId)}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ activityId }),
      });
      const data = (await response.json()) as LessonRunPayload;
      if (!response.ok || !data.run) throw new Error('Could not load the next problem.');
      setShowTutor(false);
      await updateState(data.run);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load the next problem.');
    } finally {
      setBusy(false);
    }
  };

  if (!state) {
    return (
      <section aria-busy="true" className="mx-auto min-h-[28rem] max-w-3xl space-y-6">
        <div className="h-8 w-64 animate-pulse rounded bg-neutral-200" />
        <div className="h-40 animate-pulse rounded-xl bg-neutral-100" />
      </section>
    );
  }

  const activePoint =
    lesson?.knowledge_points?.find((point) => point.id === state.currentPointId) ?? undefined;
  const answeredPoint =
    state.lastAnsweredProblem && !state.pendingProblem
      ? lesson?.knowledge_points?.find(
          (point) => point.id === state.lastAnsweredProblem?.knowledgePointId,
        )
      : undefined;
  const point = answeredPoint ?? activePoint ?? state.currentPoint;
  const pointStatus = state.points.find((item) => item.id === point?.id);
  const shownProblem = state.pendingProblem ?? state.lastAnsweredProblem;
  const showingAnswer = Boolean(state.lastAnsweredProblem && !state.pendingProblem);

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <header>
        <p className="text-sm text-neutral-500">Lesson</p>
        <h1 className="mt-1 text-2xl font-semibold">{title}</h1>
      </header>
      <ol aria-label="Lesson steps" className="flex flex-wrap gap-2">
        {state.points.map((item, index) => (
          <li
            key={item.id}
            className={`rounded-full border px-3 py-1 text-sm ${
              item.status === 'passed'
                ? 'border-green-300 bg-green-50 text-green-900'
                : item.status === 'failed'
                  ? 'border-red-300 bg-red-50 text-red-900'
                  : item.id === state.currentPointId
                    ? 'border-blue-300 bg-blue-50 text-blue-900'
                    : 'border-neutral-200 text-neutral-600'
            }`}
          >
            {item.status === 'passed' ? '✓ ' : item.status === 'failed' ? '! ' : ''}
            Step {index + 1} of {state.points.length}
          </li>
        ))}
      </ol>

      {state.status === 'completed' ? (
        <div className="space-y-3 rounded-xl border border-green-300 bg-green-50 p-5">
          <h2 className="text-xl font-semibold">Lesson complete · +{state.xpEarned} XP</h2>
          <p>Your progress and experience points have been saved.</p>
          {state.lastAnsweredProblem ? (
            <>
              <div
                data-testid="lesson-problem"
                data-problem-id={state.lastAnsweredProblem.id}
                className="rounded-lg border border-green-200 bg-white p-4"
              >
                <p className="mb-2 text-sm font-medium">
                  Problem {state.lastAnsweredProblem.position} · up to 5
                </p>
                <div data-testid="lesson-problem-prompt">
                  <Markdown>{state.lastAnsweredProblem.exercise.prompt}</Markdown>
                </div>
              </div>
              <FeedbackPanel result={state.lastAnsweredProblem.result} />
            </>
          ) : null}
        </div>
      ) : state.status === 'needs_retry' ? (
        <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-5">
          <h2 className="text-xl font-semibold">Try again later</h2>
          <p>This step comes back in your next session.</p>
          {state.lastAnsweredProblem ? (
            <>
              <div
                data-testid="lesson-problem"
                data-problem-id={state.lastAnsweredProblem.id}
                className="rounded-lg border border-amber-200 bg-white p-4"
              >
                <p className="mb-2 text-sm font-medium">
                  Problem {state.lastAnsweredProblem.position} · up to 5
                </p>
                <div data-testid="lesson-problem-prompt">
                  <Markdown>{state.lastAnsweredProblem.exercise.prompt}</Markdown>
                </div>
              </div>
              <FeedbackPanel result={state.lastAnsweredProblem.result} />
            </>
          ) : null}
        </div>
      ) : (
        <>
          {point ? (
            <section className="space-y-4 rounded-xl border border-neutral-200 bg-white p-5">
              <h2 className="text-xl font-semibold">{point.title}</h2>
              <Markdown>{point.explain}</Markdown>
              <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
                  Worked example
                </p>
                <Markdown>{point.worked}</Markdown>
              </div>
            </section>
          ) : null}
          {shownProblem ? (
            <article
              className="space-y-5 rounded-xl border border-neutral-200 bg-white p-5"
              data-testid="lesson-problem"
              data-problem-id={shownProblem.id}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-semibold">Problem {shownProblem.position} · up to 5</h3>
                <p className="text-sm text-neutral-600">2 in a row to move on</p>
              </div>
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
                        : 'border-neutral-300 bg-white'
                    }`}
                  />
                ))}
              </div>
              <div data-testid="lesson-problem-prompt">
                <Markdown>{shownProblem.exercise.prompt}</Markdown>
              </div>
              {showingAnswer && state.lastAnsweredProblem ? (
                <>
                  <FeedbackPanel result={state.lastAnsweredProblem.result} />
                  {pointStatus?.status === 'passed' ? (
                    <p className="font-semibold text-green-800">+{pointStatus.xpEarned} XP</p>
                  ) : null}
                  {tutorEnabled ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setShowTutor((open) => !open)}
                        className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium"
                      >
                        Ask the tutor about this
                      </button>
                      {showTutor ? onTutor(state.lastAnsweredProblem.id) : null}
                    </>
                  ) : null}
                </>
              ) : (
                <ExerciseForm
                  exercise={shownProblem.exercise}
                  onSubmit={submit}
                  disabled={busy}
                  submitLabel={busy ? 'Saving…' : 'Submit answer'}
                />
              )}
            </article>
          ) : null}
        </>
      )}
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {!state.pendingProblem ? (
        <button
          type="button"
          onClick={() => void next()}
          disabled={busy}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy
            ? 'Saving…'
            : state.status === 'completed'
              ? 'Continue'
              : state.status === 'needs_retry'
                ? 'Continue'
                : pointStatus?.status === 'passed'
                  ? 'Next step'
                  : 'Next problem'}
        </button>
      ) : null}
    </section>
  );
}
