import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { Toaster } from 'sonner';
import { useCapturePageLayout } from '../components/page-layout-skeleton.js';
import { PageSkeleton } from '../components/skeletons.js';
import { Button } from '../components/ui/button.js';
import { Logo } from '../components/ui/logo.js';
import { Skeleton } from '../components/ui/skeleton.js';
import { TooltipProvider } from '../components/ui/tooltip.js';
import { TutorContextProvider } from '../features/tutor/tutor-sidebar.js';

const navigation = [
  { label: 'Home', to: '/' },
  { label: 'Course', to: '/course' },
  { label: 'Reviews', to: '/reviews' },
  { label: 'Progress', to: '/progress' },
  { label: 'Settings', to: '/settings' },
] as const;

export function AppShellSkeleton() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isPaperReader = pathname.startsWith('/papers/');
  return (
    <div
      aria-hidden="true"
      data-testid="app-shell-skeleton"
      className="flex min-h-screen flex-col bg-background"
    >
      <header className="h-14 border-b bg-card">
        <div className="mx-auto flex h-full w-full max-w-3xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="hidden items-center gap-2 text-sm font-semibold tracking-tight sm:flex">
            <Logo className="size-5" />
            Open Academy
          </div>
          <nav className="flex min-w-0 flex-1 items-center justify-between gap-0 sm:w-auto sm:justify-end sm:gap-0.5">
            {navigation.map((item) => (
              <span
                key={item.to}
                className="relative inline-flex h-7 items-center px-1.5 text-xs max-[360px]:px-1 sm:px-3 sm:text-[0.8rem]"
              >
                <span className="invisible">{item.label}</span>
                <Skeleton className="absolute inset-x-1.5 h-4 max-[360px]:inset-x-1 sm:inset-x-3" />
              </span>
            ))}
          </nav>
        </div>
      </header>
      <div
        data-page-frame
        className={
          isPaperReader
            ? 'flex min-h-0 min-w-0 w-full flex-1 px-0 py-0'
            : 'mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pt-6 pb-20 sm:px-6 sm:py-8'
        }
      >
        <PageSkeleton />
      </div>
    </div>
  );
}

function AppToaster() {
  return (
    <Toaster
      position="bottom-center"
      style={{ fontFamily: 'inherit' }}
      toastOptions={{
        className: 'border border-border bg-background text-foreground shadow-md',
        descriptionClassName: 'text-muted-foreground',
      }}
      icons={{ success: null }}
    />
  );
}

export function RootLayout() {
  const contentRef = useCapturePageLayout();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  if (pathname === '/login') {
    return (
      <>
        <Outlet />
        <AppToaster />
      </>
    );
  }
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
          <header className="border-b bg-card">
            <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-4 px-4 sm:px-6">
              <Link
                to="/"
                className="hidden items-center gap-2 text-sm font-semibold tracking-tight sm:flex"
              >
                <Logo className="size-5" />
                Open Academy
              </Link>
              <nav
                aria-label="Main navigation"
                className="flex min-w-0 flex-1 items-center justify-between gap-0 sm:w-auto sm:justify-end sm:gap-0.5"
              >
                {navigation.map((item) => (
                  <Button
                    key={item.to}
                    asChild
                    size="sm"
                    className="px-1.5 text-xs max-[360px]:px-1 sm:px-3 sm:text-[0.8rem]"
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
            ref={contentRef}
            data-page-frame
            className={
              isPaperReader
                ? 'flex w-full min-h-0 min-w-0 flex-1 px-0 py-0'
                : 'mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pt-6 pb-20 sm:px-6 sm:py-8'
            }
          >
            <Outlet />
          </div>
        </div>
      </TutorContextProvider>
      <AppToaster />
    </TooltipProvider>
  );
}
