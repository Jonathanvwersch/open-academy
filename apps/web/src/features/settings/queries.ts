import type { SettingsPayload } from '@open-academy/engine/api';
import { queryOptions } from '@tanstack/react-query';
import { getJson } from '../../api/query-client.js';
export const settingsQueryOptions = () =>
  queryOptions({
    queryKey: ['settings'] as const,
    queryFn: () => getJson<SettingsPayload>('/api/settings', 'Could not load settings'),
  });
