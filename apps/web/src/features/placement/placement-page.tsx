import type { PlacementNextPayload } from '@academy/contracts/placement';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../api/authenticated-fetch.js';
import { Markdown } from '../../components/markdown.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent } from '../../components/ui/card.js';
import { courseQueryOptions, learnQueryOptions } from '../course/queries.js';
import { ExerciseForm } from '../exercises/exercise-form.js';
import { papersQueryOptions } from '../papers/queries.js';
import { todayQueryOptions } from '../sessions/queries.js';

export function PlacementPage({ initialRunId }: { initialRunId?: string }) {
  const queryClient = useQueryClient();
  const [runId, setRunId] = useState(initialRunId);
  const [question, setQuestion] = useState<PlacementNextPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadNext = useCallback(
    async (id: string) => {
      const response = await apiFetch(`/api/placement/${encodeURIComponent(id)}/next`);
      if (!response.ok) throw new Error('Could not load the placement question');
      const next = (await response.json()) as PlacementNextPayload;
      if (next.complete) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: courseQueryOptions().queryKey }),
          queryClient.invalidateQueries({ queryKey: learnQueryOptions().queryKey }),
          queryClient.invalidateQueries({ queryKey: todayQueryOptions().queryKey }),
          queryClient.invalidateQueries({ queryKey: papersQueryOptions().queryKey }),
        ]);
        window.location.assign(`/placement/results?id=${encodeURIComponent(id)}`);
        return;
      }
      setQuestion(next);
    },
    [queryClient],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        setLoading(true);
        let id = initialRunId;
        if (!id) {
          const start = await apiFetch('/api/placement', { method: 'POST' });
          if (!start.ok) throw new Error('Could not start the placement check');
          id = ((await start.json()) as { id: string }).id;
          window.history.replaceState(null, '', `/placement?id=${encodeURIComponent(id)}`);
        }
        if (cancelled) return;
        setRunId(id);
        await loadNext(id);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Try again.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialRunId, loadNext]);

  const submit = async (answer: unknown, dontKnow = false) => {
    if (!runId || !question || question.complete || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/placement/${encodeURIComponent(runId)}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          exerciseId: question.exercise.id,
          ...(dontKnow ? { dontKnow: true } : { answer }),
        }),
      });
      if (!response.ok) throw new Error('Could not save your answer');
      const result = (await response.json()) as { complete: boolean };
      if (result.complete) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: courseQueryOptions().queryKey }),
          queryClient.invalidateQueries({ queryKey: learnQueryOptions().queryKey }),
          queryClient.invalidateQueries({ queryKey: todayQueryOptions().queryKey }),
          queryClient.invalidateQueries({ queryKey: papersQueryOptions().queryKey }),
        ]);
        window.location.assign(`/placement/results?id=${encodeURIComponent(runId)}`);
      } else {
        await loadNext(runId);
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <p role="status">Loading placement check</p>;
  if (!question || question.complete) {
    return (
      <section className="space-y-4">
        <h1 className="sr-only">Placement check</h1>
        <p role="alert">{error ?? 'The placement check is unavailable.'}</p>
        <Button asChild variant="outline">
          <a href="/course">Back to Courses</a>
        </Button>
      </section>
    );
  }

  return (
    <section className="mx-auto w-full max-w-3xl space-y-5">
      <h1 className="text-xl font-semibold tracking-tight">
        Placement check · {question.courseTitle}
      </h1>
      <p className="text-sm text-muted-foreground">
        Question {question.questionNumber} of up to {question.maxQuestions}
      </p>
      <Card data-exercise-container="">
        <CardContent className="space-y-5">
          <div data-testid="placement-prompt">
            <Markdown>{question.exercise.prompt}</Markdown>
          </div>
          <ExerciseForm
            key={question.exercise.id}
            exercise={question.exercise}
            onSubmit={(answer) => void submit(answer)}
            submitLabel="Submit"
            loading={submitting}
            actions={
              <Button
                type="button"
                variant="outline"
                disabled={submitting}
                onClick={() => void submit(undefined, true)}
              >
                I don&apos;t know
              </Button>
            }
          />
        </CardContent>
      </Card>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
