import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { Activity, BookOpen, House, Network, RotateCcw, Settings } from 'lucide-react';
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
  SidebarMenuSkeleton,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '../components/ui/sidebar.js';
import { Skeleton } from '../components/ui/skeleton.js';
import { TooltipProvider } from '../components/ui/tooltip.js';
import { coursesQueryOptions } from '../features/course/queries.js';
import { reviewsQueryOptions } from '../features/reviews/queries.js';
import { TutorContextProvider } from '../features/tutor/tutor-sidebar.js';

const SIDEBAR_STORAGE_KEY = 'academy.app-sidebar.open';

const navigation = [
  { label: 'Home', to: '/', icon: House },
  { label: 'Courses', to: '/courses', icon: BookOpen },
  { label: 'Map', to: '/map', icon: Network },
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
  const coursesQuery = useQuery(coursesQueryOptions());
  const reviewsQuery = useQuery(reviewsQueryOptions());
  const courseData = coursesQuery.data;
  const reviewsData = reviewsQuery.data;
  const loadingCourses = coursesQuery.isPending && !courseData;
  const loadingReviews = reviewsQuery.isPending && !reviewsData;
  const showCourseSection = state !== 'collapsed' || isMobile;
  const activeCourses =
    courseData?.subjects.flatMap((subject) =>
      subject.courses.filter((course) => course.status === 'active'),
    ) ?? [];
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };

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
                      {label === 'Reviews' && loadingReviews ? (
                        <SidebarMenuBadge data-testid="reviews-due-skeleton" aria-hidden="true">
                          <Skeleton className="size-3 rounded-sm" />
                        </SidebarMenuBadge>
                      ) : label === 'Reviews' && reviewsData && reviewsData.dueNow > 0 ? (
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
        {showCourseSection && (activeCourses.length > 0 || loadingCourses) ? (
          <SidebarGroup className="px-2 py-1">
            <SidebarGroupLabel>My courses</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-1">
                {loadingCourses
                  ? ['first', 'wrapped', 'third'].map((row) => {
                      const wraps = row === 'wrapped' && !isMobile;
                      return (
                        <SidebarMenuItem
                          key={`course-skeleton-${row}`}
                          data-testid="sidebar-course-skeleton"
                          aria-hidden="true"
                        >
                          <div className="relative">
                            <SidebarMenuSkeleton
                              className={`h-auto py-2 pr-12 ${
                                wraps ? 'min-h-[4.75rem] items-start' : 'min-h-9'
                              }`}
                            />
                            {wraps ? <Skeleton className="absolute left-2 top-7 h-3 w-24" /> : null}
                            {wraps ? (
                              <Skeleton className="absolute bottom-2 left-2 h-3 w-20" />
                            ) : null}
                            <Skeleton
                              className={`absolute right-2 h-3 w-8 ${
                                wraps ? 'top-2' : 'top-1/2 -translate-y-1/2'
                              }`}
                            />
                          </div>
                        </SidebarMenuItem>
                      );
                    })
                  : activeCourses.map((course) => {
                      const isActive =
                        pathname === `/courses/${course.id}` ||
                        pathname.startsWith(`/courses/${course.id}/`);
                      const content = (
                        <>
                          <span className="min-w-0 flex-1 whitespace-normal break-words text-sm">
                            {course.title}
                          </span>
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
                              className="h-auto min-h-8 items-start py-2 text-sm"
                            >
                              <Link
                                to="/courses/$courseId"
                                params={{ courseId: course.id }}
                                preload="intent"
                                aria-label={`${course.title}, ${course.topicsDone} of ${course.topicsTotal} topics done`}
                                onClick={closeMobile}
                              >
                                {content}
                              </Link>
                            </SidebarMenuButton>
                          ) : (
                            <SidebarMenuButton
                              asChild
                              className="h-auto min-h-8 items-start py-2 text-sm"
                            >
                              <Link
                                to="/courses/$courseId"
                                params={{ courseId: course.id }}
                                preload="intent"
                                aria-label={`Open ${course.title}`}
                                onClick={closeMobile}
                              >
                                {content}
                              </Link>
                            </SidebarMenuButton>
                          )}
                        </SidebarMenuItem>
                      );
                    })}
              </SidebarMenu>
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
              : pathname === '/map'
                ? 'flex w-full flex-1 flex-col py-4'
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
                  : pathname === '/map'
                    ? 'flex w-full flex-1 flex-col py-4'
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
