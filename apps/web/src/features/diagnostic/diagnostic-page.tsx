import type { DiagnosticAnswerInput } from '@academy/contracts/diagnostic';
import { useQueryClient } from '@tanstack/react-query';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../api/authenticated-fetch.js';
import { Markdown } from '../../components/markdown.js';
import { ThinkingIndicator } from '../../components/thinking-indicator.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { ExerciseForm } from '../exercises/exercise-form.js';

interface DiagnosticItem {
  id: string;
  type: string;
  prompt: string;
  concept: string;
  code?: string;
  multi?: boolean;
  options?: Array<{ id: string; text: string }>;
}

export function DiagnosticPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [runId, setRunId] = useState('');
  const [domain, setDomain] = useState('');
  const [domainTitle, setDomainTitle] = useState('');
  const [exercise, setExercise] = useState<DiagnosticItem | null>(null);
  const [feedback, setFeedback] = useState('');
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busy, setBusy] = useState<'submit' | 'unknown' | 'skip' | null>(null);
  const runPromise = useRef<Promise<{ id: string }> | null>(null);

  const loadNext = useCallback(
    async (id: string) => {
      try {
        const response = await apiFetch(`/api/diagnostic/${id}/next`);
        if (!response.ok) throw new Error('Could not load the next question.');
        const data = await response.json();
        setFeedback('');
        if (data.complete) {
          window.sessionStorage.setItem('diagnosticRunId', id);
          queryClient.removeQueries({ queryKey: ['today'] });
          await queryClient.invalidateQueries();
          await navigate({ to: '/diagnostic/results', search: { id } });
          return;
        }
        setDomain(data.domainId ?? data.domain ?? '');
        setDomainTitle(data.domainTitle ?? data.domain ?? '');
        setExercise(data.exercise);
      } catch (cause) {
        setExercise(null);
        setLoadError('The next diagnostic question could not load. Please try again.');
        throw cause;
      }
    },
    [queryClient, navigate],
  );

  useEffect(() => {
    if (pathname !== '/diagnostic') return;
    let active = true;
    if (loadAttempt > 0) setLoadError('');
    const activeRunId = new URLSearchParams(window.location.search).get('runId');
    if (!runPromise.current) {
      runPromise.current = activeRunId
        ? Promise.resolve({ id: activeRunId })
        : apiFetch('/api/diagnostic', { method: 'POST' })
            .then(async (response) => {
              if (!response.ok) throw new Error('Could not start diagnostic.');
              const run = (await response.json()) as { id?: unknown };
              if (typeof run.id !== 'string' || !run.id) throw new Error('Missing diagnostic ID.');
              return { id: run.id };
            })
            .catch((cause: unknown) => {
              runPromise.current = null;
              throw cause;
            });
    }
    void runPromise.current
      .then(async (run) => {
        if (active) {
          setRunId(run.id);
          await loadNext(run.id);
        }
      })
      .catch(() => {
        if (active) setLoadError('The diagnostic could not load. Please try again.');
      });
    return () => {
      active = false;
    };
  }, [loadNext, pathname, loadAttempt]);

  const submit = async (answer: unknown, dontKnow = false) => {
    if (!exercise || !runId) return;
    setBusy(dontKnow ? 'unknown' : 'submit');
    const input: DiagnosticAnswerInput = dontKnow
      ? { exerciseId: exercise.id, dontKnow: true }
      : { exerciseId: exercise.id, answer };
    try {
      const response = await apiFetch(`/api/diagnostic/${runId}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const result = await response.json();
      if (!response.ok) {
        setFeedback(result.error ?? result.feedback ?? 'Answer could not be recorded.');
        return;
      }
      setFeedback(result.feedback ?? (result.correct ? 'Correct.' : 'Answer recorded.'));
      await loadNext(runId);
    } catch {
      setFeedback('Answer could not be recorded. Try again.');
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
      if (!response.ok) {
        setFeedback(result.error ?? 'Topic could not be skipped.');
        return;
      }
      if (result.complete) {
        window.sessionStorage.setItem('diagnosticRunId', runId);
        queryClient.removeQueries({ queryKey: ['today'] });
        await queryClient.invalidateQueries();
        await navigate({ to: '/diagnostic/results', search: { id: runId } });
      } else {
        await loadNext(runId);
      }
    } catch {
      setFeedback('Topic could not be skipped. Try again.');
    } finally {
      setBusy(null);
    }
  };

  if (pathname === '/diagnostic/results') {
    return <Outlet />;
  }

  return (
    <section className="space-y-6">
      <h1 className="sr-only">Diagnostic</h1>
      {exercise ? (
        <Card>
          <CardHeader className="flex flex-row items-baseline gap-2">
            <span className="text-sm text-muted-foreground">Topic</span>
            <CardTitle>{domainTitle}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <Markdown>{exercise.prompt}</Markdown>
            <ExerciseForm
              key={`${runId}:${exercise.id}`}
              exercise={exercise}
              compactActions
              onSubmit={(answer) => void submit(answer)}
              loading={busy === 'submit'}
              disabled={busy === 'skip' || busy === 'unknown'}
              actions={
                <Button
                  type="button"
                  loading={busy === 'unknown'}
                  disabled={busy !== null && busy !== 'unknown'}
                  onClick={() => void submit(undefined, true)}
                  variant="outline"
                  className="h-10"
                >
                  I don’t know
                </Button>
              }
            />
            <div className="border-t pt-4">
              <Button
                type="button"
                variant="link"
                loading={busy === 'skip'}
                disabled={busy !== null && busy !== 'skip'}
                onClick={skip}
                className="h-9 px-0 text-muted-foreground"
              >
                Skip topic
              </Button>
            </div>
            {feedback ? (
              <div role="status" className="text-sm text-muted-foreground">
                <Markdown>{feedback}</Markdown>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : loadError ? (
        <div className="space-y-4">
          <p role="alert" className="text-sm text-destructive">
            {loadError}
          </p>
          <Button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
            Retry
          </Button>
        </div>
      ) : (
        <ThinkingIndicator />
      )}
    </section>
  );
}
