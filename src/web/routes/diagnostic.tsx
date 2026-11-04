import { createFileRoute, Outlet, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ExerciseForm, Markdown, ModeBadge } from '../components';

interface DiagnosticItem {
  id: string;
  type: string;
  prompt: string;
  concept: string;
  code?: string;
  multi?: boolean;
  options?: Array<{ id: string; text: string }>;
}

export const Route = createFileRoute('/diagnostic')({
  component: DiagnosticPage,
});

function DiagnosticPage() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [runId, setRunId] = useState('');
  const [domain, setDomain] = useState('');
  const [domainTitle, setDomainTitle] = useState('');
  const [exercise, setExercise] = useState<DiagnosticItem | null>(null);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const runPromise = useRef<Promise<{ id: string }> | null>(null);

  const loadNext = useCallback(async (id: string) => {
    const response = await fetch(`/api/diagnostic/${id}/next`);
    const data = await response.json();
    setFeedback('');
    if (data.complete) {
      window.sessionStorage.setItem('diagnosticRunId', id);
      window.location.href = '/diagnostic/results';
      return;
    }
    setDomain(data.domainId ?? data.domain ?? '');
    setDomainTitle(data.domainTitle ?? data.domain ?? '');
    setExercise(data.exercise);
  }, []);

  useEffect(() => {
    if (pathname !== '/diagnostic') return;
    let active = true;
    const activeRunId = new URLSearchParams(window.location.search).get('runId');
    if (!runPromise.current) {
      runPromise.current = activeRunId
        ? Promise.resolve({ id: activeRunId })
        : fetch('/api/diagnostic', { method: 'POST' }).then((response) => response.json());
    }
    void runPromise.current.then((run) => {
      if (active) {
        setRunId(run.id);
        void loadNext(run.id);
      }
    });
    return () => {
      active = false;
    };
  }, [loadNext, pathname]);

  const submit = async (answer: unknown) => {
    if (!exercise || !runId) return;
    setBusy(true);
    const response = await fetch(`/api/diagnostic/${runId}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ exerciseId: exercise.id, answer }),
    });
    const result = await response.json();
    if (!response.ok) {
      setFeedback(result.feedback ?? 'Answer could not be graded.');
      setBusy(false);
      return;
    }
    setFeedback(result.feedback ?? (result.correct ? 'Correct.' : 'Answer recorded.'));
    await loadNext(runId);
    setBusy(false);
  };

  const skip = async () => {
    if (!domain || !runId) return;
    setBusy(true);
    const response = await fetch(`/api/diagnostic/${runId}/skip`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain }),
    });
    const result = await response.json();
    if (result.complete) {
      window.sessionStorage.setItem('diagnosticRunId', runId);
      window.location.href = '/diagnostic/results';
    } else {
      await loadNext(runId);
    }
    setBusy(false);
  };

  if (pathname === '/diagnostic/results') {
    return <Outlet />;
  }

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="text-sm text-neutral-500">Getting started</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Starting-point diagnostic</h1>
        <p className="mt-2 text-sm text-neutral-600">
          A short set of questions will help place your first session.
        </p>
      </div>
      {exercise ? (
        <article className="space-y-5 rounded-xl border border-neutral-200 bg-white p-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            {domainTitle}
          </p>
          <ModeBadge mode="assessment" />
          <Markdown>{exercise.prompt}</Markdown>
          <ExerciseForm key={`${runId}:${exercise.id}`} exercise={exercise} onSubmit={submit} />
          {feedback ? (
            <div role="status" className="text-sm text-neutral-600">
              <Markdown>{feedback}</Markdown>
            </div>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={skip}
            className="text-sm text-neutral-600 underline underline-offset-4"
          >
            I haven’t studied this domain
          </button>
        </article>
      ) : (
        <p className="text-sm text-neutral-600">Preparing your diagnostic…</p>
      )}
    </section>
  );
}
