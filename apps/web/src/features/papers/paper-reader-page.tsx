import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Minus, Plus } from 'lucide-react';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { getRouteApi } from '@tanstack/react-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../../api/authenticated-fetch.js';
import { Markdown } from '../../components/markdown.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { FeedbackPanel } from '../exercises/feedback-panel.js';
import { useTutorSidebar } from '../tutor/tutor-sidebar.js';
import { paperQueryOptions } from './queries.js';

const Route = getRouteApi('/papers/$paperId');
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type PaperSummaryJudgement = {
  feedback_md?: string;
  criteria?: Array<{
    id: string;
    judgement: 'met' | 'partial' | 'missing';
    evidence: string | null;
  }>;
};

type PaperSummaryRubric = {
  id: string;
  criterion: string;
  weight: number;
  required: boolean;
};

function paperFeedbackResult(
  judgement: PaperSummaryJudgement,
  rubric: PaperSummaryRubric[],
): Record<string, unknown> {
  const decisions = new Map(judgement.criteria?.map((criterion) => [criterion.id, criterion]));
  const requiredMissing = rubric.some(
    (criterion) => criterion.required && decisions.get(criterion.id)?.judgement === 'missing',
  );
  const totalWeight = rubric.reduce((total, criterion) => total + criterion.weight, 0);
  const earnedWeight = rubric.reduce((total, criterion) => {
    const decision = decisions.get(criterion.id)?.judgement;
    return total + criterion.weight * (decision === 'met' ? 1 : decision === 'partial' ? 0.5 : 0);
  }, 0);
  return {
    status: 'graded',
    correct: requiredMissing || totalWeight === 0 ? 0 : earnedWeight / totalWeight,
    graded_by: 'llm',
    feedback: judgement.feedback_md ?? '',
    rubric: rubric.map((criterion) => ({
      id: criterion.id,
      criterion: criterion.criterion,
      judgement: decisions.get(criterion.id)?.judgement ?? 'missing',
    })),
  };
}

function LazyPage({
  pageNumber,
  width,
  aspectRatio,
}: {
  pageNumber: number;
  width: number;
  aspectRatio: number;
}) {
  const [visible, setVisible] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisible(true);
        }
      },
      { rootMargin: '500px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={host}
      className="relative mx-auto mb-5 overflow-hidden shadow-md"
      style={{ width, height: width * aspectRatio }}
    >
      {visible ? (
        <Page
          pageNumber={pageNumber}
          width={width}
          renderTextLayer
          renderAnnotationLayer
          loading={null}
          suspense={false}
        />
      ) : null}
    </div>
  );
}

