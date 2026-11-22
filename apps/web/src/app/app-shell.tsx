import type { AuthPayload } from '@academy/contracts/auth';
import type { CourseCatalogPayload } from '@academy/contracts/course';
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { Activity, BookOpen, House, ListOrdered, RotateCcw, Settings } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { Toaster } from 'sonner';
import { BrandLockup } from '../components/brand-lockup.js';
import { isLayout, LayoutShapeLayer } from '../components/layout-shapes.js';
import type { Layout } from '../components/page-layout-skeleton.js';
import {
  measureLayout,
  PageLoadingIndicator,
  useCapturePageLayout,
} from '../components/page-layout-skeleton.js';
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
import { authQueryOptions } from '../features/auth/queries.js';
import { coursesQueryOptions } from '../features/course/queries.js';
import { isPublicPath, normalizePath, PUBLIC_PATHS } from '../features/landing/public-paths.js';
import { reviewsQueryOptions } from '../features/reviews/queries.js';
import { TutorContextProvider } from '../features/tutor/tutor-sidebar.js';
import { hasAppShellHint } from '../lib/app-shell-hint.js';
import { readBrowserStorage, writeBrowserStorage } from '../lib/browser-storage.js';
import { useCurrentCourseId } from '../lib/current-course.js';
import { hostRole } from '../lib/site-origins.js';

const SIDEBAR_STORAGE_KEY = 'academy.app-sidebar.open';
const SIDEBAR_COURSE_GROUPS_KEY = 'academy.sidebar-course-groups';
const SIDEBAR_COURSE_LAYOUT_KEY = `academy.sidebar-course-layout.${import.meta.env.PROD ? new URL(import.meta.url).pathname : 'dev-3'}`;
const DEFAULT_SIDEBAR_COURSE_GROUP_COUNTS = [1, 3];
const COURSE_SKELETON_TITLE_WIDTHS = ['w-3/4', 'w-3/5', 'w-[68%]'];
const COURSE_SKELETON_GROUP_KEYS = Array.from({ length: 12 }, (_, index) => `group-${index + 1}`);
const COURSE_SKELETON_ROW_KEYS = Array.from({ length: 30 }, (_, index) => `row-${index + 1}`);

const navigation = [
  { label: 'Home', to: '/', icon: House },
  { label: 'Courses', to: '/courses', icon: BookOpen },
  { label: 'Up next', to: '/map', icon: ListOrdered },
  { label: 'Reviews', to: '/reviews', icon: RotateCcw },
  { label: 'Progress', to: '/progress', icon: Activity },
] as const;

function readSidebarCourseGroupCounts(): number[] {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_COURSE_GROUPS_KEY);
    if (!stored) return [...DEFAULT_SIDEBAR_COURSE_GROUP_COUNTS];
    const counts: unknown = JSON.parse(stored);
    if (
      Array.isArray(counts) &&
      counts.length >= 1 &&
      counts.length <= 12 &&
      counts.every(
        (count: unknown) =>
          typeof count === 'number' && Number.isInteger(count) && count > 0 && count <= 30,
      )
    ) {
      return counts as number[];
    }
  } catch {}
  return [...DEFAULT_SIDEBAR_COURSE_GROUP_COUNTS];
}

function writeSidebarCourseGroupCounts(counts: number[]) {
  try {
    window.localStorage.setItem(SIDEBAR_COURSE_GROUPS_KEY, JSON.stringify(counts));
  } catch {}
}

function readSidebarCourseLayout(width: number): Layout | undefined {
  if (width <= 0) return undefined;
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(SIDEBAR_COURSE_LAYOUT_KEY) ?? '{}',
    ) as Record<string, unknown> | null;
    const layout = stored?.[String(Math.round(width))];
    return isLayout(layout) ? layout : undefined;
  } catch {}
  return undefined;
}

function writeSidebarCourseLayout(width: number, layout: Layout) {
  if (width <= 0) return;
  try {
    const stored = JSON.parse(window.localStorage.getItem(SIDEBAR_COURSE_LAYOUT_KEY) ?? '{}');
    const layouts =
      stored && typeof stored === 'object' && !Array.isArray(stored)
        ? (stored as Record<string, unknown>)
        : {};
    window.localStorage.setItem(
      SIDEBAR_COURSE_LAYOUT_KEY,
      JSON.stringify({ ...layouts, [String(Math.round(width))]: layout }),
    );
  } catch {}
}

function isActive(pathname: string, to: string) {
  return pathname === to || (to !== '/' && pathname.startsWith(to));
}

function initialSidebarOpen() {
  return readBrowserStorage('localStorage', SIDEBAR_STORAGE_KEY) !== 'false';
}

function useAppSidebarOpenState() {
  const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);
  const updateSidebarOpen = useCallback((open: boolean) => {
    setSidebarOpen(open);
    writeBrowserStorage('localStorage', SIDEBAR_STORAGE_KEY, String(open));
  }, []);
  return { sidebarOpen, updateSidebarOpen };
}

