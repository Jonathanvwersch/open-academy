import type { DiagnosticResultsPayload } from '@academy/contracts/diagnostic';
import { queryOptions } from '@tanstack/react-query';
import { getJson } from '../../api/query-client.js';
export const latestDiagnosticQueryOptions = () =>
  queryOptions({
    queryKey: ['diagnostic', 'latest'] as const,
    queryFn: () => getJson<{ id: string }>('/api/diagnostic/latest', 'No completed diagnostic'),
  });

export const diagnosticResultsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['diagnostic', 'results', id] as const,
    queryFn: () =>
      getJson<DiagnosticResultsPayload>(
        `/api/diagnostic/${encodeURIComponent(id)}/results`,
        'Could not load diagnostic results',
      ),
  });
