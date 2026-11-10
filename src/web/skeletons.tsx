import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader } from '@/ui/card.js';
import { Skeleton } from '@/ui/skeleton.js';

function SkeletonShell({ children }: { children: ReactNode }) {
  return (
    <div aria-hidden="true" data-testid="route-skeleton" className="w-full">
      {children}
    </div>
  );
}

function SkeletonRows({ count, widths }: { count: number; widths: string[] }) {
  return (
    <div className="space-y-3">
      {widths.slice(0, count).map((width) => (
        <Skeleton key={width} className={`h-4 ${width}`} />
      ))}
    </div>
  );
}

function LessonBlockSkeleton({
  titleWidth,
  widths,
  muted = false,
  beforeThis = false,
}: {
  titleWidth: string;
  widths: string[];
  muted?: boolean;
  beforeThis?: boolean;
}) {
  return (
    <Card className={muted ? 'gap-2 bg-muted/50' : 'gap-2'}>
      <CardHeader className="gap-0">
        <Skeleton className={`h-4 ${titleWidth}`} />
      </CardHeader>
      <CardContent className="space-y-2">
        {beforeThis ? <Skeleton className="h-4 w-40" /> : null}
        <SkeletonRows count={widths.length} widths={widths} />
      </CardContent>
    </Card>
  );
}