export function PaperReaderPage() {
  const { paperId } = Route.useParams();
  const { from, activity } = Route.useSearch();
  const { data } = useSuspenseQuery(paperQueryOptions(paperId));
  const queryClient = useQueryClient();
  const tutor = useTutorSidebar();
  const [pageCount, setPageCount] = useState(0);
  const [pageAspectRatios, setPageAspectRatios] = useState<Record<number, number>>({});
  const [pageWidth, setPageWidth] = useState(0);
  const [pageNumber, setPageNumber] = useState(data.progress?.lastPage ?? 1);
  const [zoom, setZoom] = useState(100);
  const [guideOpen, setGuideOpen] = useState(() => window.matchMedia('(min-width: 768px)').matches);
  const [pdfError, setPdfError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [notes, setNotes] = useState<Record<string, string>>(data.progress?.notes ?? {});
  const [noteStatuses, setNoteStatuses] = useState<Record<string, 'saving' | 'saved'>>({});
  const [summary, setSummary] = useState(data.progress?.summary ?? '');
  const [judgement, setJudgement] = useState(
    data.progress?.summaryJudgement as PaperSummaryJudgement | null,
  );
  const [rubric, setRubric] = useState(data.paper.summary.rubric ?? []);
  const [gradingReason, setGradingReason] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(Boolean(data.progress?.summary));
  const [submitting, setSubmitting] = useState(false);
  const [selected, setSelected] = useState<{
    text: string;
    rect: { left: number; top: number; bottom: number; width: number };
  } | null>(null);
  const [askTutorPosition, setAskTutorPosition] = useState<{ left: number; top: number } | null>(
    null,
  );
  const notesRef = useRef(notes);
  const viewer = useRef<HTMLDivElement>(null);
  const askTutorButton = useRef<HTMLButtonElement>(null);
  const progressCreated = useRef(Boolean(data.progress));
  const initialPage = useRef(data.progress?.lastPage ?? 1);
  const initialScrollDone = useRef(false);
  const boundedPage = Math.max(1, Math.min(pageNumber, pageCount || Number.MAX_SAFE_INTEGER));

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  useLayoutEffect(() => {
    const element = viewer.current;
    if (!element) return;
    const updatePageWidth = () => {
      setPageWidth(Math.max(1, element.clientWidth - 32));
    };
    updatePageWidth();
    const resizeObserver = new ResizeObserver(updatePageWidth);
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, []);

  useLayoutEffect(() => {
    const button = askTutorButton.current;
    if (!selected || !button) return;
    const { width, height } = button.getBoundingClientRect();
    const aboveTop = selected.rect.top - height - 8;
    const top = aboveTop >= 8 ? aboveTop : selected.rect.bottom + 8;
    const maxTop = Math.max(8, window.innerHeight - height - 8);
    setAskTutorPosition({
      left: Math.max(
        8,
        Math.min(
          selected.rect.left + selected.rect.width / 2 - width / 2,
          window.innerWidth - width - 8,
        ),
      ),
      top: Math.min(top, maxTop),
    });
  }, [selected]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void apiFetch(`/api/papers/${encodeURIComponent(paperId)}/progress`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lastPage: boundedPage }),
      }).then((response) => {
        if (response.ok && !progressCreated.current) {
          progressCreated.current = true;
          void queryClient.invalidateQueries({ queryKey: ['papers'] });
        }
      });
    }, 1000);
    return () => window.clearTimeout(timeout);
  }, [boundedPage, paperId, queryClient]);

  useEffect(() => {
    const timers = data.paper.questions.map((question) => {
      const text = notes[question.id];
      if (text === undefined || text === (data.progress?.notes[question.id] ?? ''))
        return undefined;
      return window.setTimeout(() => {
        setNoteStatuses((current) => ({ ...current, [question.id]: 'saving' }));
        void apiFetch(`/api/papers/${encodeURIComponent(paperId)}/progress`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ notes: { [question.id]: text } }),
        })
          .then((response) => {
            setNoteStatuses((current) => {
              if (notesRef.current[question.id] !== text) return current;
              if (!response.ok) {
                const next = { ...current };
                delete next[question.id];
                return next;
              }
              return { ...current, [question.id]: 'saved' };
            });
            if (response.ok) {
              if (!progressCreated.current) {
                progressCreated.current = true;
                void queryClient.invalidateQueries({ queryKey: ['papers'] });
              }
              void queryClient.invalidateQueries({ queryKey: ['paper', paperId] });
            }
          })
          .catch(() => {
            setNoteStatuses((current) => {
              if (notesRef.current[question.id] !== text) return current;
              const next = { ...current };
              delete next[question.id];
              return next;
            });
          });
      }, 700);
    });
    return () => {
      for (const timer of timers) {
        if (timer) window.clearTimeout(timer);
      }
    };
  }, [data.paper.questions, data.progress?.notes, notes, paperId, queryClient]);

  useEffect(() => {
    tutor.setContext({
      page: 'paper',
      paperId,
      pageNumber: boundedPage,
      pageLabel: `${data.paper.title} · page ${boundedPage} of ${pageCount || '?'}`,
      allowed: true,
      enabled: true,
    });
    return () => tutor.clearContext();
  }, [boundedPage, data.paper.title, pageCount, paperId, tutor.setContext, tutor.clearContext]);

  useEffect(() => {
    if (tutor.isOpen) setGuideOpen(false);
  }, [tutor.isOpen]);

  const updatePageFromScroll = useCallback(() => {
    const element = viewer.current;
    if (!element) return;
    const top = element.getBoundingClientRect().top;
    const currentPage = Array.from(element.querySelectorAll<HTMLElement>('[data-page]')).find(
      (page) => page.getBoundingClientRect().bottom > top + 32,
    );
    const nextPage = Number(currentPage?.dataset.page);
    if (nextPage > 0) setPageNumber(nextPage);
  }, []);

  useEffect(() => {
    const element = viewer.current;
    if (!element) return;
    element.addEventListener('scroll', updatePageFromScroll, { passive: true });
    return () => element.removeEventListener('scroll', updatePageFromScroll);
  }, [updatePageFromScroll]);

  useEffect(() => {
    if (pageCount === 0 || initialScrollDone.current) return;
    initialScrollDone.current = true;
    window.requestAnimationFrame(() => {
      viewer.current
        ?.querySelector(`[data-page="${Math.max(1, Math.min(initialPage.current, pageCount))}"]`)
        ?.scrollIntoView({ block: 'start' });
    });
  }, [pageCount]);

  const onSelection = () => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? '';
    const node = selection?.anchorNode?.parentElement;
    if (!text || text.length > 2000 || !node?.closest('.react-pdf__Page__textContent')) {
      setSelected(null);
      return;
    }
    const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
    if (rect) {
      setSelected({
        text,
        rect: {
          left: rect.left,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
        },
      });
      setAskTutorPosition(null);
    }
  };

  const submitSummary = async () => {
    setSubmitting(true);
    try {
      const response = await apiFetch(`/api/papers/${encodeURIComponent(paperId)}/summary`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ summary, ...(activity ? { activityId: activity } : {}) }),
      });
      const result = (await response.json()) as {
        judgement: PaperSummaryJudgement | null;
        rubric?: PaperSummaryRubric[];
        reason?: string;
        error?: string;
      };
      if (!response.ok) {
        setGradingReason(result.error ?? 'Summary could not be saved.');
        return;
      }
      setJudgement(result.judgement);
      setRubric(result.rubric ?? []);
      setGradingReason(result.reason ?? null);
      setSubmitted(true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['paper', paperId] }),
        queryClient.invalidateQueries({ queryKey: ['papers'] }),
      ]);
    } finally {
      setSubmitting(false);
    }
  };

  const original = data.originalUrl;
  const file = `/api/papers/${encodeURIComponent(paperId)}/pdf?retry=${retry}`;
  const pageSlots = useMemo(
    () => Array.from({ length: pageCount }, (_, index) => index + 1),
    [pageCount],
  );

  return (
    <section className="flex h-[calc(100dvh-3.5rem)] min-h-0 w-full min-w-0 flex-col md:h-[calc(100dvh-4.5rem)]">
      <header className="sticky top-0 z-20 flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b bg-background px-4 py-1 sm:h-12 sm:flex-nowrap">
        {from ? (
          <Button asChild variant="ghost" size="sm">
            <Link
              aria-label="Back to session"
              to="/session/$id"
              params={{ id: from }}
              search={activity ? { activity } : {}}
            >
              <ArrowLeft aria-hidden="true" className="size-4" />
              Session
            </Link>
          </Button>
        ) : (
          <Button asChild variant="ghost" size="sm">
            <Link aria-label="Back to Course" to="/course">
              <ArrowLeft aria-hidden="true" className="size-4" />
              Course
            </Link>
          </Button>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h1 className="min-w-0 truncate text-sm font-semibold">
            <Markdown inline>{data.paper.title}</Markdown>
          </h1>
          <p className="hidden shrink-0 text-sm text-muted-foreground lg:inline">
            <Markdown inline>{data.paper.authors}</Markdown> · {data.paper.year} · ~
            {data.paper.est_minutes} min
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom out"
            onClick={() => setZoom((value) => Math.max(50, value - 10))}
          >
            <Minus aria-hidden="true" className="size-4" />
          </Button>
          <span className="w-9 text-center text-xs tabular-nums">{zoom}%</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom in"
            onClick={() => setZoom((value) => Math.min(200, value + 10))}
          >
            <Plus aria-hidden="true" className="size-4" />
          </Button>
          <label htmlFor="paper-page" className="flex shrink-0 items-center gap-1 text-sm">
            <span className="sr-only">Page</span>
            <Input
              id="paper-page"
              aria-label="Go to page"
              className="h-8 w-14 px-1 text-center"
              type="number"
              min={1}
              max={pageCount || undefined}
              value={boundedPage}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (!Number.isInteger(next) || next < 1) return;
                const targetPage = pageCount > 0 ? Math.min(next, pageCount) : next;
                setPageNumber(targetPage);
                viewer.current
                  ?.querySelector(`[data-page="${targetPage}"]`)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            />
            of {pageCount || '…'}
          </label>
          <Button
            variant={guideOpen ? 'secondary' : 'outline'}
            size="sm"
            aria-expanded={guideOpen}
            aria-controls="paper-guide"
            onClick={() => setGuideOpen((open) => !open)}
          >
            Guide
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden px-4 pb-4 md:flex-row">
        <section
          ref={viewer}
          onMouseUp={onSelection}
          aria-label="PDF reader"
          className={`min-h-0 min-w-0 flex-1 overflow-auto px-4 ${
            guideOpen ? 'hidden md:block' : 'w-full'
          }`}
        >
          {pdfError ? (
            <div className="rounded-md border p-5">
              <p>The PDF could not be opened.</p>
              <Button
                variant="outline"
                onClick={() => {
                  setPdfError(false);
                  setPageCount(0);
                  setPageAspectRatios({});
                  setRetry((value) => value + 1);
                }}
              >
                Retry
              </Button>
              <a
                className="ml-3 cursor-pointer underline"
                href={original}
                target="_blank"
                rel="noreferrer"
              >
                Open original
              </a>
            </div>
          ) : (
            <Document
              key={retry}
              file={file}
              suspense={false}
              onLoadSuccess={async (document) => {
                const aspects = await Promise.all(
                  Array.from({ length: document.numPages }, async (_, index) => {
                    const page = await document.getPage(index + 1);
                    const viewport = page.getViewport({ scale: 1 });
                    return [index + 1, viewport.height / viewport.width] as const;
                  }),
                );
                setPageAspectRatios(Object.fromEntries(aspects));
                setPageCount(document.numPages);
              }}
              onLoadError={() => setPdfError(true)}
              loading={<div className="aspect-[1/1.414] rounded bg-muted" />}
            >
              {pageSlots.map((page) => (
                <div key={page} data-page={page}>
                  <LazyPage
                    pageNumber={page}
                    width={(pageWidth * zoom) / 100}
                    aspectRatio={pageAspectRatios[page] ?? Math.SQRT2}
                  />
                </div>
              ))}
            </Document>
          )}
        </section>
        {guideOpen ? (
          <aside
            id="paper-guide"
            className="min-h-0 w-full shrink-0 space-y-6 overflow-y-auto pt-4 pb-6 pr-1 md:w-[380px] md:border-l md:pl-4"
          >
            <section>
              <h2 className="text-sm font-semibold">Why this paper</h2>
              <Markdown className="text-sm leading-6">{data.paper.why_this_week}</Markdown>
            </section>
            <section>
              <h2 className="text-sm font-semibold">How to read it</h2>
              <Markdown className="text-sm leading-6">{data.paper.how_to_read}</Markdown>
            </section>
            {data.paper.questions.map((question) => (
              <section key={question.id} className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">
                  {question.kind[0]?.toUpperCase()}
                  {question.kind.slice(1)}
                </p>
                <h3 className="text-sm font-medium leading-6">
                  <Markdown inline>{question.prompt}</Markdown>
                </h3>
                <Textarea
                  aria-label={`${question.kind} note`}
                  value={notes[question.id] ?? ''}
                  maxLength={4000}
                  onChange={(event) => {
                    const value = event.target.value;
                    notesRef.current = { ...notesRef.current, [question.id]: value };
                    setNotes((current) => ({ ...current, [question.id]: value }));
                    setNoteStatuses((current) => {
                      const next = { ...current };
                      const saved = data.progress?.notes[question.id];
                      if (value === (saved ?? '')) {
                        if (saved === undefined) delete next[question.id];
                        else next[question.id] = 'saved';
                        return next;
                      }
                      return { ...current, [question.id]: 'saving' };
                    });
                  }}
                />
                {noteStatuses[question.id] ? (
                  <span className="text-xs text-muted-foreground">
                    {noteStatuses[question.id] === 'saving' ? 'Saving…' : 'Saved'}
                  </span>
                ) : null}
              </section>
            ))}
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Summary</h2>
              <Markdown className="text-sm leading-6">{data.paper.summary.prompt}</Markdown>
              <Textarea
                aria-label="Paper summary"
                value={summary}
                maxLength={4000}
                onChange={(event) => setSummary(event.target.value)}
              />
              <Button
                disabled={!summary.trim()}
                loading={submitting}
                onClick={() => void submitSummary()}
              >
                Submit summary
              </Button>
              {judgement ? <FeedbackPanel result={paperFeedbackResult(judgement, rubric)} /> : null}
              {gradingReason ? (
                <p className="text-sm text-muted-foreground">{gradingReason}</p>
              ) : null}
              {submitted ? <p role="status">Summary saved.</p> : null}
            </section>
          </aside>
        ) : null}
      </div>
      {selected ? (
        <Button
          ref={askTutorButton}
          className="fixed z-50"
          style={askTutorPosition ? askTutorPosition : { left: 8, top: 8, visibility: 'hidden' }}
          onClick={() => {
            setGuideOpen(false);
            tutor.openConversation({
              page: 'paper',
              paperId,
              pageNumber: boundedPage,
              selection: selected.text,
              pageLabel: `${data.paper.title} · page ${boundedPage} of ${pageCount || '?'} · selected passage`,
              allowed: true,
              enabled: true,
            });
            setSelected(null);
            setAskTutorPosition(null);
          }}
        >
          Ask tutor
        </Button>
      ) : null}
    </section>
  );
}
