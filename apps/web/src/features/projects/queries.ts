import type { ProjectPayload } from '@academy/contracts/projects';
import { queryOptions } from '@tanstack/react-query';
import { getJson } from '../../api/query-client.js';
export const projectQueryOptions = (projectId: string) =>
  queryOptions({
    queryKey: ['project', projectId] as const,
    queryFn: () =>
      getJson<ProjectPayload>(
        `/api/projects/${encodeURIComponent(projectId)}`,
        'Project unavailable',
      ),
  });
