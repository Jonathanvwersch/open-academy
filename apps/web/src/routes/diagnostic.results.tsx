import { createFileRoute } from '@tanstack/react-router';
import { DiagnosticResultsPage } from '@/features/diagnostic/diagnostic-results-page.js';
import { RouteLoadError } from '../components/route-error.js';
import { DiagnosticResultsSkeleton } from '../components/skeletons.js';
import {
  diagnosticResultsQueryOptions,
  latestDiagnosticQueryOptions,
} from '../features/diagnostic/queries.js';

export const Route = createFileRoute('/diagnostic/results')({
  pendingComponent: DiagnosticResultsSkeleton,
  validateSearch: (search: Record<string, unknown>) => ({
    id: typeof search.id === 'string' ? search.id : undefined,
  }),
  loaderDeps: ({ search }) => ({ id: search.id }),
  loader: async ({ context, deps }) => {
    const candidateId = deps.id ?? window.sessionStorage.getItem('diagnosticRunId');
    if (candidateId) {
      try {
        await context.queryClient.ensureQueryData(diagnosticResultsQueryOptions(candidateId));
        return candidateId;
      } catch {
        // Resolve stale ids through the latest completed run.
      }
    }
    const latest = await context.queryClient.ensureQueryData(latestDiagnosticQueryOptions());
    await context.queryClient.ensureQueryData(diagnosticResultsQueryOptions(latest.id));
    return latest.id;
  },
  errorComponent: () => (
    <RouteLoadError message="Diagnostic results are unavailable." role="alert" />
  ),
  component: DiagnosticResultsPage,
});