export function LearnSkeleton() {
  return (
    <SkeletonShell>
      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-20" />
            </CardHeader>
            <CardContent className="space-y-5">
              <Skeleton className="h-8 w-full rounded-md" />
              <ul className="divide-y">
                <li className="space-y-2 py-4 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-2">
                      <Skeleton className="h-5 w-16 rounded-full" />
                      <Skeleton className="h-4 w-40" />
                    </div>
                    <Skeleton className="h-4 w-12" />
                  </div>
                  <Skeleton className="h-4 w-3/4" />
                </li>
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-4 w-40" />
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-32" />
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-4">
                <Skeleton className="h-4 w-14" />
                <Skeleton className="h-4 w-32" />
              </div>
              <Skeleton className="h-2 w-full" />
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-20" />
              </div>
              <Skeleton className="h-4 w-40" />
            </div>
            <div className="space-y-3 border-t pt-5">
              <div className="flex items-center justify-between">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-14" />
                  <Skeleton className="h-6 w-24" />
                </div>
                <div className="space-y-2">
                  <Skeleton className="ml-auto h-4 w-14" />
                  <Skeleton className="ml-auto h-6 w-8" />
                </div>
              </div>
              <Skeleton className="h-2 w-full" />
            </div>
            <div className="space-y-3 border-t pt-5">
              <div className="flex items-baseline justify-between">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 w-12" />
              </div>
              <div className="grid h-32 grid-cols-7 items-end gap-2">
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => (
                  <div key={day} className="flex h-full min-w-0 flex-col justify-end gap-1">
                    <Skeleton className="h-24 w-full rounded-sm" />
                    <Skeleton className="mx-auto h-3 w-6" />
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </SkeletonShell>
  );
}

export function ProgressSkeleton() {
  return (
    <SkeletonShell>
      <div className="space-y-6">
        <Card>
          <CardHeader className="gap-0">
            <div className="grid grid-cols-3 divide-x">
              {[0, 1, 2].map((stat) => (
                <div key={stat} className="space-y-2 px-3 first:pl-0 last:pr-0">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-7 w-20" />
                  {stat === 0 ? <Skeleton className="h-1.5 w-full" /> : null}
                  {stat > 0 ? <Skeleton className="h-4 w-12" /> : null}
                </div>
              ))}
            </div>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
          </CardHeader>
          <CardContent className="space-y-5">
            {[0, 1, 2].map((domain) => (
              <div key={domain} className="space-y-2">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-2 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </SkeletonShell>
  );
}

export function CourseSkeleton() {
  return (
    <SkeletonShell>
      <div className="space-y-4">
        <Card>
          <CardHeader className="space-y-2">
            <Skeleton className="h-5 w-48" />
            <SkeletonRows count={2} widths={['w-full', 'w-11/12']} />
          </CardHeader>
          <CardContent className="p-0 last:pb-0">
            <ol className="divide-y">
              {[
                'topic-1',
                'topic-2',
                'topic-3',
                'topic-4',
                'topic-5',
                'topic-6',
                'topic-7',
                'topic-8',
                'topic-9',
              ].map((topic, index) => (
                <li key={topic} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <Skeleton className="mt-0.5 h-4 w-9 shrink-0" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <Skeleton
                        className={`h-4 ${index % 3 === 1 ? 'w-4/5' : index % 3 === 2 ? 'w-2/3' : 'w-full'}`}
                      />
                      <Skeleton className={`h-3 ${index % 2 ? 'w-3/4' : 'w-2/5'}`} />
                      {index % 3 === 1 ? <Skeleton className="h-4 w-24 rounded-full" /> : null}
                    </div>
                    <Skeleton className="h-4 w-4 shrink-0" />
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
    </SkeletonShell>
  );
}

export function LessonSkeletonBody() {
  return (
    <SkeletonShell>
      <div className="space-y-5">
        <div className="flex flex-wrap gap-2">
          {[0, 1, 2, 3].map((step) => (
            <Skeleton key={step} className="h-5 w-20 rounded-full" />
          ))}
        </div>
        <div className="space-y-4">
          <LessonBlockSkeleton
            titleWidth="w-36"
            widths={['w-full', 'w-11/12', 'w-4/5']}
            beforeThis
          />
          <div className="space-y-3">
            <SkeletonRows count={3} widths={['w-full', 'w-11/12', 'w-4/5']} />
            <Skeleton className="mx-auto h-5 w-2/3" />
            <SkeletonRows count={2} widths={['w-full', 'w-5/6']} />
          </div>
          <LessonBlockSkeleton titleWidth="w-32" widths={['w-full', 'w-5/6', 'w-3/4']} muted />
        </div>
      </div>
    </SkeletonShell>
  );
}

export function LessonReviewSkeleton() {
  return (
    <SkeletonShell>
      <div className="space-y-6">
        <Skeleton className="h-9 w-56" />
        <div className="space-y-5">
          <LessonBlockSkeleton titleWidth="w-10" widths={['w-full']} />
          <LessonBlockSkeleton
            titleWidth="w-36"
            widths={['w-full', 'w-11/12', 'w-4/5']}
            beforeThis
          />
          <article className="space-y-4">
            <Skeleton className="h-6 w-3/4" />
            <SkeletonRows count={4} widths={['w-full', 'w-11/12', 'w-5/6', 'w-2/3']} />
            <LessonBlockSkeleton titleWidth="w-32" widths={['w-full', 'w-5/6', 'w-3/4']} muted />
          </article>
        </div>
      </div>
    </SkeletonShell>
  );
}

export function SessionSkeleton() {
  return (
    <SkeletonShell>
      <div className="space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <Skeleton className="h-9 w-64" />
            <Skeleton className="h-4 w-48" />
          </div>
          <Skeleton className="h-8 w-24 rounded-md" />
        </header>
        <Card>
          <CardContent className="space-y-5">
            <SkeletonRows count={2} widths={['w-full', 'w-3/4']} />
            <Skeleton className="h-9 w-full rounded-md border bg-muted/50" />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Skeleton className="h-9 w-48 rounded-md" />
              <div className="flex items-center gap-2">
                <Skeleton className="h-8 w-12 rounded-md" />
                <Skeleton className="h-8 w-24 rounded-md" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </SkeletonShell>
  );
}

function DiagnosticQuestionCardSkeleton() {
  return (
    <Card>
      <CardContent className="space-y-5">
        <Skeleton className="h-3 w-36" />
        <Skeleton className="h-5 w-32 rounded-full" />
        <SkeletonRows count={2} widths={['w-full', 'w-5/6']} />
        <div className="space-y-2">
          {[0, 1, 2, 3].map((option) => (
            <div key={option} className="flex h-12 items-center gap-3 rounded-md border px-3">
              <Skeleton className="size-4 rounded-full" />
              <Skeleton className={`h-4 ${option % 2 ? 'w-2/3' : 'w-3/4'}`} />
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Skeleton className="h-9 w-48 rounded-md" />
          <Skeleton className="h-4 w-44" />
        </div>
      </CardContent>
    </Card>
  );
}

export function DiagnosticQuestionSkeleton() {
  return (
    <SkeletonShell>
      <DiagnosticQuestionCardSkeleton />
    </SkeletonShell>
  );
}

export function DiagnosticSkeleton() {
  return (
    <SkeletonShell>
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-9 w-80" />
          <Skeleton className="h-4 w-72" />
        </div>
        <DiagnosticQuestionCardSkeleton />
      </div>
    </SkeletonShell>
  );
}

export function DiagnosticResultsSkeleton() {
  return (
    <SkeletonShell>
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-9 w-64" />
        </div>
        <Card>
          <CardContent className="space-y-5">
            <Skeleton className="h-4 w-full" />
            {[0, 1, 2, 3, 4].map((domain) => (
              <article key={domain} className="space-y-2 border-t pt-4">
                <div className="flex justify-between gap-4">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-4 w-32" />
                </div>
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-4 w-2/3" />
              </article>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-24" />
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-4 w-5/6" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-4 w-2/3" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-4 w-28" />
              <SkeletonRows count={3} widths={['w-4/5', 'w-2/3', 'w-3/4']} />
            </div>
          </CardContent>
        </Card>
        <Skeleton className="h-9 w-28 rounded-md" />
      </div>
    </SkeletonShell>
  );
}

export function SettingsSkeleton() {
  return (
    <SkeletonShell>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-32" />
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              {[0, 1, 2].map((field) => (
                <div key={field} className="grid gap-2">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-8 w-full rounded-md border bg-muted/50" />
                  <Skeleton className="h-3 w-32" />
                </div>
              ))}
            </div>
            <div className="grid gap-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-8 w-48 rounded-md border bg-muted/50" />
            </div>
            <Skeleton className="h-8 w-24 rounded-md" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-20" />
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Skeleton className="h-8 w-16 rounded-md" />
            <Skeleton className="h-8 w-40 rounded-md" />
          </CardContent>
        </Card>
      </div>
    </SkeletonShell>
  );
}

export function ProjectSkeleton() {
  return (
    <SkeletonShell>
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-9 w-3/4" />
          <SkeletonRows count={2} widths={['w-full', 'w-5/6']} />
        </div>
        <Card>
          <CardContent className="space-y-4">
            <SkeletonRows count={4} widths={['w-full', 'w-11/12', 'w-5/6', 'w-4/5']} />
            <Skeleton className="h-6 w-28" />
            {[0, 1, 2].map((task) => (
              <div key={task} className="space-y-2 pl-5">
                <Skeleton className="h-4 w-2/3" />
                <SkeletonRows count={2} widths={['w-full', 'w-5/6']} />
              </div>
            ))}
            <Skeleton className="h-6 w-36" />
            <SkeletonRows count={3} widths={['w-4/5', 'w-full', 'w-2/3']} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-32" />
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-9 w-full rounded-md border bg-muted/50" />
            </div>
            <Skeleton className="h-9 w-32 rounded-md" />
          </CardContent>
        </Card>
      </div>
    </SkeletonShell>
  );
}

export function PaperSkeleton() {
  return (
    <SkeletonShell>
      <div className="flex h-[calc(100dvh-3.5rem)] min-h-0 flex-col md:h-[calc(100dvh-4.5rem)]">
        <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b bg-background px-4 py-1 sm:h-12 sm:flex-nowrap">
          <Skeleton className="h-8 w-16 rounded-md" />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="hidden h-4 w-48 lg:block" />
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Skeleton className="size-8 rounded-md" />
            <Skeleton className="h-4 w-9" />
            <Skeleton className="size-8 rounded-md" />
            <Skeleton className="h-8 w-14 rounded-md" />
            <Skeleton className="h-8 w-12 rounded-md" />
          </div>
        </header>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden px-4 pb-4 md:flex-row">
          <div className="flex min-h-0 min-w-0 flex-1 justify-center overflow-auto px-4">
            <Skeleton className="aspect-[1/1.414] w-full max-w-3xl" />
          </div>
          <aside className="hidden w-[380px] shrink-0 space-y-5 border-l pl-4 md:block">
            <div className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <SkeletonRows count={2} widths={['w-full', 'w-4/5']} />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <SkeletonRows count={2} widths={['w-full', 'w-3/4']} />
            </div>
            {[0, 1, 2, 3].map((field) => (
              <div key={field} className="space-y-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-16 w-full rounded-md border bg-muted/50" />
              </div>
            ))}
          </aside>
        </div>
      </div>
    </SkeletonShell>
  );
}

export function PageSkeleton() {
  return (
    <SkeletonShell>
      <div className="space-y-6">
        <header className="flex items-start justify-between gap-3">
          <div className="space-y-2">
            <Skeleton className="h-9 w-56" />
            <Skeleton className="h-4 w-48" />
          </div>
          <Skeleton className="h-8 w-24 rounded-md" />
        </header>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-36" />
          </CardHeader>
          <CardContent className="space-y-4">
            <SkeletonRows count={4} widths={['w-full', 'w-11/12', 'w-4/5', 'w-2/3']} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-28" />
          </CardHeader>
          <CardContent className="space-y-3">
            <SkeletonRows count={3} widths={['w-full', 'w-5/6', 'w-3/4']} />
          </CardContent>
        </Card>
      </div>
    </SkeletonShell>
  );
}
