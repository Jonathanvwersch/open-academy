import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { Activity, BookOpen, House, RotateCcw, Settings } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Toaster } from 'sonner';
import { BrandLockup } from '../components/brand-lockup.js';
import { useCapturePageLayout } from '../components/page-layout-skeleton.js';
import { PageSkeleton } from '../components/skeletons.js';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '../components/ui/sidebar.js';
import { Skeleton } from '../components/ui/skeleton.js';
import { TooltipProvider } from '../components/ui/tooltip.js';
import { courseQueryOptions } from '../features/course/queries.js';
import { useSwitchCourse } from '../features/course/use-switch-course.js';
import { reviewsQueryOptions } from '../features/reviews/queries.js';
import { TutorContextProvider } from '../features/tutor/tutor-sidebar.js';

const SIDEBAR_STORAGE_KEY = 'academy.app-sidebar.open';

const navigation = [
  { label: 'Home', to: '/', icon: House },
  { label: 'Courses', to: '/course', icon: BookOpen },
  { label: 'Reviews', to: '/reviews', icon: RotateCcw },
  { label: 'Progress', to: '/progress', icon: Activity },
] as const;

function isActive(pathname: string, to: string) {
  return pathname === to || (to !== '/' && pathname.startsWith(to));
}

function initialSidebarOpen() {
  return localStorage.getItem(SIDEBAR_STORAGE_KEY) !== 'false';
}

