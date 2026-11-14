import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
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
  const searchCourseId = useRouterState({
    select: (state) => {
      const search = state.location.search as Record<string, unknown>;
      return typeof search.course === 'string' ? search.course : undefined;
    },
  });
  const { isMobile, state, setOpenMobile } = useSidebar();
  const { data: courseData } = useQuery(courseQueryOptions());
  const { data: reviewsData } = useQuery(reviewsQueryOptions());
  const startedCourses = courseData?.courses.filter((course) => course.started) ?? [];
  const selectedCourseId =
    pathname === '/course' && courseData?.courses.some((course) => course.id === searchCourseId)
      ? searchCourseId
      : courseData?.courses.find((course) => course.active)?.id;
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const switchCourse = useSwitchCourse(closeMobile);

  return (
    <Sidebar
      side="left"
      collapsible="icon"
      mobileWidth="18rem"
      role="navigation"
      aria-label="Main navigation"
    >
      <SidebarHeader
        className={`h-14 shrink-0 border-b border-sidebar-border p-0 ${
          !isMobile && state === 'collapsed'
            ? 'items-center justify-center'
            : 'flex-row items-center justify-between'
        }`}
      >
        {!isMobile && state === 'collapsed' ? (
          <SidebarTrigger
            aria-label="Expand navigation"
            title="Expand navigation"
            className="shrink-0"
          />
        ) : (
          <>
            <Link
              to="/"
              aria-label="Open Academy home"
              onClick={closeMobile}
              className="flex h-full min-w-0 flex-1 items-center rounded-md px-3 text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <BrandLockup size="sm" />
            </Link>
            {!isMobile ? (
              <SidebarTrigger
                aria-label="Collapse navigation"
                title="Collapse navigation"
                className="shrink-0"
              />
            ) : null}
          </>
        )}
      </SidebarHeader>
      <SidebarContent className="py-2">
        <SidebarGroup className="px-2 py-1">
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              {navigation.map(({ label, to, icon: Icon }) => (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton
                    asChild
                    isActive={!isMobile && isActive(pathname, to)}
                    tooltip={label}
                    className="text-sm"
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
              <SidebarMenu className="gap-1">
                {startedCourses.map((course) => {
                  const isActive = course.id === selectedCourseId;
                  const content = (
                    <>
                      <span className="min-w-0 flex-1 truncate text-sm">{course.title}</span>
                      <span className="ml-auto shrink-0 text-xs font-normal tabular-nums text-muted-foreground">
                        {course.topicsDone}/{course.topicsTotal}
                      </span>
                    </>
                  );
                  return (
                    <SidebarMenuItem key={course.id}>
                      {isActive ? (
                        <SidebarMenuButton
                          asChild
                          isActive={!isMobile}
                          className="items-center text-sm"
                        >
                          <Link
                            to="/course"
                            search={{ course: course.id }}
                            aria-label={`${course.title}, ${course.topicsDone} of ${course.topicsTotal} topics done`}
                            onClick={closeMobile}
                          >
                            {content}
                          </Link>
                        </SidebarMenuButton>
                      ) : (
                        <SidebarMenuButton asChild className="items-center text-sm">
                          <Link
                            to="/course"
                            search={{ course: course.id }}
                            preload="intent"
                            aria-label={`Switch to ${course.title}`}
                            onClick={(event) => {
                              if (
                                event.button !== 0 ||
                                event.metaKey ||
                                event.ctrlKey ||
                                event.shiftKey ||
                                event.altKey
                              ) {
                                return;
                              }
                              event.preventDefault();
                              closeMobile();
                              switchCourse.switchTo(course.id);
                            }}
                          >
                            {content}
                          </Link>
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
        <SidebarMenu className="gap-1">
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={!isMobile && isActive(pathname, '/settings')}
              tooltip="Settings"
              className="text-sm"
            >
              <Link to="/settings" aria-label="Settings" onClick={closeMobile}>
                <Settings aria-hidden="true" />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
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
        <BrandLockup size="sm" />
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
        className={`group hidden shrink-0 flex-col border-r bg-card md:flex ${
          sidebarOpen ? 'w-64' : 'w-12 items-center'
        }`}
      >
        <div
          className={`flex h-14 w-full shrink-0 items-center border-b ${
            sidebarOpen ? 'justify-between px-3' : 'justify-center'
          }`}
        >
          {sidebarOpen ? <BrandLockup size="sm" /> : null}
          <Skeleton className="size-8 rounded-md" />
        </div>
        <nav className="mt-2 w-full space-y-1 px-2">
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
        <div className="mt-auto w-full border-t p-2">
          <Skeleton className={`h-8 ${sidebarOpen ? 'w-full' : 'w-8'}`} />
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b bg-card px-3 md:hidden">
          <Skeleton className="size-8 rounded-md" />
          <BrandLockup size="sm" />
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
