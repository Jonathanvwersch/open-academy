import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@/features/settings/settings-page.js';
import { SettingsSkeleton } from '../components/skeletons.js';
import { settingsQueryOptions } from '../features/settings/queries.js';

export const Route = createFileRoute('/settings')({
  pendingComponent: SettingsSkeleton,
  loader: ({ context }) => context.queryClient.ensureQueryData(settingsQueryOptions()),
  component: SettingsPage,
});
