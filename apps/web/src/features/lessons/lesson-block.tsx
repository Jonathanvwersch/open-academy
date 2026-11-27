import type { LessonBlockKind, LessonPrerequisite } from '@open-academy/engine/api/lessons';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { LessonMarkdown as Markdown } from './lesson-markdown.js';

const lessonBlockLabels: Partial<Record<LessonBlockKind, string>> = {
  example: 'Example',
  math: 'Key formula',
  worked: 'Worked example',
  tldr: 'In short',
  check: 'Check yourself',
  faded: 'Fill in the steps',
  summary: 'Key takeaways',
};

export function LessonBlock({
  kind,
  md,
  children,
  prerequisites,
}: {
  kind: LessonBlockKind;
  md?: string;
  children?: ReactNode;
  prerequisites?: LessonPrerequisite[];
}) {
  const content = md;
  if (kind === 'fits') {
    const hasCompleteRecap = Boolean(
      prerequisites?.length && prerequisites.every(({ recap }) => recap !== undefined),
    );
    return (
      <>
        {hasCompleteRecap ? (
          <Card className="gap-2">
            <CardHeader className="gap-0">
              <CardTitle className="text-sm font-medium" role="heading" aria-level={2}>
                Recap
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="list-disc space-y-2 pl-5">
                {prerequisites?.map((prerequisite) => (
                  <li key={prerequisite.id}>
                    <Link
                      className="cursor-pointer underline"
                      to="/lessons/$conceptId"
                      params={{ conceptId: prerequisite.id }}
                      search={{ from: undefined, step: undefined }}
                    >
                      {prerequisite.title}
                    </Link>
                    {': '}
                    <Markdown inline>{prerequisite.recap ?? ''}</Markdown>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}
        <div className="py-1">
          {!hasCompleteRecap && prerequisites?.length ? (
            <p className="text-sm text-muted-foreground">
              Before this:{' '}
              {prerequisites.map((prerequisite, index) => (
                <React.Fragment key={prerequisite.id}>
                  {index > 0 ? ', ' : null}
                  <Link
                    className="cursor-pointer underline"
                    to="/lessons/$conceptId"
                    params={{ conceptId: prerequisite.id }}
                    search={{ from: undefined, step: undefined }}
                  >
                    {prerequisite.title}
                  </Link>
                </React.Fragment>
              ))}
            </p>
          ) : null}
          {content ? <Markdown>{content}</Markdown> : null}
          {children}
        </div>
      </>
    );
  }
  if (kind === 'intuition') {
    return (
      <div className="py-1">
        {content ? <Markdown>{content}</Markdown> : null}
        {children}
      </div>
    );
  }
  if (kind === 'tldr') {
    return (
      <Card className="gap-1 border-muted-foreground/15 bg-muted/20">
        <CardHeader className="gap-0 px-4 pb-0 pt-3">
          <CardTitle className="text-xs font-medium text-muted-foreground">
            {lessonBlockLabels[kind]}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-3 pt-2 text-sm">
          {content ? <Markdown>{content}</Markdown> : null}
          {children}
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className={kind === 'worked' ? 'gap-2 bg-muted/50' : 'gap-2'}>
      <CardHeader className="gap-0">
        <CardTitle className="text-sm font-medium">{lessonBlockLabels[kind]}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {content ? <Markdown>{content}</Markdown> : null}
        {children}
      </CardContent>
    </Card>
  );
}