function AppSidebar() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { isMobile, state, setOpenMobile } = useSidebar();
  const navigate = useNavigate();
  const { data: courseData } = useQuery(courseQueryOptions());
  const { data: reviewsData } = useQuery(reviewsQueryOptions());
  const startedCourses = courseData?.courses.filter((course) => course.started) ?? [];
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const switchCourse = useSwitchCourse(async () => {
    await navigate({ to: '/course' });
    closeMobile();
  });

  return (
    <Sidebar side="left" collapsible="icon" role="navigation" aria-label="Main navigation">
      <SidebarHeader className="border-b border-sidebar-border p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" tooltip="Open Academy">
              <Link
                to="/"
                aria-label="Open Academy home"
                onClick={closeMobile}
                className="text-sm font-semibold tracking-tight"
              >
                <BrandLockup hideNameWhenSidebarCollapsed />
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="py-2">
        <SidebarGroup className="px-2 py-1">
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation.map(({ label, to, icon: Icon }) => (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive(pathname, to)}
                    tooltip={label}
                    className="text-xs sm:text-[0.8rem]"
                  >
                    <Link to={to} aria-label={label} onClick={closeMobile}>
                      <Icon aria-hidden="true" />
                      <span>{label}</span>
                      {label === 'Reviews' && reviewsData && reviewsData.dueNow > 0 ? (
                        <SidebarMenuBadge data-testid="reviews-due-count">
                          {reviewsData.dueNow}
                        </SidebarMenuBadge>
                      ) : null}
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {startedCourses.length > 0 && (state !== 'collapsed' || isMobile) ? (
          <SidebarGroup className="px-2 py-1">
            <SidebarGroupLabel>My courses</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {startedCourses.map((course) => {
                  const content = (
                    <>
                      <span className="truncate">{course.title}</span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {course.topicsDone}/{course.topicsTotal} topics
                      </span>
                    </>
                  );
                  return (
                    <SidebarMenuItem key={course.id}>
                      {course.active ? (
                        <SidebarMenuButton asChild isActive className="h-auto min-h-10 items-start">
                          <Link to="/course" aria-label={course.title} onClick={closeMobile}>
                            {content}
                          </Link>
                        </SidebarMenuButton>
                      ) : (
                        <SidebarMenuButton
                          asChild
                          disabled={switchCourse.isPending}
                          className="h-auto min-h-10 items-start"
                        >
                          <button
                            type="button"
                            aria-label={`Switch to ${course.title}`}
                            onClick={() => switchCourse.mutate(course.id)}
                          >
                            {content}
                          </button>
                        </SidebarMenuButton>
                      )}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
              {switchCourse.isError ? (
                <p role="alert" className="px-2 pt-2 text-xs text-destructive">
                  {switchCourse.error.message}
                </p>
              ) : null}
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={isActive(pathname, '/settings')}
              tooltip="Settings"
              className="text-xs sm:text-[0.8rem]"
            >
              <Link to="/settings" aria-label="Settings" onClick={closeMobile}>
                <Settings aria-hidden="true" />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {!isMobile ? (
            <SidebarMenuItem>
              <SidebarTrigger
                aria-label={state === 'expanded' ? 'Collapse navigation' : 'Expand navigation'}
                title={state === 'expanded' ? 'Collapse navigation' : 'Expand navigation'}
                className="w-full justify-start"
              />
            </SidebarMenuItem>
          ) : null}
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

function MobileAppHeader() {
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b bg-card px-3 md:hidden">
      <SidebarTrigger aria-label="Open navigation" title="Open navigation" />
      <Link to="/" aria-label="Open Academy home" className="min-w-0">
        <BrandLockup />
      </Link>
    </header>
  );
}

export function AppShellSkeleton() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isPaperReader = pathname.startsWith('/papers/');
  const [sidebarOpen] = useState(initialSidebarOpen);
  return (
    <div
      aria-hidden="true"
      data-testid="app-shell-skeleton"
      className="flex min-h-svh bg-background"
    >
      <aside
        data-collapsible={sidebarOpen ? '' : 'icon'}
        className={`group hidden shrink-0 flex-col border-r bg-card py-4 md:flex ${
          sidebarOpen ? 'w-64 px-3' : 'w-12 items-center px-1'
        }`}
      >
        <div className={`flex h-12 items-center ${sidebarOpen ? 'px-3' : 'justify-center'}`}>
          <BrandLockup hideNameWhenSidebarCollapsed />
        </div>
        <nav className="mt-4 w-full space-y-1">
          {navigation.map(({ label }) => (
            <div
              key={label}
              className={`flex h-8 items-center rounded-md px-2 ${
                sidebarOpen ? 'gap-3' : 'justify-center'
              }`}
            >
              <Skeleton className="size-4 shrink-0" />
              {sidebarOpen ? <Skeleton className="h-4 w-20" /> : null}
            </div>
          ))}
          {sidebarOpen ? (
            <div className="space-y-2 pt-5">
              <Skeleton className="mx-2 h-3 w-16" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-4/5" />
            </div>
          ) : null}
        </nav>
        <div className="mt-auto w-full space-y-2 border-t pt-3">
          <Skeleton className={`h-8 ${sidebarOpen ? 'w-full' : 'w-8'}`} />
          <Skeleton className="h-8 w-8" />
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b bg-card px-3 md:hidden">
          <Skeleton className="size-8 rounded-md" />
          <BrandLockup />
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
      </main>
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
  const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);
  const updateSidebarOpen = useCallback((open: boolean) => {
    setSidebarOpen(open);
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(open));
  }, []);
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
      <SidebarProvider open={sidebarOpen} onOpenChange={updateSidebarOpen} disableKeyboardShortcut>
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <MobileAppHeader />
          <TutorContextProvider
            routeAllowed={!pathname.startsWith('/placement')}
            pushSidebar={isPaperReader}
          >
            <div
              ref={contentRef}
              data-page-frame
              className={
                isPaperReader
                  ? 'flex min-h-0 min-w-0 w-full flex-1 px-0 py-0'
                  : 'mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pt-6 pb-20 sm:px-6 sm:py-8'
              }
            >
              <Outlet />
            </div>
          </TutorContextProvider>
        </SidebarInset>
        <AppToaster />
      </SidebarProvider>
    </TooltipProvider>
  );
}
