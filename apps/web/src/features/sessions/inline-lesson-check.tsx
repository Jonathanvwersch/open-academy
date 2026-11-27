import type { AttemptResponse } from '@open-academy/engine/api';
import { useSuspenseQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { apiFetch } from '../../api/authenticated-fetch.js';
import { Markdown } from '../../components/markdown.js';
import { Alert, AlertDescription } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent } from '../../components/ui/card.js';
import { ExerciseForm } from '../exercises/exercise-form.js';
import { FeedbackPanel, FinalRetryNote, isFinalRetryResult } from '../exercises/feedback-panel.js';
import { exerciseQueryOptions } from '../exercises/queries.js';
export function InlineLessonCheck({
  exerciseId,
  activityId,
  onDone,
  onConflict,
}: {
  exerciseId: string;
  activityId: string;
  onDone: () => void;
  onConflict: () => Promise<void>;
}) {
  const [result, setResult] = useState<AttemptResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const { data: exercise } = useSuspenseQuery(exerciseQueryOptions(exerciseId));
  const submit = async (answer: unknown, durationMs: number) => {
    setSubmitting(true);
    setSubmitError('');
    try {
      const response = await apiFetch('/api/attempts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exerciseId, activityId, answer, mode: 'practice', durationMs }),
      });
      const data = (await response.json().catch(() => ({}))) as AttemptResponse;
      if (response.status === 409) {
        await onConflict();
        return;
      }
      if (response.ok || (response.status === 422 && data.status === 'invalid')) {
        setResult(data);
      } else {
        setSubmitError(typeof data.error === 'string' ? data.error : 'Your answer was not saved.');
      }
      if (response.ok && data.status !== 'invalid' && data.retryAllowed !== true) onDone();
    } catch {
      setSubmitError('Your answer was not saved. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Card>
      <CardContent className="space-y-3">
        {exercise ? (
          <>
            <Markdown>{exercise.prompt}</Markdown>
            {result ? (
              result.status === 'invalid' ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    <Markdown inline>{String(result.feedback ?? 'Invalid answer')}</Markdown>
                  </AlertDescription>
                </Alert>
              ) : (
                <FeedbackPanel
                  result={result}
                  hideAnswerLines={
                    ['mc', 'debug', 'explain'].includes(exercise.type) &&
                    result.retryAllowed === true
                  }
                />
              )
            ) : null}
            {isFinalRetryResult(result) ? <FinalRetryNote /> : null}
            {!result || result.status === 'invalid' || result.retryAllowed ? (
              <ExerciseForm
                key={`${activityId}:${exerciseId}`}
                autoFocus={false}
                exercise={exercise}
                onSubmit={submit}
                timerResetKey={Number(result?.attemptNo ?? 0)}
                restartTimerOnInteraction={result?.retryAllowed === true}
                loading={submitting}
              />
            ) : null}
            {submitError ? (
              <p role="alert" className="text-sm text-destructive">
                {submitError}
              </p>
            ) : null}
          </>
        ) : null}
        {!result ? (
          <Button
            type="button"
            variant="link"
            className="px-0"
            disabled={submitting}
            onClick={onDone}
          >
            Skip this check
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
