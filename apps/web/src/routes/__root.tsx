import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, isRedirect, redirect } from '@tanstack/react-router';
import { RootLayout, RootPending } from '@/app/app-shell.js';
import { appUrl, hostRole, siteUrl } from '@/lib/site-origins.js';
import { authQueryOptions } from '../features/auth/queries.js';
import { resolveHostRoute } from '../features/landing/host-routing.js';
import { setAppShellHint } from '../lib/app-shell-hint.js';

interface RouterContext {
  queryClient: QueryClient;
}
export const Route = createRootRouteWithContext<RouterContext>()({
  pendingComponent: RootPending,
  beforeLoad: async ({ context, location }) => {
    const routeInput = {
      role: hostRole(),
      pathname: location.pathname,
      search: location.searchStr,
      appUrl,
      siteUrl,
    };
    let decision = resolveHostRoute(routeInput);
    if (decision.type === 'auth') {
      const auth = await context.queryClient.ensureQueryData(authQueryOptions());
      setAppShellHint(!auth.authRequired || auth.authenticated);
      decision = resolveHostRoute({ ...routeInput, auth });
    }
    if (decision.type === 'redirect' && 'href' in decision) {
      try {
        throw redirect({ href: decision.href, reloadDocument: true });
      } catch (error) {
        if (isRedirect(error)) throw error;
        window.location.replace(decision.href);
        return { auth: undefined };
      }
    }
    if (decision.type === 'redirect') {
      throw redirect({
        to: decision.to,
        ...(decision.search ? { search: decision.search } : {}),
      });
    }
    if (decision.type === 'auth')
      throw new Error('Host route did not resolve after authentication');
    return { auth: decision.auth };
  },
  component: RootLayout,
});
