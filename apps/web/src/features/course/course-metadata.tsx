import { Loader2 } from 'lucide-react';
import { lazy, Suspense } from 'react';

const FormattedMetadata = lazy(() =>
  import('../../components/markdown.js').then((module) => ({ default: module.Markdown })),
);
const markdownMarkers = [
  '\\',
  '`',
  '*',
  '_',
  '~',
  '$',
  '<',
  '&',
  '[',
  ']',
  '\n',
  'http://',
  'https://',
  'www.',
];

/** Most titles and author names are plain text; do not load the math engine for them. */
export function CourseMetadata({ children }: { children: string }) {
  const formatted =
    markdownMarkers.some((marker) => children.includes(marker)) ||
    /^\s*(?:#{1,6}\s|[-+>]\s|[-=]{3,}\s*$|\d+[.)]\s)/.test(children);
  if (!formatted) return <span>{children}</span>;
  return (
    <Suspense
      fallback={
        <span role="status" aria-label="Loading formatted text">
          <Loader2
            className="inline size-3 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        </span>
      }
    >
      <FormattedMetadata inline>{children}</FormattedMetadata>
    </Suspense>
  );
}
