import type { ReviewsPayload } from '@academy/aesop/api/reviews';
import { queryOptions } from '@tanstack/react-query';
import { getJson } from '../../api/query-client.js';
export const reviewsQueryOptions = () =>
  queryOptions({
    queryKey: ['reviews'] as const,
    queryFn: () => getJson<ReviewsPayload>('/api/reviews', 'Reviews unavailable'),
  });
