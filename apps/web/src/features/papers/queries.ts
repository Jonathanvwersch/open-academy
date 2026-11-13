import type { PapersPayload } from '@academy/contracts/papers';
import { queryOptions } from '@tanstack/react-query';
import { getJson } from '../../api/query-client.js';
export const papersQueryOptions = () =>
  queryOptions({
    queryKey: ['papers'] as const,
    queryFn: () => getJson<PapersPayload>('/api/papers', 'Could not load papers'),
  });

export const paperQueryOptions = (paperId: string) =>
  queryOptions({
    queryKey: ['paper', paperId] as const,
    queryFn: () =>
      getJson<{
        paper: {
          id: string;
          title: string;
          authors: string;
          year: number;
          week: number;
          est_minutes: number;
          source: { arxiv: string } | { url: string };
          questions: Array<{ id: string; kind: string; prompt: string }>;
          why_this_week: string;
          how_to_read: string;
          summary: {
            prompt: string;
            rubric?: Array<{ id: string; criterion: string; weight: number; required: boolean }>;
          };
        };
        progress: {
          lastPage: number;
          notes: Record<string, string>;
          summary: string | null;
          summaryJudgement: unknown;
        } | null;
        originalUrl: string;
      }>(`/api/papers/${encodeURIComponent(paperId)}`, 'Paper not found'),
  });

export function paperStatusLabel(
  status: PapersPayload['weeks'][number]['papers'][number]['status'],
) {
  return status === 'not_started' ? 'Not started' : status === 'reading' ? 'Reading' : 'Completed';
}
