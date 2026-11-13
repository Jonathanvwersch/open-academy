import { createFileRoute } from '@tanstack/react-router';
import { DiagnosticPage } from '@/features/diagnostic/diagnostic-page.js';
import { DiagnosticSkeleton } from '../components/skeletons.js';

export const Route = createFileRoute('/diagnostic')({
  validateSearch: (search: Record<string, unknown>): { runId?: string } => ({
    runId: typeof search.runId === 'string' ? search.runId : undefined,
  }),
  pendingComponent: DiagnosticSkeleton,
  component: DiagnosticPage,
});
