import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, redirect } from '@tanstack/react-router';
import { AppShellSkeleton, RootLayout } from '@/app/app-shell.js';
import { authQueryOptions } from '../features/auth/queries.js';
import { PUBLIC_PATHS } from '../features/landing/public-paths.js';

interface RouterContext {
  queryClient: QueryClient;
}
export const Route = createRootRouteWithContext<RouterContext>()({
  pendingComponent: AppShellSkeleton,
  beforeLoad: async ({ context, location }) => {
    if (location.pathname === '/login' || location.pathname === PUBLIC_PATHS.howItWorks) {
      return { auth: undefined };
    }
    const auth = await context.queryClient.ensureQueryData(authQueryOptions());
    const isPublicPath = Object.values(PUBLIC_PATHS).some((path) => path === location.pathname);
    if (auth.authRequired && !auth.authenticated && !isPublicPath) {
      throw redirect({
        to: '/login',
        search: { redirect: `${location.pathname}${location.searchStr}` },
      });
    }
    return { auth };
  },
  component: RootLayout,
});
