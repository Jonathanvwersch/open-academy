import type { ExercisePayload } from '@open-academy/engine/api';
import { queryOptions } from '@tanstack/react-query';
import { getJson } from '../../api/query-client.js';
export const exerciseQueryOptions = (exerciseId: string | null) =>
  queryOptions({
    queryKey: ['exercise', exerciseId] as const,
    // Exercise content is static for a given user and deployment; retain loader-prefetched questions.
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: () =>
      exerciseId
        ? getJson<ExercisePayload>(
            `/api/exercises/${encodeURIComponent(exerciseId)}`,
            'Exercise not found',
          )
        : Promise.resolve(null),
  });
