import type {
  PlacementAnswerInput,
  PlacementNextPayload,
  PlacementResultsPayload,
  PlacementStartPayload,
} from '@academy/aesop/api/placement';
import { mutationOptions, queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../api/authenticated-fetch.js';
import { getJson } from '../../api/query-client.js';

export const placementNextQueryOptions = (runId: string | null) =>
  queryOptions({
    queryKey: ['placement', 'next', runId] as const,
    queryFn: () =>
      runId
        ? getJson<PlacementNextPayload>(
            `/api/placement/${encodeURIComponent(runId)}/next`,
            'Could not load the placement question',
          )
        : Promise.resolve(null),
  });

export const placementResultsQueryOptions = (runId: string | null) =>
  queryOptions({
    queryKey: ['placement', 'results', runId] as const,
    queryFn: () =>
      runId
        ? getJson<PlacementResultsPayload>(
            `/api/placement/${encodeURIComponent(runId)}/results`,
            'Could not load placement results',
          )
        : Promise.resolve(null),
  });

export const startPlacementMutationOptions = (courseId?: string) =>
  mutationOptions({
    mutationKey: ['placement', 'start'] as const,
    mutationFn: async () => {
      const response = await apiFetch(
        '/api/placement',
        courseId
          ? {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ courseId }),
            }
          : { method: 'POST' },
      );
      if (!response.ok) throw new Error('Could not start the placement check');
      return (await response.json()) as PlacementStartPayload;
    },
  });

export const placementAnswerMutationOptions = (runId: string) =>
  mutationOptions({
    mutationKey: ['placement', 'answer', runId] as const,
    mutationFn: async (answer: PlacementAnswerInput) => {
      const response = await apiFetch(`/api/placement/${encodeURIComponent(runId)}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(answer),
      });
      if (!response.ok) throw new Error('Could not save your answer');
      return (await response.json()) as { complete: boolean };
    },
  });
