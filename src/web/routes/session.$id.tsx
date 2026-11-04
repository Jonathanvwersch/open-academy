import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { ExerciseForm, FeedbackPanel, HintLadder, Markdown, ModeBadge } from '../components';

export const Route = createFileRoute('/session/$id')({
  component: SessionPage,
});

interface SessionActivity {
  id: string;
  idx: number;
  kind: string;
  conceptId?: string;
  projectId?: string;
  exerciseIds: string[];
  plannedMinutes: number;
  status: string;
  progress: { lessonViewed?: boolean; completedExerciseIds?: string[] };
}

function SessionPage() {
  const { id } = Route.useParams();
  const queryClient = useQueryClient();
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [hint, setHint] = useState<{
    level: number;
    text: string;
    revealedSolution: boolean;
  } | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const hintButton = useRef<HTMLButtonElement>(null);
  const [timeAnchor, setTimeAnchor] = useState<{ serverTime: number; clientTime: number } | null>(
    null,
  );
  const sessionQuery = useQuery({
    queryKey: ['session', id],
    queryFn: async () => {
      const response = await fetch(`/api/sessions/${id}`);
      if (!response.ok) throw new Error('Session not found');
      return response.json() as Promise<{
        activities: SessionActivity[];
        plannedMinutes: number;
        startedAt?: string;
        serverNow?: string;
      }>;
    },
  });
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
  const activities = sessionQuery.data?.activities ?? [];
  const activity =
    activities.find((item) => item.status === 'in_progress') ??
    activities.find((item) => item.status === 'planned');
  const exerciseId = activity?.exerciseIds.find(
    (candidate) => !(activity.progress?.completedExerciseIds ?? []).includes(candidate),
  );
  const exerciseQuery = useQuery({
    queryKey: ['exercise', exerciseId],
    enabled: Boolean(exerciseId),
    queryFn: async () => {
      const response = await fetch(`/api/exercises/${exerciseId}`);
      if (!response.ok) throw new Error('Exercise not found');
      return response.json();
    },
  });
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
  const lessonQuery = useQuery({
    queryKey: ['lesson', activity?.conceptId],
    enabled:
      activity?.kind === 'learn' && !activity.progress?.lessonViewed && Boolean(activity.conceptId),
    queryFn: async () => {
      const response = await fetch(`/api/lessons/${activity?.conceptId}`);
      return response.json() as Promise<{
        blocks: Array<{ kind: string; md?: string; exercise?: string }>;
      }>;
    },
  });

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

  if (sessionQuery.isPending) return <p className="text-sm text-neutral-600">Loading session…</p>;
  if (sessionQuery.isError)
    return <p className="text-sm text-red-700">This session could not be resumed.</p>;
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
    activity.kind === 'quick_check' || activity.kind === 'diagnostic' ? 'assessment' : 'practice';
  const elapsed = Math.max(
    0,
    timeAnchor
      ? Math.floor(
          (timeAnchor.serverTime -
            Date.parse(sessionQuery.data.startedAt ?? new Date(clock).toISOString()) +
            (clock - timeAnchor.clientTime)) /
            60_000,
        )
      : 0,
  );
  const remainingMinutes = Math.max(0, sessionQuery.data.plannedMinutes - elapsed);
  const lesson = lessonQuery.data;
  if (activity.kind === 'learn' && !activity.progress?.lessonViewed && lesson?.blocks.length) {
    return (
      <section className="mx-auto max-w-3xl space-y-6">
        <p className="text-sm text-neutral-500">Lesson · {activity.conceptId}</p>
        <div className="space-y-5 rounded-xl border border-neutral-200 bg-white p-6">
          {lesson.blocks.map((block) => (
            <div key={`${block.kind}-${block.md ?? block.exercise ?? 'block'}`}>
              {block.md ? <Markdown>{block.md}</Markdown> : null}
              {block.exercise ? (
                <p className="text-sm text-neutral-500">Practice check: {block.exercise}</p>
              ) : null}
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={markLessonViewed}
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
          <p className="text-sm capitalize text-neutral-500">
            {activity.kind.replace('_', ' ')}
            {activity.conceptId ? ` · ${activity.conceptId}` : ''}
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
              className={`rounded-full border px-3 py-1 text-xs ${item.status === 'completed' ? 'border-green-300 bg-green-50 text-green-900' : item.status === 'in_progress' ? 'border-blue-300 bg-blue-50 text-blue-900' : 'border-neutral-200 text-neutral-600'}`}
            >
              {item.kind.replace('_', ' ')} · {item.plannedMinutes} min
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
          {hint ? (
            <div className="rounded-lg bg-neutral-100 p-4 text-sm">
              <p className="font-medium">Hint {hint.level}</p>
              <Markdown>{hint.text}</Markdown>
            </div>
          ) : null}
          {!result ||
          result.status === 'invalid' ||
          (Number(result.correct) === 0 && result.retryAllowed) ? (
            <ExerciseForm key={exerciseId} exercise={exerciseQuery.data} onSubmit={submitAnswer} />
          ) : (
            <button
              type="button"
              onClick={continueNext}
              className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white"
            >
              Next
            </button>
          )}
          {mode === 'practice' &&
          (!result || result.status === 'invalid' || result.retryAllowed) ? (
            <HintLadder
              exerciseId={exerciseId ?? ''}
              activityId={activity.id}
              onHint={setHint}
              mode={activity.kind === 'review' ? 'review' : 'practice'}
              buttonRef={hintButton}
            />
          ) : null}
        </article>
      ) : activity.kind === 'learn' && lessonQuery.isPending ? (
        <p className="text-sm text-neutral-600">Loading lesson…</p>
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
      ) : (
        <p className="text-sm text-neutral-600">Loading exercise…</p>
      )}
    </section>
  );
}
