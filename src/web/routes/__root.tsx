import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  Link,
  Outlet,
  redirect,
  useRouterState,
} from '@tanstack/react-router';
import { Button } from '@/ui/button.js';
import { TooltipProvider } from '@/ui/tooltip.js';
import { authQueryOptions } from '../queries.js';
import { TutorContextProvider } from '../tutor/TutorSidebar.js';

interface RouterContext {
  queryClient: QueryClient;
}

const navigation = [
  { label: 'Learn', to: '/' },
  { label: 'Course', to: '/course' },
  { label: 'Map', to: '/map' },
  { label: 'Lab', to: '/lab' },
  { label: 'Progress', to: '/progress' },
  { label: 'Settings', to: '/settings' },
] as const;

function RootLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  if (pathname === '/login') return <Outlet />;
  const isPaperReader = pathname.startsWith('/papers/');
  return (
    <TooltipProvider>
      <TutorContextProvider
        routeAllowed={!pathname.startsWith('/diagnostic')}
        pushSidebar={isPaperReader}
      >
        <div
          className={`flex min-w-0 flex-col bg-background text-foreground ${
            isPaperReader ? 'min-h-0 flex-1' : 'min-h-screen'
          }`}
        >
          <header className="border-b bg-background">
            <div className="mx-auto flex h-14 max-w-3xl items-center justify-between gap-4 px-5">
              <Link to="/" className="text-sm font-semibold tracking-tight">
                Academy
              </Link>
              <nav aria-label="Main navigation" className="flex items-center gap-1">
                {navigation.map((item) => (
                  <Button
                    key={item.to}
                    asChild
                    size="sm"
                    variant={
                      pathname === item.to || (item.to !== '/' && pathname.startsWith(item.to))
                        ? 'secondary'
                        : 'ghost'
                    }
                  >
                    <Link to={item.to}>{item.label}</Link>
                  </Button>
                ))}
              </nav>
            </div>
          </header>
          <div
            className={
              isPaperReader
                ? 'flex w-full min-h-0 min-w-0 flex-1 px-0 py-0'
                : 'mx-auto w-full max-w-3xl px-5 py-8'
            }
          >
            <Outlet />
          </div>
        </div>
      </TutorContextProvider>
    </TooltipProvider>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context, location }) => {
    const auth = await context.queryClient.ensureQueryData(authQueryOptions());
    if (auth.authRequired && !auth.authenticated && location.pathname !== '/login') {
      throw redirect({
        to: '/login',
        search: { redirect: `${location.pathname}${location.searchStr}` },
      });
    }
  },
  component: RootLayout,
});
