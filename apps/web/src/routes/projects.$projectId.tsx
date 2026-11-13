import { createFileRoute } from '@tanstack/react-router';
import { ProjectPage } from '@/features/projects/project-page.js';
import { RouteLoadError } from '../components/route-error.js';
import { ProjectSkeleton } from '../components/skeletons.js';
import { projectQueryOptions } from '../features/projects/queries.js';

export const Route = createFileRoute('/projects/$projectId')({
  pendingComponent: ProjectSkeleton,
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(projectQueryOptions(params.projectId)),
  errorComponent: () => <RouteLoadError message="Project unavailable." role="alert" />,
  component: ProjectPage,
});
