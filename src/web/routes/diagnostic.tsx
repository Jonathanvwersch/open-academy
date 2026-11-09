import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Outlet, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/ui/button.js';
import { Card, CardContent } from '@/ui/card.js';
import { apiFetch } from '../authenticated-fetch.js';
import { ExerciseForm, Markdown, ModeBadge } from '../components';
import { DiagnosticQuestionSkeleton, DiagnosticSkeleton } from '../skeletons.js';

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
  pendingComponent: DiagnosticSkeleton,
  component: DiagnosticPage,
});

function DiagnosticPage() {
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [runId, setRunId] = useState('');
  const [domain, setDomain] = useState('');
  const [domainTitle, setDomainTitle] = useState('');
  const [exercise, setExercise] = useState<DiagnosticItem | null>(null);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState<'submit' | 'skip' | null>(null);
  const runPromise = useRef<Promise<{ id: string }> | null>(null);

  const loadNext = useCallback(
    async (id: string) => {
      const response = await apiFetch(`/api/diagnostic/${id}/next`);
      const data = await response.json();
      setFeedback('');
      if (data.complete) {
        window.sessionStorage.setItem('diagnosticRunId', id);
        queryClient.removeQueries({ queryKey: ['today'] });
        window.location.href = `/diagnostic/results?id=${encodeURIComponent(id)}`;
        return;
      }
      setDomain(data.domainId ?? data.domain ?? '');
      setDomainTitle(data.domainTitle ?? data.domain ?? '');
      setExercise(data.exercise);
    },
    [queryClient],
  );

  useEffect(() => {
    if (pathname !== '/diagnostic') return;
    let active = true;
    const activeRunId = new URLSearchParams(window.location.search).get('runId');
    if (!runPromise.current) {
      runPromise.current = activeRunId
        ? Promise.resolve({ id: activeRunId })
        : apiFetch('/api/diagnostic', { method: 'POST' }).then((response) => response.json());
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
    setBusy('submit');
    try {
      const response = await apiFetch(`/api/diagnostic/${runId}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exerciseId: exercise.id, answer }),
      });
      const result = await response.json();
      if (!response.ok) {
        setFeedback(result.feedback ?? 'Answer could not be graded.');
        return;
      }
      setFeedback(result.feedback ?? (result.correct ? 'Correct.' : 'Answer recorded.'));
      await loadNext(runId);
    } finally {
      setBusy(null);
    }
  };

  const skip = async () => {
    if (!domain || !runId) return;
    setBusy('skip');
    try {
      const response = await apiFetch(`/api/diagnostic/${runId}/skip`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domain }),
      });
      const result = await response.json();
      if (result.complete) {
        window.sessionStorage.setItem('diagnosticRunId', runId);
        queryClient.removeQueries({ queryKey: ['today'] });
        window.location.href = `/diagnostic/results?id=${encodeURIComponent(runId)}`;
      } else {
        await loadNext(runId);
      }
    } finally {
      setBusy(null);
    }
  };

  if (pathname === '/diagnostic/results') {
    return <Outlet />;
  }

  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">Getting started</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Starting-point diagnostic</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          A short set of questions will help place your first session.
        </p>
      </div>
      {exercise ? (
        <Card>
          <CardContent className="space-y-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {domainTitle}
            </p>
            <ModeBadge mode="assessment" />
            <Markdown>{exercise.prompt}</Markdown>
            <ExerciseForm
              key={`${runId}:${exercise.id}`}
              exercise={exercise}
              onSubmit={submit}
              loading={busy === 'submit'}
              disabled={busy === 'skip'}
            />
            {feedback ? (
              <div role="status" className="text-sm text-muted-foreground">
                <Markdown>{feedback}</Markdown>
              </div>
            ) : null}
            <Button
              type="button"
              loading={busy === 'skip'}
              disabled={busy === 'submit'}
              onClick={skip}
              variant="link"
              className="px-0 text-muted-foreground"
            >
              I haven’t studied this domain
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div role="status" aria-busy="true" aria-label="Preparing diagnostic">
          <DiagnosticQuestionSkeleton />
        </div>
      )}
    </section>
  );
}
