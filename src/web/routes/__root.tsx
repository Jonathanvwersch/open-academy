import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Link, Outlet, useRouterState } from '@tanstack/react-router';
import { Button } from '@/ui/button.js';
import { TooltipProvider } from '@/ui/tooltip.js';
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
  return (
    <TooltipProvider>
      <TutorContextProvider
        routeAllowed={!pathname.startsWith('/diagnostic')}
        sessionRoute={pathname.startsWith('/session/')}
      >
        <div className="min-h-screen bg-background text-foreground">
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
          <div className="mx-auto max-w-3xl px-5 py-8">
            <Outlet />
          </div>
        </div>
      </TutorContextProvider>
    </TooltipProvider>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});
