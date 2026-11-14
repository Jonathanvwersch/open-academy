import { createFileRoute } from '@tanstack/react-router';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { z } from 'zod';
import { PaperReaderPage } from '@/features/papers/paper-reader-page.js';
import { RouteLoadError } from '../components/route-error.js';
import { PaperSkeleton } from '../components/skeletons.js';
import { paperQueryOptions } from '../features/papers/queries.js';

const searchSchema = z.object({
  from: z.string().optional(),
  activity: z.string().optional(),
  courseId: z.string().optional(),
});
export const Route = createFileRoute('/papers/$paperId')({
  pendingComponent: PaperSkeleton,
  validateSearch: searchSchema,
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(paperQueryOptions(params.paperId)),
  errorComponent: () => (
    <RouteLoadError
      message="This paper could not be loaded."
      className="text-sm text-destructive"
    />
  ),
  component: PaperReaderPage,
});
