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

export function LearnSkeleton() {
  return (
    <SkeletonShell>
      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-28" />
            </CardHeader>
            <CardContent>
              <SkeletonRows count={4} widths={['w-full', 'w-5/6', 'w-4/5', 'w-3/4', 'w-2/3']} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-28" />
            </CardHeader>
            <CardContent>
              <SkeletonRows count={3} widths={['w-full', 'w-5/6', 'w-4/5']} />
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-32" />
          </CardHeader>
          <CardContent className="space-y-6">
            <SkeletonRows count={3} widths={['w-full', 'w-5/6', 'w-4/5']} />
            <SkeletonRows count={2} widths={['w-full', 'w-3/4']} />
            <Skeleton className="h-32 w-full" />
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
                <Skeleton className="h-4 w-28" />
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
        {[0, 1].map((week) => (
          <Card key={week}>
            <CardHeader>
              <Skeleton className="h-5 w-48" />
            </CardHeader>
            <CardContent>
              <SkeletonRows count={2} widths={['w-5/6', 'w-2/3']} />
              <ol className="mt-4 divide-y">
                {[1, 2, 3, 4, 5].map((row) => (
                  <li key={row} className="flex items-center gap-3 py-3">
                    <Skeleton className="h-4 w-9 shrink-0" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-3 w-2/5 bg-muted/70" />
                    </div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        ))}
      </div>
    </SkeletonShell>
  );
}

export function LessonSkeletonBody() {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        {[0, 1, 2].map((item) => (
          <Skeleton key={item} className="h-6 w-20 rounded-full" />
        ))}
      </div>
      <Card>
        <CardContent>
          <Skeleton className="h-36 w-full" />
        </CardContent>
      </Card>
      <SkeletonRows count={4} widths={['w-full', 'w-11/12', 'w-4/5', 'w-2/3']} />
    </div>
  );
}

export function LessonSkeleton() {
  return (
    <SkeletonShell>
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-32" />
        </div>
        <LessonSkeletonBody />
      </div>
    </SkeletonShell>
  );
}

export function PaperSkeleton() {
  return (
    <SkeletonShell>
      <div className="flex h-[calc(100dvh-3.5rem)] min-h-0 flex-col">
        <Skeleton className="h-12 shrink-0 rounded-none border-b" />
        <div className="flex min-h-0 flex-1 gap-4 pt-4">
          <div className="flex min-w-0 flex-1 items-start justify-center">
            <Skeleton className="aspect-[1/1.414] w-full max-w-3xl" />
          </div>
          <aside className="hidden w-[380px] shrink-0 space-y-4 md:block">
            <Skeleton className="h-5 w-2/3" />
            <SkeletonRows count={5} widths={['w-full', 'w-5/6', 'w-4/5', 'w-11/12', 'w-3/4']} />
            <Skeleton className="h-5 w-1/2" />
            <SkeletonRows count={4} widths={['w-full', 'w-5/6', 'w-3/4', 'w-2/3']} />
          </aside>
        </div>
      </div>
    </SkeletonShell>
  );
}

export function PageSkeleton() {
  return (
    <SkeletonShell>
      <div className="space-y-5">
        <Card className="gap-0">
          <Skeleton className="h-32 w-full" />
        </Card>
        <Card className="gap-0">
          <Skeleton className="h-56 w-full" />
        </Card>
      </div>
    </SkeletonShell>
  );
}