function pageFrameClassName(pathname: string) {
  if (pathname.startsWith('/papers/')) {
    return 'flex min-h-0 min-w-0 w-full flex-1 flex-col px-0 py-0';
  }
  if (pathname === '/map') {
    return 'flex w-full flex-1 flex-col py-4 md:pt-3';
  }
  return 'mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pt-6 pb-20 sm:px-6 sm:py-8 md:pt-3';
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
  const currentCourseId = useCurrentCourseId();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { isMobile, state, setOpenMobile } = useSidebar();
  const showCourseSection = state !== 'collapsed' || isMobile;
  const activeCourseGroups =
    courses?.subjects
      .map((subject) => ({
        ...subject,
        courses: subject.courses.filter((course) => course.status === 'active'),
      }))
      .filter((subject) => subject.courses.length > 0) ?? [];
  const activeCourses = activeCourseGroups.flatMap((subject) => subject.courses);
  const [loadingCourseGroupCounts] = useState(readSidebarCourseGroupCounts);
  const [courseSection, setCourseSection] = useState<HTMLDivElement | null>(null);
  const [sidebarCourseLayout, setSidebarCourseLayout] = useState<Layout>();
  useEffect(() => {
    if (loadingCourses || !courses) return;
    const counts = courses.subjects
      .map((subject) => subject.courses.filter((course) => course.status === 'active').length)
      .filter((count) => count > 0);
    if (counts.length) writeSidebarCourseGroupCounts(counts);
  }, [courses, loadingCourses]);
  useLayoutEffect(() => {
    const element = courseSection;
    if (!element || !showCourseSection) return;
    const update = () => {
      const width = element.getBoundingClientRect().width;
      if (width > 0) setSidebarCourseLayout(readSidebarCourseLayout(width));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [courseSection, showCourseSection]);
  useEffect(() => {
    const element = courseSection;
    const hasActiveCourses =
      courses?.subjects.some((subject) =>
        subject.courses.some((course) => course.status === 'active'),
      ) ?? false;
    if (!element || loadingCourses || !showCourseSection || !hasActiveCourses) return;
    let timer: ReturnType<typeof setTimeout>;
    let active = true;
    const capture = () => {
      if (!active) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!active || !element.isConnected || document.fonts.status !== 'loaded') return;
        const width = element.getBoundingClientRect().width;
        const layout = measureLayout(element);
        if (layout.shapes.length) {
          writeSidebarCourseLayout(width, layout);
          setSidebarCourseLayout(layout);
        }
      }, 120);
    };
    const resize = new ResizeObserver(capture);
    const mutations = new MutationObserver(capture);
    resize.observe(element);
    mutations.observe(element, { childList: true, subtree: true, characterData: true });
    void document.fonts.ready.then(capture);
    capture();
    return () => {
      active = false;
      clearTimeout(timer);
      resize.disconnect();
      mutations.disconnect();
    };
  }, [courseSection, courses, loadingCourses, showCourseSection]);
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const renderCourseSkeletons = (count: number, groupKey: string) =>
    COURSE_SKELETON_ROW_KEYS.slice(0, count).map((rowKey, index) => (
      <SidebarMenuItem
        key={`${groupKey}-${rowKey}`}
        data-testid="sidebar-course-skeleton"
        aria-hidden="true"
      >
        <div className="flex h-9 items-center gap-2 rounded-md px-2">
          <Skeleton
            className={`h-4 ${COURSE_SKELETON_TITLE_WIDTHS[index % COURSE_SKELETON_TITLE_WIDTHS.length] ?? 'w-3/4'}`}
          />
          <Skeleton className="ml-auto h-3 w-8 shrink-0" />
        </div>
      </SidebarMenuItem>
    ));

  const renderCourse = (course: (typeof activeCourseGroups)[number]['courses'][number]) => {
    const isActive =
      currentCourseId === course.id ||
      pathname === `/courses/${course.id}` ||
      pathname.startsWith(`/courses/${course.id}/`);
    const content = (
      <>
        <span className="min-w-0 flex-1 whitespace-normal break-words text-sm">{course.title}</span>
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
          <SidebarMenuButton asChild className="h-auto min-h-8 items-start py-2 text-sm">
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
        className={`h-14 shrink-0 border-b border-sidebar-border px-2 py-0 ${
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
              className="flex h-full min-w-0 flex-1 items-center rounded-md px-2 text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        {showCourseSection ? (
          <div
            ref={setCourseSection}
            data-testid="sidebar-course-section"
            className="w-full min-w-0"
          >
            {loadingCourses ? (
              sidebarCourseLayout ? (
                <div
                  data-testid="sidebar-course-layout-skeleton"
                  aria-hidden="true"
                  className="relative w-full"
                  style={{ height: sidebarCourseLayout.height }}
                >
                  <LayoutShapeLayer
                    shapes={sidebarCourseLayout.shapes}
                    ruleColor="sidebar-border"
                  />
                </div>
              ) : loadingCourseGroupCounts.length > 1 ? (
                COURSE_SKELETON_GROUP_KEYS.slice(0, loadingCourseGroupCounts.length).map(
                  (groupKey, groupIndex) => (
                    <SidebarGroup
                      key={groupKey}
                      data-testid="sidebar-course-skeleton-group"
                      aria-hidden="true"
                      className="px-2 pt-3 pb-1"
                    >
                      <SidebarGroupLabel className="text-sm font-semibold text-sidebar-foreground">
                        <Skeleton className="h-4 w-20" />
                      </SidebarGroupLabel>
                      <SidebarGroupContent>
                        <SidebarMenu className="ml-2 w-auto gap-0.5 border-l border-sidebar-border pl-2">
                          {renderCourseSkeletons(
                            loadingCourseGroupCounts[groupIndex] ?? 1,
                            groupKey,
                          )}
                        </SidebarMenu>
                      </SidebarGroupContent>
                    </SidebarGroup>
                  ),
                )
              ) : (
                <SidebarGroup
                  data-testid="sidebar-course-skeleton-group"
                  aria-hidden="true"
                  className="px-2 py-1"
                >
                  <SidebarGroupLabel>
                    <Skeleton className="h-4 w-20" />
                  </SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu className="gap-1">
                      {renderCourseSkeletons(loadingCourseGroupCounts[0] ?? 1, 'group-1')}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              )
            ) : activeCourses.length > 0 ? (
              activeCourseGroups.length > 1 ? (
                activeCourseGroups.map((subject) => (
                  <SidebarGroup key={subject.id} className="px-2 pt-3 pb-1">
                    <SidebarGroupLabel className="text-sm font-semibold text-sidebar-foreground">
                      {subject.title}
                    </SidebarGroupLabel>
                    <SidebarGroupContent>
                      <SidebarMenu className="ml-2 w-auto gap-0.5 border-l border-sidebar-border pl-2">
                        {subject.courses.map(renderCourse)}
                      </SidebarMenu>
                    </SidebarGroupContent>
                  </SidebarGroup>
                ))
              ) : (
                <SidebarGroup className="px-2 py-1">
                  <SidebarGroupLabel>My courses</SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu className="gap-1">
                      {activeCourseGroups.flatMap((subject) => subject.courses.map(renderCourse))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              )
            ) : null}
          </div>
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
  const isPaperReader = pathname.startsWith('/papers/');
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
        <SidebarInset
          className={isPaperReader ? 'h-dvh min-h-0 min-w-0 overflow-hidden' : 'min-w-0'}
        >
          <MobileAppHeader />
          <div data-page-frame className={pageFrameClassName(pathname)}>
            <PageSkeleton />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

export function RootPending() {
  if (hostRole() !== 'site' && hasAppShellHint()) return <AppShellSkeleton />;
  return (
    <div data-page-frame className="flex min-h-dvh w-full flex-col items-center justify-center">
      <PageLoadingIndicator />
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
  const role = hostRole();
  const { data: me } = useQuery({ ...authQueryOptions(), enabled: role !== 'site' });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const normalizedPath = normalizePath(pathname);
  const isSignedOutPublicPath = isPublicPath(pathname) && me?.authRequired && !me.authenticated;
  if (
    role === 'site' ||
    normalizedPath === '/login' ||
    normalizedPath === PUBLIC_PATHS.howItWorks ||
    isSignedOutPublicPath
  ) {
    return (
      <>
        <Outlet />
        <AppToaster />
      </>
    );
  }
  return <ApplicationShell me={me} pathname={pathname} />;
}

function ApplicationShell({ me, pathname }: { me: AuthPayload | undefined; pathname: string }) {
  const contentRef = useCapturePageLayout();
  const { sidebarOpen, updateSidebarOpen } = useAppSidebarOpenState();
  const isPaperReader = pathname.startsWith('/papers/');
  return (
    <TooltipProvider>
      <SidebarProvider open={sidebarOpen} onOpenChange={updateSidebarOpen} disableKeyboardShortcut>
        <AppSidebar />
        <SidebarInset
          className={isPaperReader ? 'h-dvh min-h-0 min-w-0 overflow-hidden' : 'min-w-0'}
        >
          <MobileAppHeader />
          <TutorContextProvider
            routeAllowed={!pathname.startsWith('/placement')}
            pushSidebar={isPaperReader}
          >
            {me?.demo ? (
              <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground sm:px-6">
                Demo: your progress stays in this browser for {me.demo.ttlHours} hours, then it's
                deleted.{' '}
                <a
                  className="underline underline-offset-2"
                  href="https://github.com/Jonathanvwersch/open-academy/blob/main/docs/self-hosting.md"
                >
                  Run your own
                </a>
              </div>
            ) : null}
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
