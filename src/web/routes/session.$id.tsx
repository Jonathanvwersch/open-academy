import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import type { FormEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  ExerciseForm,
  FeedbackPanel,
  HintLadder,
  LessonBlock,
  Markdown,
  ModeBadge,
} from '../components';
import { exerciseQueryOptions, lessonQueryOptions, sessionQueryOptions } from '../queries.js';

export const Route = createFileRoute('/session/$id')({
  loader: async ({ context, params }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions(params.id));
    const lessons = await Promise.all(
      session.activities.map((activity) =>
        activity.kind === 'learn' && activity.conceptId
          ? context.queryClient.ensureQueryData(lessonQueryOptions(activity.conceptId))
          : Promise.resolve(null),
      ),
    );
    const exerciseIds = new Set(session.activities.flatMap((activity) => activity.exerciseIds));
    for (const lesson of lessons) {
      for (const block of lesson?.blocks ?? []) {
        if (block.exercise) exerciseIds.add(block.exercise);
      }
    }
    await Promise.all(
      [...exerciseIds].map((exerciseId) =>
        context.queryClient.ensureQueryData(exerciseQueryOptions(exerciseId)),
      ),
    );
  },
  component: SessionPage,
});

function SessionPage() {
  const { id } = Route.useParams();
  const queryClient = useQueryClient();
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [hint, setHint] = useState<{
    level: number;
    text: string;
    revealedSolution: boolean;
    tutorUnavailable?: boolean;
  } | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [completedLessonChecks, setCompletedLessonChecks] = useState<Set<string>>(new Set());
  const hintButton = useRef<HTMLButtonElement>(null);
  const [timeAnchor, setTimeAnchor] = useState<{ serverTime: number; clientTime: number } | null>(
    null,
  );
  const sessionQuery = useSuspenseQuery(sessionQueryOptions(id));
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (sessionQuery.data?.serverNow) {
      setTimeAnchor({
        serverTime: Date.parse(sessionQuery.data.serverNow),
        clientTime: Date.now(),
      });
    }
  }, [sessionQuery.data?.serverNow]);
  const activities = sessionQuery.data.activities;
  const activity =
    activities.find((item) => item.status === 'in_progress') ??
    activities.find((item) => item.status === 'planned');
  const exerciseId = activity?.exerciseIds.find(
    (candidate) => !(activity.progress?.completedExerciseIds ?? []).includes(candidate),
  );
  const exerciseQuery = useSuspenseQuery(exerciseQueryOptions(exerciseId ?? null));
  useEffect(() => {
    if (activity?.id && exerciseId) {
      setResult(null);
      setHint(null);
    }
  }, [activity?.id, exerciseId]);
  useEffect(() => {
    const session = sessionQuery.data;
    if (!session?.startedAt || !session.plannedMinutes) return;
    const elapsed =
      timeAnchor && session.startedAt
        ? Math.max(
            0,
            Math.floor(
              (timeAnchor.serverTime -
                Date.parse(session.startedAt) +
                (clock - timeAnchor.clientTime)) /
                60_000,
            ),
          )
        : 0;
    const key = `replanned:${id}`;
    if (elapsed > session.plannedMinutes * 1.3 && !window.sessionStorage.getItem(key)) {
      window.sessionStorage.setItem(key, 'true');
      void fetch(`/api/sessions/${id}/replan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          remainingBudgetMinutes: Math.max(0, session.plannedMinutes - elapsed),
        }),
      }).then(() => queryClient.invalidateQueries({ queryKey: ['session', id] }));
    }
  }, [clock, id, queryClient, sessionQuery.data, timeAnchor]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.key !== '?' &&
        target instanceof HTMLElement &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
      ) {
        return;
      }
      if (event.key.toLowerCase() === 'h') {
        event.preventDefault();
        hintButton.current?.click();
      } else if (event.key.toLowerCase() === 'n' || event.key === 'ArrowRight') {
        if (
          result &&
          result.status !== 'invalid' &&
          (Number(result.correct) > 0 || !result.retryAllowed)
        ) {
          event.preventDefault();
          void queryClient.invalidateQueries({ queryKey: ['session', id] });
        }
      } else if (event.key === '?') {
        setShortcutsOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [id, queryClient, result]);
  const lessonQuery = useSuspenseQuery(
    lessonQueryOptions(activity?.kind === 'learn' ? (activity.conceptId ?? null) : null),
  );

  const markLessonViewed = async () => {
    if (!activity) return;
    await fetch(`/api/sessions/${id}/activities/${activity.id}/progress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(activity.progress ?? {}), lessonViewed: true }),
    });
    await queryClient.invalidateQueries({ queryKey: ['session', id] });
  };

  const completeActivity = async () => {
    if (!activity) return;
    await fetch(`/api/sessions/${id}/activities/${activity.id}/progress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(activity.progress ?? {}), complete: true }),
    });
    await queryClient.invalidateQueries({ queryKey: ['session', id] });
  };

  const submitAnswer = async (answer: unknown) => {
    if (!exerciseId || !activity) return;
    const mode =
      activity.kind === 'quick_check' || activity.kind === 'diagnostic'
        ? 'assessment'
        : activity.kind === 'review'
          ? 'review'
          : 'practice';
    const response = await fetch('/api/attempts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ exerciseId, activityId: activity.id, answer, mode }),
    });
    const data = await response.json();
    setResult(data);
    if (response.ok && data.status !== 'invalid') {
      setHint(null);
    }
  };
  const continueNext = async () => {
    await queryClient.invalidateQueries({ queryKey: ['session', id] });
  };

  const endSession = async () => {
    await fetch(`/api/sessions/${id}/end`, { method: 'POST' });
    window.location.href = '/';
  };

  if (!activity) {
    return (
      <section className="mx-auto max-w-3xl space-y-4">
        <h1 className="text-3xl font-semibold">Session complete</h1>
        <p className="text-neutral-600">Your progress has been saved.</p>
        <button
          type="button"
          onClick={endSession}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white"
        >
          Finish session
        </button>
      </section>
    );
  }
  const mode =
    activity.kind === 'review'
      ? 'review'
      : activity.kind === 'quick_check' || activity.kind === 'diagnostic'
        ? 'assessment'
        : 'practice';
  const remainingPlannedMinutes = activities
    .filter((item) => item.status !== 'completed')
    .reduce((sum, item) => sum + item.plannedMinutes, 0);
  const remainingMinutes = remainingPlannedMinutes;
  const lesson = lessonQuery.data;
  if (activity.kind === 'learn' && !activity.progress?.lessonViewed && lesson?.blocks.length) {
    const lessonExercises = lesson.blocks.filter((block) => block.exercise);
    const orderedBlocks = [
      ...lesson.blocks.filter((block) => block.kind === 'objective'),
      ...lesson.blocks.filter((block) => block.kind !== 'objective' && block.kind !== 'summary'),
      ...lesson.blocks.filter((block) => block.kind === 'summary'),
    ];
    return (
      <section className="mx-auto max-w-3xl space-y-6">
        <p className="text-sm text-neutral-500">
          Lesson · {activity.conceptTitle ?? activity.conceptId}
        </p>
        <div className="space-y-5">
          {orderedBlocks.map((block) => (
            <LessonBlock
              key={`${block.kind}-${block.md ?? block.exercise ?? 'block'}`}
              kind={block.kind}
              md={block.md}
            >
              {block.exercise ? (
                <InlineLessonCheck
                  key={`${activity.id}:${block.exercise}`}
                  exerciseId={block.exercise}
                  activityId={activity.id}
                  onDone={() =>
                    setCompletedLessonChecks((current) =>
                      new Set(current).add(block.exercise ?? ''),
                    )
                  }
                />
              ) : null}
            </LessonBlock>
          ))}
        </div>
        <button
          type="button"
          onClick={markLessonViewed}
          disabled={lessonExercises.some(
            (block) => block.exercise && !completedLessonChecks.has(block.exercise),
          )}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white"
        >
          Continue to practice
        </button>
      </section>
    );
  }
  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-neutral-500">
            {activity.kind.replace('_', ' ')}
            {activity.conceptId ? ` · ${activity.conceptTitle ?? activity.conceptId}` : ''}
          </p>
          <h1 className="mt-1 text-2xl font-semibold">Session</h1>
        </div>
        <ModeBadge mode={mode} />
      </div>
      <div className="space-y-2 rounded-lg border border-neutral-200 bg-white p-4">
        <p className="text-sm text-neutral-600">
          About {remainingMinutes} minutes remaining in your {sessionQuery.data.plannedMinutes}
          -minute plan.
        </p>
        <ol className="flex flex-wrap gap-2" aria-label="Session timeline">
          {activities.map((item) => (
            <li
              key={item.id}
              className={`rounded-full border px-3 py-1 text-xs ${
                Object.values(item.progress?.outcomes ?? {}).includes('incorrect')
                  ? 'border-red-300 bg-red-50 text-red-900'
                  : Object.values(item.progress?.outcomes ?? {}).includes('correct')
                    ? 'border-green-300 bg-green-50 text-green-900'
                    : item.status === 'completed'
                      ? 'border-neutral-300 bg-neutral-100 text-neutral-700'
                      : item.status === 'in_progress'
                        ? 'border-blue-300 bg-blue-50 text-blue-900'
                        : 'border-neutral-200 text-neutral-600'
              }`}
            >
              {item.kind.replace('_', ' ')} · {item.conceptTitle ?? item.conceptId ?? 'activity'} ·{' '}
              {item.plannedMinutes} min
            </li>
          ))}
        </ol>
      </div>
      {exerciseQuery.data ? (
        <article className="space-y-5 rounded-xl border border-neutral-200 bg-white p-6">
          <Markdown>{exerciseQuery.data.prompt}</Markdown>
          {shortcutsOpen ? (
            <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-700">
              Enter submits · h requests a hint · n or → continues · 1–9 selects an option · ? hides
              shortcuts
            </div>
          ) : null}
          {result && result.status !== 'invalid' ? <FeedbackPanel result={result} /> : null}
          {result?.status === 'invalid' ? (
            <p role="alert" className="text-sm text-red-700">
              {String(result.feedback)}
            </p>
          ) : null}
          {hint?.text ? (
            <div className="rounded-lg bg-neutral-100 p-4 text-sm">
              <p className="font-medium">
                {hint.revealedSolution ? 'Solution' : `Hint ${hint.level}`}
              </p>
              <Markdown>{hint.text}</Markdown>
            </div>
          ) : null}
          {hint?.tutorUnavailable ? (
            <p className="text-xs text-neutral-500">Tutor unavailable right now.</p>
          ) : null}
          {!result ||
          result.status === 'invalid' ||
          (Number(result.correct) === 0 && result.retryAllowed) ? (
            <ExerciseForm
              key={`${activity.id}:${exerciseId}`}
              exercise={exerciseQuery.data}
              onSubmit={submitAnswer}
            />
          ) : (
            <button
              type="button"
              onClick={continueNext}
              className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white"
            >
              Next
            </button>
          )}
          {mode !== 'assessment' &&
          (!result || result.status === 'invalid' || result.retryAllowed) ? (
            <HintLadder
              exerciseId={exerciseId ?? ''}
              activityId={activity.id}
              hintCount={exerciseQuery.data.hintCount}
              tutorEnabled={sessionQuery.data.tutorEnabled}
              onHint={setHint}
              mode={mode === 'review' ? 'review' : 'practice'}
              buttonRef={hintButton}
            />
          ) : null}
          {mode === 'practice' && exerciseId && sessionQuery.data.tutorEnabled ? (
            <TutorChat activityId={activity.id} exerciseId={exerciseId} />
          ) : null}
        </article>
      ) : !exerciseId ? (
        <article className="space-y-4 rounded-xl border border-neutral-200 bg-white p-6">
          <h2 className="text-lg font-semibold capitalize">{activity.kind.replace('_', ' ')}</h2>
          <p className="max-w-[70ch] text-sm leading-6 text-neutral-600">
            {activity.kind === 'lab'
              ? `Project ${activity.projectId ?? 'activity'} is ready to continue in your local workspace.`
              : activity.kind === 'teachback'
                ? 'Summarize the main idea from memory before continuing.'
                : activity.kind === 'reflect'
                  ? 'Take a moment to reflect on what you learned and what remains unclear.'
                  : 'No eligible exercise is available for this activity yet.'}
          </p>
          <button
            type="button"
            onClick={completeActivity}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white"
          >
            Continue
          </button>
        </article>
      ) : null}
    </section>
  );
}

function InlineLessonCheck({
  exerciseId,
  activityId,
  onDone,
}: {
  exerciseId: string;
  activityId: string;
  onDone: () => void;
}) {
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const { data: exercise } = useSuspenseQuery(exerciseQueryOptions(exerciseId));
  const submit = async (answer: unknown) => {
    const response = await fetch('/api/attempts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ exerciseId, activityId, answer, mode: 'practice' }),
    });
    const data = await response.json();
    setResult(data);
    if (response.ok && data.status !== 'invalid') onDone();
  };
  return (
    <div className="space-y-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
      {exercise ? (
        <>
          <Markdown>{exercise.prompt}</Markdown>
          {result ? <FeedbackPanel result={result} /> : null}
          {!result || result.status === 'invalid' || result.retryAllowed ? (
            <ExerciseForm
              key={`${activityId}:${exerciseId}`}
              exercise={exercise}
              onSubmit={submit}
            />
          ) : null}
        </>
      ) : null}
      <button type="button" className="text-sm underline" onClick={onDone}>
        Skip this check
      </button>
    </div>
  );
}

function TutorChat({ activityId, exerciseId }: { activityId: string; exerciseId: string }) {
  const [question, setQuestion] = useState('');
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  const ask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!question.trim() || pending) return;
    setPending(true);
    setError('');
    try {
      const response = await fetch('/api/tutor/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, exerciseId, activityId, mode: 'practice' }),
      });
      const result = (await response.json()) as { message?: string; error?: string };
      if (!response.ok) throw new Error(result.error ?? 'Tutor is unavailable.');
      setReply(result.message ?? '');
      setQuestion('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Tutor is unavailable.');
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="space-y-3 border-t border-neutral-200 pt-4">
      <h2 className="font-medium">Ask the tutor</h2>
      {reply ? <Markdown>{reply}</Markdown> : null}
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <form onSubmit={ask} className="space-y-2">
        <label className="block text-sm">
          Question
          <textarea
            className="mt-1 min-h-20 w-full rounded-md border border-neutral-300 p-2"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
          />
        </label>
        <button
          type="submit"
          disabled={pending || !question.trim()}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {pending ? 'Asking…' : 'Ask tutor'}
        </button>
      </form>
    </section>
  );
}
