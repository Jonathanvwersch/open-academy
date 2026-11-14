import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, redirect } from '@tanstack/react-router';
import { AppShellSkeleton, RootLayout } from '@/app/app-shell.js';
import { authQueryOptions } from '../features/auth/queries.js';

interface RouterContext {
  queryClient: QueryClient;
}
export const Route = createRootRouteWithContext<RouterContext>()({
  pendingComponent: AppShellSkeleton,
  beforeLoad: async ({ context, location }) => {
    if (location.pathname === '/login') return { auth: undefined };
    const auth = await context.queryClient.ensureQueryData(authQueryOptions());
    if (auth.authRequired && !auth.authenticated && location.pathname !== '/login') {
      throw redirect({
        to: '/login',
        search: { redirect: `${location.pathname}${location.searchStr}` },
      });
    }
    return { auth };
  },
  component: RootLayout,
});
