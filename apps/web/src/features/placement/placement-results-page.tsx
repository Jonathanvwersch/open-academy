import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PageLayoutSkeleton } from '../../components/page-layout-skeleton.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { placementResultsQueryOptions } from './queries.js';

export function PlacementResultsPage({ runId }: { runId?: string }) {
  const resultsQuery = useQuery({
    ...placementResultsQueryOptions(runId ?? null),
    enabled: Boolean(runId),
  });
  if (!runId) return <p role="alert">Placement results are unavailable.</p>;
  if (resultsQuery.error) {
    return (
      <p role="alert">
        {resultsQuery.error instanceof Error
          ? resultsQuery.error.message
          : 'Placement results are unavailable.'}
      </p>
    );
  }
  if (resultsQuery.isPending || !resultsQuery.data) return <PageLayoutSkeleton />;
  const results = resultsQuery.data;
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
        <p>No course topics placed out — you&apos;ll start from the beginning.</p>
      )}
      {results.foundationsPlacedOut.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Foundations you already know</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-inside list-disc space-y-2">
              {results.foundationsPlacedOut.map((title) => (
                <li key={title}>{title}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
      {results.firstTopic ? <p>You&apos;ll start with: {results.firstTopic}</p> : null}
      <Button asChild>
        <Link to="/">Start learning</Link>
      </Button>
    </section>
  );
}
