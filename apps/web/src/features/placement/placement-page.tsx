import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { Markdown } from '../../components/markdown.js';
import { PageLayoutSkeleton } from '../../components/page-layout-skeleton.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent } from '../../components/ui/card.js';
import { courseQueryOptions, learnQueryOptions } from '../course/queries.js';
import { ExerciseForm } from '../exercises/exercise-form.js';
import { papersQueryOptions } from '../papers/queries.js';
import { todayQueryOptions } from '../sessions/queries.js';
import {
  placementAnswerMutationOptions,
  placementNextQueryOptions,
  startPlacementMutationOptions,
} from './queries.js';

async function invalidatePlacementProgress(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: courseQueryOptions().queryKey }),
    queryClient.invalidateQueries({ queryKey: learnQueryOptions().queryKey }),
    queryClient.invalidateQueries({ queryKey: todayQueryOptions().queryKey }),
    queryClient.invalidateQueries({ queryKey: papersQueryOptions().queryKey }),
  ]);
}

export function PlacementPage({ initialRunId }: { initialRunId?: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [runId, setRunId] = useState<string | null>(initialRunId ?? null);
  const startRequested = useRef(false);
  const startPlacement = useMutation(startPlacementMutationOptions());
  const nextQuery = useQuery({
    ...placementNextQueryOptions(runId),
    enabled: runId !== null,
  });
  const answerPlacement = useMutation({
    ...placementAnswerMutationOptions(runId ?? ''),
    onSuccess: async () => {
      if (!runId) return;
      await queryClient.invalidateQueries({
        queryKey: placementNextQueryOptions(runId).queryKey,
      });
    },
  });

  useEffect(() => {
    if (initialRunId) {
      setRunId(initialRunId);
      return;
    }
    if (startRequested.current) return;
    startRequested.current = true;
    startPlacement.mutate(undefined, {
      onSuccess: async ({ id }) => {
        setRunId(id);
        await invalidatePlacementProgress(queryClient);
        await navigate({ to: '/placement', search: { id }, replace: true });
      },
    });
  }, [initialRunId, navigate, queryClient, startPlacement.mutate]);

  const question = nextQuery.data;
  useEffect(() => {
    if (!runId || !question?.complete) return;
    void invalidatePlacementProgress(queryClient);
    void navigate({ to: '/placement/results', search: { id: runId }, replace: true });
  }, [navigate, queryClient, question, runId]);

  const submit = (answer: unknown, dontKnow = false) => {
    if (!runId || !question || question.complete || answerPlacement.isPending) return;
    answerPlacement.mutate({
      exerciseId: question.exercise.id,
      ...(dontKnow ? { dontKnow: true } : { answer }),
    });
  };

  const loadError = startPlacement.error ?? nextQuery.error;
  if (loadError && !question) {
    return (
      <section className="space-y-4">
        <h1 className="sr-only">Placement check</h1>
        <p role="alert">
          {loadError instanceof Error ? loadError.message : 'The placement check is unavailable.'}
        </p>
        <Button asChild variant="outline">
          <Link to="/course">Back to Courses</Link>
        </Button>
      </section>
    );
  }
  if (!runId || nextQuery.isPending || !question) return <PageLayoutSkeleton />;

  if (question.complete) return <PageLayoutSkeleton />;
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
            loading={answerPlacement.isPending}
            actions={
              <Button
                type="button"
                variant="outline"
                disabled={answerPlacement.isPending}
                onClick={() => void submit(undefined, true)}
              >
                I don&apos;t know
              </Button>
            }
          />
        </CardContent>
      </Card>
      {answerPlacement.error ? (
        <p role="alert" className="text-sm text-destructive">
          {answerPlacement.error.message}
        </p>
      ) : null}
    </section>
  );
}
