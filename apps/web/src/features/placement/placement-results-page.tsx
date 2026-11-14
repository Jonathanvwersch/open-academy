import type { PlacementResultsPayload } from '@academy/contracts/placement';
import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/authenticated-fetch.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';

export function PlacementResultsPage({ runId }: { runId?: string }) {
  const [results, setResults] = useState<PlacementResultsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!runId) {
      setError('Placement results are unavailable.');
      return () => {
        cancelled = true;
      };
    }
    void apiFetch(`/api/placement/${encodeURIComponent(runId)}/results`)
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load placement results');
        const data = (await response.json()) as PlacementResultsPayload;
        if (!cancelled) setResults(data);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Try again.');
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (error) return <p role="alert">{error}</p>;
  if (!results) return <p role="status">Loading placement results</p>;
  const many = results.placedOut.length > 8;
  const visibleTopics = many ? results.placedOut.slice(0, 8) : results.placedOut;
  return (
    <section className="mx-auto w-full max-w-3xl space-y-5">
      <h1 className="text-xl font-semibold tracking-tight">
        You placed out of {results.placedOut.length} of {results.topicsTotal} topics
      </h1>
      {results.placedOut.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Placed-out topics</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-inside list-disc space-y-2">
              {visibleTopics.map((title) => (
                <li key={title}>{title}</li>
              ))}
            </ul>
            {many ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium">Show all topics</summary>
                <ul className="mt-2 list-inside list-disc space-y-2">
                  {results.placedOut.slice(8).map((title) => (
                    <li key={title}>{title}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <p>No topics placed out — you&apos;ll start from the beginning.</p>
      )}
      {results.firstTopic ? <p>You&apos;ll start with: {results.firstTopic}</p> : null}
      <Button asChild>
        <a href="/">Start learning</a>
      </Button>
    </section>
  );
}
