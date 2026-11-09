import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  Link,
  Outlet,
  redirect,
  useRouterState,
} from '@tanstack/react-router';
import { Button } from '@/ui/button.js';
import { Skeleton } from '@/ui/skeleton.js';
import { TooltipProvider } from '@/ui/tooltip.js';
import { authQueryOptions } from '../queries.js';
import { PageSkeleton } from '../skeletons.js';
import { TutorContextProvider } from '../tutor/TutorSidebar.js';

interface RouterContext {
  queryClient: QueryClient;
}

const navigation = [
  { label: 'Home', to: '/' },
  { label: 'Course', to: '/course' },
  { label: 'Progress', to: '/progress' },
  { label: 'Settings', to: '/settings' },
] as const;

function AppShellSkeleton() {
  return (
    <div aria-hidden="true" data-testid="app-shell-skeleton" className="min-h-screen bg-background">
      <header className="h-14 border-b bg-background">
        <div className="mx-auto flex h-full w-full max-w-3xl items-center justify-between gap-4 px-4 sm:px-6">
          <Skeleton className="hidden h-4 w-20 sm:block" />
          <nav className="-mx-4 flex w-[calc(100%+2rem)] items-center justify-between gap-0 sm:mx-0 sm:w-auto sm:flex-1 sm:justify-end sm:gap-0.5">
            {['w-10', 'w-12', 'w-14', 'w-16'].map((width) => (
              <Skeleton key={width} className={`h-7 ${width}`} />
            ))}
          </nav>
        </div>
      </header>
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
        <PageSkeleton />
      </div>
    </div>
  );
}

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
            <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-4 px-4 sm:px-6">
              <Link to="/" className="hidden text-sm font-semibold tracking-tight sm:block">
                Academy
              </Link>
              <nav
                aria-label="Main navigation"
                className="-mx-4 flex w-[calc(100%+2rem)] items-center justify-between gap-0 sm:mx-0 sm:w-auto sm:min-w-0 sm:flex-1 sm:justify-end sm:gap-0.5"
              >
                {navigation.map((item) => (
                  <Button
                    key={item.to}
                    asChild
                    size="sm"
                    className="px-2 text-[13px] sm:px-3 sm:text-[0.8rem]"
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
                : 'mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8'
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
  pendingComponent: AppShellSkeleton,
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
