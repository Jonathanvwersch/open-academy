import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Link, Outlet, useRouterState } from '@tanstack/react-router';
import { TutorContextProvider } from '../tutor/TutorSidebar.js';

interface RouterContext {
  queryClient: QueryClient;
}

const navigation = [
  { label: 'Today', to: '/' },
  { label: 'Map', to: '/map' },
  { label: 'Lab', to: '/lab' },
  { label: 'Progress', to: '/progress' },
  { label: 'Settings', to: '/settings' },
] as const;

function RootLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-5">
          <Link to="/" className="text-sm font-semibold tracking-tight">
            Academy
          </Link>
          <nav aria-label="Main navigation" className="flex items-center gap-1">
            {navigation.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeProps={{ className: 'bg-neutral-100 text-neutral-900' }}
                className="rounded-md px-3 py-2 text-sm text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <TutorContextProvider
        routeAllowed={!pathname.startsWith('/diagnostic')}
        sessionRoute={pathname.startsWith('/session/')}
      >
        <main className="mx-auto max-w-5xl px-5 py-10">
          <Outlet />
        </main>
      </TutorContextProvider>
    </div>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});
