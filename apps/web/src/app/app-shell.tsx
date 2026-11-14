import type { CourseCatalogPayload } from '@academy/contracts/course';
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

function useAppSidebarOpenState() {
  const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);
  const updateSidebarOpen = useCallback((open: boolean) => {
    setSidebarOpen(open);
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(open));
  }, []);
  return { sidebarOpen, updateSidebarOpen };
}

function pageFrameClassName(pathname: string) {
  if (pathname.startsWith('/papers/')) {
    return 'flex min-h-0 min-w-0 w-full flex-1 px-0 py-0';
  }
  if (pathname === '/map') {
    return 'flex w-full flex-1 flex-col py-4';
  }
  return 'mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pt-6 pb-20 sm:px-6 sm:py-8';
}

interface AppSidebarViewProps {
  courses?: CourseCatalogPayload;
  loadingCourses: boolean;
  reviewsDue?: number;
  loadingReviews: boolean;
}

function AppSidebarView({
  courses,
  loadingCourses,
  reviewsDue,
  loadingReviews,
}: AppSidebarViewProps) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { isMobile, state, setOpenMobile } = useSidebar();
  const showCourseSection = state !== 'collapsed' || isMobile;
  const activeCourses =
    courses?.subjects.flatMap((subject) =>
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
                      ) : label === 'Reviews' && reviewsDue !== undefined && reviewsDue > 0 ? (
                        <SidebarMenuBadge data-testid="reviews-due-count">
                          {reviewsDue}
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
                  ? [
                      { id: 'first', titleWidth: 'w-3/4' },
                      { id: 'second', titleWidth: 'w-3/5' },
                      { id: 'third', titleWidth: 'w-[68%]' },
                    ].map(({ id, titleWidth }) => {
                      return (
                        <SidebarMenuItem
                          key={`course-skeleton-${id}`}
                          data-testid="sidebar-course-skeleton"
                          aria-hidden="true"
                        >
                          <div className="flex h-9 items-center gap-2 rounded-md px-2">
                            <Skeleton className={`h-4 ${titleWidth}`} />
                            <Skeleton className="ml-auto h-3 w-8 shrink-0" />
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

function AppSidebar() {
  const coursesQuery = useQuery(coursesQueryOptions());
  const reviewsQuery = useQuery(reviewsQueryOptions());
  return (
    <AppSidebarView
      courses={coursesQuery.data}
      loadingCourses={coursesQuery.isPending && !coursesQuery.data}
      reviewsDue={reviewsQuery.data?.dueNow}
      loadingReviews={reviewsQuery.isPending && !reviewsQuery.data}
    />
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
  const { sidebarOpen, updateSidebarOpen } = useAppSidebarOpenState();
  return (
    <TooltipProvider>
      <SidebarProvider
        data-testid="app-shell-skeleton"
        open={sidebarOpen}
        onOpenChange={updateSidebarOpen}
        disableKeyboardShortcut
      >
        <AppSidebarView loadingCourses loadingReviews />
        <SidebarInset className="min-w-0">
          <MobileAppHeader />
          <div data-page-frame className={pageFrameClassName(pathname)}>
            <PageSkeleton />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
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
  const { sidebarOpen, updateSidebarOpen } = useAppSidebarOpenState();
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
            <div ref={contentRef} data-page-frame className={pageFrameClassName(pathname)}>
              <Outlet />
            </div>
          </TutorContextProvider>
        </SidebarInset>
        <AppToaster />
      </SidebarProvider>
    </TooltipProvider>
  );
}
