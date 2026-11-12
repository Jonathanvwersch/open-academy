import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Eye, Plus, Sparkles, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { StickToBottomContext } from 'use-stick-to-bottom';
import { useIsMobile } from '@/hooks/use-mobile.js';
import {
  repairTutorMarkdown,
  TUTOR_QUESTION_MAX_LENGTH,
  tutorQuestionTooLongMessage,
} from '../../shared/tutor.js';
import { apiFetch } from '../authenticated-fetch.js';
import { Markdown } from '../components.js';
import {
  type TutorThreadDetail,
  type TutorThreadSummary,
  tutorThreadQueryOptions,
  tutorThreadsQueryOptions,
} from '../queries.js';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '../ui/ai/conversation.js';
import { Loader } from '../ui/ai/loader.js';
import { Message, MessageContent } from '../ui/ai/message.js';
import { PromptInput, PromptInputSubmit, PromptInputTextarea } from '../ui/ai/prompt-input.js';
import { Alert, AlertDescription } from '../ui/alert.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Separator } from '../ui/separator.js';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
} from '../ui/sidebar.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js';

export interface TutorRequestContext {
  conceptId?: string;
  conceptTitle?: string;
  activityId?: string;
  exerciseId?: string;
  questionLabel?: string;
  lessonProblemId?: string;
  page?: 'session' | 'lesson' | 'course' | 'map' | 'paper';
  knowledgePointId?: string;
  paperId?: string;
  pageNumber?: number;
  selection?: string;
  pageLabel?: string;
  allowed: boolean;
  enabled: boolean;
}

type TutorMessage = TutorThreadDetail['messages'][number];

interface TutorContextValue {
  setContext: (context: TutorRequestContext) => void;
  clearContext: () => void;
  open: (context?: Partial<TutorRequestContext>) => void;
  openConversation: (context?: Partial<TutorRequestContext>) => void;
  startChat: (context: Partial<TutorRequestContext>, greeting: string) => void;
  isOpen: boolean;
}

const TutorContext = createContext<TutorContextValue | null>(null);
const OPEN_KEY = 'academy.tutor.open';
const THREAD_KEY = 'academy.tutor.thread';
const WIDTH_KEY = 'academy.tutor.width';
const DEFAULT_SIDEBAR_WIDTH = 448;
const MIN_SIDEBAR_WIDTH = 320;
const MAX_SIDEBAR_WIDTH = 768;

function maxSidebarWidth(viewportWidth = window.innerWidth) {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, viewportWidth - 480));
}

function clampSidebarWidth(width: number, viewportWidth = window.innerWidth) {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxSidebarWidth(viewportWidth), width));
}

function initialSidebarWidth() {
  const storedWidth = localStorage.getItem(WIDTH_KEY);
  if (storedWidth === null || !storedWidth.trim()) {
    return clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
  }
  const width = Number(storedWidth);
  return clampSidebarWidth(Number.isFinite(width) ? width : DEFAULT_SIDEBAR_WIDTH);
}

interface TutorSendVariables {
  question: string;
  threadId: string;
  context: TutorRequestContext;
  optimisticId: string;
}

interface TutorSendResponse {
  thread?: {
    id: string;
    conceptId: string | null;
    title: string;
    updatedAt: string;
  };
  messages?: TutorMessage[];
  error?: string;
}

interface PendingTutorMessage {
  id: string;
  threadId: string;
  role: 'user';
  content: string;
  createdAt: string;
}

function localDayOrdinal(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

function groupThreads(threads: TutorThreadSummary[]) {
  const groups = new Map<string, TutorThreadSummary[]>([
    ['Today', []],
    ['Yesterday', []],
    ['Previous 7 days', []],
    ['Older', []],
  ]);
  const todayOrdinal = localDayOrdinal(new Date());
  const sorted = [...threads].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  for (const thread of sorted) {
    const daysAgo = todayOrdinal - localDayOrdinal(new Date(thread.updatedAt));
    const group =
      daysAgo <= 0
        ? 'Today'
        : daysAgo === 1
          ? 'Yesterday'
          : daysAgo <= 8
            ? 'Previous 7 days'
            : 'Older';
    groups.get(group)?.push(thread);
  }
  return [...groups].filter(([, groupThreads]) => groupThreads.length > 0);
}

function relativeThreadTime(value: string): string {
  const date = new Date(value);
  const elapsedMinutes = Math.floor(Math.max(0, Date.now() - date.getTime()) / 60_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (elapsedMinutes < 1) return 'now';
  if (elapsedMinutes < 60) return formatter.format(-elapsedMinutes, 'minute');
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return formatter.format(-elapsedHours, 'hour');
  const daysAgo = localDayOrdinal(new Date()) - localDayOrdinal(date);
  return formatter.format(-Math.max(1, daysAgo), 'day');
}

async function getJson<T>(url: string): Promise<T> {
  const response = await apiFetch(url);
  if (!response.ok) throw new Error('Tutor conversations could not be loaded.');
  return (await response.json()) as T;
}

function ContextLine({ pageLabel }: { pageLabel?: string }) {
  return pageLabel ? (
    <div
      data-testid="tutor-reading-context"
      title={`Context: ${pageLabel}`}
      className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
    >
      <Eye aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">Context: {pageLabel}</span>
    </div>
  ) : null;
}

export function TutorContextProvider({
  children,
  routeAllowed = true,
  pushSidebar = false,
}: {
  children: React.ReactNode;
  routeAllowed?: boolean;
  pushSidebar?: boolean;
}) {
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const shouldPushSidebar = pushSidebar && !isMobile;
  const [context, setContext] = useState<TutorRequestContext>({
    allowed: true,
    enabled: false,
  });
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) === 'true');
  const [selectedId, setSelectedId] = useState(() => localStorage.getItem(THREAD_KEY) || '');
  const [view, setView] = useState<'list' | 'conversation'>(() =>
    localStorage.getItem(THREAD_KEY) ? 'conversation' : 'list',
  );
  const [newChatSelected, setNewChatSelected] = useState(false);
  const [greeting, setGreeting] = useState<{ text: string; threadId: string | null } | null>(null);
  const [selectionChecked, setSelectionChecked] = useState(false);
  const [focusComposerOnOpen, setFocusComposerOnOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [pendingSend, setPendingSend] = useState<PendingTutorMessage | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStart = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const conversationContextRef = useRef<StickToBottomContext | null>(null);
  const sidebarWidthMax = maxSidebarWidth(viewportWidth);
  const tutorFlag = useQuery({
    queryKey: ['tutor', 'enabled'],
    queryFn: () => getJson<{ tutorEnabled: boolean }>('/api/today'),
  });
  const enabled = context.enabled || tutorFlag.data?.tutorEnabled === true;
  const threads = useQuery({
    ...tutorThreadsQueryOptions(),
    enabled: open && enabled && context.allowed && routeAllowed,
  });
  const detail = useQuery({
    ...tutorThreadQueryOptions(selectedId),
    enabled:
      open && view === 'conversation' && !!selectedId && enabled && context.allowed && routeAllowed,
  });
  useEffect(() => {
    localStorage.setItem(OPEN_KEY, String(open));
  }, [open]);
  useEffect(() => {
    if (selectedId) localStorage.setItem(THREAD_KEY, selectedId);
    else localStorage.removeItem(THREAD_KEY);
  }, [selectedId]);
  useEffect(() => {
    const handleResize = () => {
      setViewportWidth(window.innerWidth);
      setSidebarWidth((width) => clampSidebarWidth(width));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  useEffect(() => {
    if (!isResizing) return;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.userSelect = previousUserSelect;
    };
  }, [isResizing]);
  useEffect(() => {
    if (!focusComposerOnOpen || !open || view !== 'conversation' || !routeAllowed) return;
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('[aria-label="Ask the tutor"]')?.focus();
      setFocusComposerOnOpen(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusComposerOnOpen, open, routeAllowed, view]);
  useEffect(() => {
    if (
      selectionChecked ||
      !open ||
      !enabled ||
      !context.allowed ||
      !routeAllowed ||
      !threads.isSuccess
    ) {
      return;
    }
    setSelectionChecked(true);
    if (selectedId && !threads.data.some((thread) => thread.id === selectedId)) {
      setSelectedId('');
      setNewChatSelected(false);
      setView('list');
    }
  }, [
    context.allowed,
    enabled,
    open,
    routeAllowed,
    selectedId,
    selectionChecked,
    threads.data,
    threads.isSuccess,
  ]);
  const mutation = useMutation({
    mutationFn: async ({ question, threadId, context: requestContext }: TutorSendVariables) => {
      const target = threadId
        ? `/api/tutor/threads/${encodeURIComponent(threadId)}/messages`
        : '/api/tutor/threads';
      const response = await apiFetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question,
          conceptId: requestContext.conceptId ?? undefined,
          activityId: requestContext.activityId ?? undefined,
          exerciseId: requestContext.exerciseId ?? undefined,
          questionLabel: requestContext.questionLabel ?? undefined,
          lessonProblemId: requestContext.lessonProblemId ?? undefined,
          page: requestContext.page ?? undefined,
          knowledgePointId: requestContext.knowledgePointId ?? undefined,
          paperId: requestContext.paperId ?? undefined,
          pageNumber: requestContext.pageNumber ?? undefined,
          selection: requestContext.selection ?? undefined,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as TutorSendResponse;
      if (!response.ok) throw new Error(payload.error ?? 'Tutor is unavailable.');
      return payload;
    },
    onMutate: ({ question, threadId, optimisticId }) => {
      setPendingSend({
        id: optimisticId,
        threadId,
        role: 'user',
        content: question,
        createdAt: new Date().toISOString(),
      });
    },
    onSuccess: (payload, variables) => {
      if (payload.thread) {
        if (variables.threadId === '') {
          const greetingThreadId = payload.thread.id;
          setGreeting((current) =>
            current && current.threadId === null
              ? { ...current, threadId: greetingThreadId }
              : current,
          );
        }
        const detailKey = ['tutor', 'thread', payload.thread.id] as const;
        const previousDetail = queryClient.getQueryData<TutorThreadDetail>(detailKey);
        const previousSummary =
          threads.data?.find((thread) => thread.id === payload.thread?.id) ??
          previousDetail?.thread;
        const conceptId =
          payload.thread.conceptId ??
          previousSummary?.conceptId ??
          variables.context.conceptId ??
          null;
        const conceptTitle =
          previousSummary?.conceptTitle ??
          (conceptId === variables.context.conceptId
            ? (variables.context.conceptTitle ?? null)
            : null);
        const addedMessages = (payload.messages ?? []).filter(
          (message) => !previousDetail?.messages.some((existing) => existing.id === message.id),
        );
        queryClient.setQueryData<TutorThreadDetail>(detailKey, {
          thread: {
            id: payload.thread.id,
            conceptId,
            conceptTitle,
            title: payload.thread.title,
            updatedAt: payload.thread.updatedAt,
            messageCount:
              (previousSummary?.messageCount ?? previousDetail?.messages.length ?? 0) +
              addedMessages.length,
            lastMessagePreview:
              previousSummary?.lastMessagePreview ?? variables.question.slice(0, 140),
          },
          messages: [...(previousDetail?.messages ?? []), ...addedMessages],
        });
        setNewChatSelected(false);
        setSelectedId(payload.thread.id);
        setView('conversation');
      }
      setPendingSend(null);
      void queryClient.invalidateQueries({ queryKey: ['tutor', 'threads'] });
      void queryClient.invalidateQueries({ queryKey: ['tutor', 'thread'] });
    },
    onError: (cause, variables) => {
      setPendingSend(null);
      setDraft((current) =>
        current.trim() ? `${variables.question}\n${current}` : variables.question,
      );
      setError(cause instanceof Error ? cause.message : 'Tutor is unavailable.');
    },
  });
  const clearContext = useCallback(() => {
    setContext({ allowed: true, enabled: false });
  }, []);
  const clearSelection = useCallback(() => {
    setContext((current) => ({
      ...current,
      selection: undefined,
      pageLabel: current.pageLabel?.replace(/ · selected passage$/, ''),
    }));
  }, []);
  const openTutor = useCallback((next?: Partial<TutorRequestContext>) => {
    if (next) setContext((current) => ({ ...current, ...next }));
    setOpen(true);
  }, []);
  const openConversation = useCallback(
    (next?: Partial<TutorRequestContext>) => {
      if (next) setContext((current) => ({ ...current, ...next }));
      setError('');
      if (view !== 'conversation') {
        setDraft('');
        setNewChatSelected(true);
        setSelectedId('');
        setView('conversation');
      }
      setFocusComposerOnOpen(true);
      setOpen(true);
    },
    [view],
  );
  const startChat = useCallback((next: Partial<TutorRequestContext>, greetingText: string) => {
    setContext((current) => ({ ...current, ...next }));
    setError('');
    setDraft('');
    setNewChatSelected(true);
    setSelectedId('');
    setView('conversation');
    setGreeting({ text: greetingText, threadId: null });
    setFocusComposerOnOpen(true);
    setOpen(true);
  }, []);
  const value = useMemo<TutorContextValue>(
    () => ({
      setContext,
      clearContext,
      open: openTutor,
      openConversation,
      startChat,
      isOpen: open,
    }),
    [clearContext, open, openConversation, openTutor, startChat],
  );
  const messages = detail.data?.messages ?? [];
  const selectedThread =
    threads.data?.find((thread) => thread.id === selectedId) ?? detail.data?.thread;
  const showGreeting =
    (newChatSelected && greeting?.threadId === null) ||
    (greeting !== null && greeting.threadId !== null && greeting.threadId === selectedId);
  const visiblePendingSend = pendingSend?.threadId === selectedId ? pendingSend : null;
  const threadGroups = groupThreads(threads.data ?? []);
  const selectionPreview = context.selection
    ? `${context.selection.slice(0, 120)}${context.selection.length > 120 ? '…' : ''}`
    : null;
  const startNewChat = () => {
    setDraft('');
    setError('');
    setGreeting(null);
    setNewChatSelected(true);
    setSelectedId('');
    setView('conversation');
  };
  const openThread = (threadId: string) => {
    setError('');
    setNewChatSelected(false);
    setSelectedId(threadId);
    setView('conversation');
  };
  const draftLength = draft.trim().length;
  const draftTooLong = draftLength > TUTOR_QUESTION_MAX_LENGTH;
  const send = () => {
    if (!draft.trim() || mutation.isPending) return;
    if (draftTooLong) {
      setError(tutorQuestionTooLongMessage());
      return;
    }
    const question = draft.trim();
    const optimisticId = crypto.randomUUID();
    setDraft('');
    setError('');
    mutation.mutate({
      question,
      threadId: selectedId,
      context,
      optimisticId,
    });
    conversationContextRef.current?.scrollToBottom();
    if (context.selection) clearSelection();
  };
  const handleResizePointerDown = (event: React.PointerEvent<HTMLHRElement>) => {
    if (event.button !== 0 || isMobile) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStart.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: sidebarWidth,
    };
    setIsResizing(true);
  };
  const handleResizePointerMove = (event: React.PointerEvent<HTMLHRElement>) => {
    const start = resizeStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    setSidebarWidth(clampSidebarWidth(start.startWidth + start.startX - event.clientX));
  };
  const handleResizePointerUp = (event: React.PointerEvent<HTMLHRElement>) => {
    const start = resizeStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const width = clampSidebarWidth(start.startWidth + start.startX - event.clientX);
    setSidebarWidth(width);
    localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
    resizeStart.current = null;
    setIsResizing(false);
  };
  const handleResizePointerCancel = (event: React.PointerEvent<HTMLHRElement>) => {
    const start = resizeStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    setSidebarWidth(start.startWidth);
    resizeStart.current = null;
    setIsResizing(false);
  };
  const handleResizeKeyDown = (event: React.KeyboardEvent<HTMLHRElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const width = clampSidebarWidth(sidebarWidth + (event.key === 'ArrowLeft' ? 16 : -16));
    setSidebarWidth(width);
    localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
  };
  const resetSidebarWidth = () => {
    const width = clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    setSidebarWidth(width);
    localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
  };
  return (
    <SidebarProvider
      open={open && routeAllowed}
      onOpenChange={setOpen}
      data-resizing={isResizing ? 'true' : undefined}
      style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}
    >
      <TutorContext.Provider value={value}>
        <SidebarInset className="min-w-0">{children}</SidebarInset>
        {routeAllowed && (!shouldPushSidebar || open) ? (
          <Sidebar
            side="right"
            collapsible={shouldPushSidebar ? 'none' : 'offcanvas'}
            className={shouldPushSidebar ? 'relative h-svh min-h-0' : undefined}
            role="complementary"
            aria-label="Tutor"
          >
            {!isMobile ? (
              <hr
                aria-orientation="vertical"
                aria-label="Resize tutor"
                aria-valuenow={Math.round(sidebarWidth)}
                aria-valuemin={MIN_SIDEBAR_WIDTH}
                aria-valuemax={sidebarWidthMax}
                tabIndex={0}
                onPointerDown={handleResizePointerDown}
                onPointerMove={handleResizePointerMove}
                onPointerUp={handleResizePointerUp}
                onPointerCancel={handleResizePointerCancel}
                onKeyDown={handleResizeKeyDown}
                onDoubleClick={resetSidebarWidth}
                className="tutor-resize-handle absolute inset-y-0 left-[-4px] z-20 m-0 h-full w-2 cursor-col-resize border-0 bg-transparent p-0 touch-none select-none"
              />
            ) : null}
            {enabled && context.allowed ? (
              view === 'list' ? (
                <>
                  <SidebarHeader className="border-b p-4">
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="text-base font-medium">Chats</h2>
                      <div className="flex items-center gap-1">
                        <Button type="button" variant="outline" size="sm" onClick={startNewChat}>
                          <Plus aria-hidden="true" />
                          New chat
                        </Button>
                        <Button
                          type="button"
                          aria-label="Close tutor"
                          variant="ghost"
                          size="icon"
                          onClick={() => setOpen(false)}
                        >
                          <X aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                  </SidebarHeader>
                  <SidebarContent className="min-h-0 flex-1 p-2">
                    {threads.isPending ? (
                      <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
                        <Loader size={16} aria-hidden="true" />
                        Loading chats…
                      </div>
                    ) : null}
                    {threads.isError ? (
                      <Alert variant="destructive" className="m-2">
                        <AlertDescription>
                          {threads.error instanceof Error
                            ? threads.error.message
                            : 'Tutor conversations could not be loaded.'}
                        </AlertDescription>
                      </Alert>
                    ) : null}
                    {!threads.isPending && !threads.isError && threadGroups.length === 0 ? (
                      <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
                        <p className="text-sm text-muted-foreground">No chats yet</p>
                        <Button type="button" variant="outline" size="sm" onClick={startNewChat}>
                          <Plus aria-hidden="true" />
                          New chat
                        </Button>
                      </div>
                    ) : null}
                    <div className="space-y-2">
                      {threadGroups.map(([group, groupThreads], index) => (
                        <section key={group} className="space-y-1">
                          {index > 0 ? <Separator className="my-2" /> : null}
                          <h3 className="px-3 py-1 text-xs font-medium text-muted-foreground">
                            {group}
                          </h3>
                          {groupThreads.map((thread) => (
                            <Button
                              key={thread.id}
                              data-testid={`tutor-thread-${thread.id}`}
                              type="button"
                              variant="ghost"
                              aria-pressed={selectedId === thread.id}
                              className={`h-auto min-h-16 w-full cursor-pointer justify-start px-3 py-2 text-left ${
                                selectedId === thread.id ? 'bg-accent text-accent-foreground' : ''
                              }`}
                              onClick={() => openThread(thread.id)}
                            >
                              <span className="flex w-full min-w-0 items-center gap-3">
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-sm font-medium">
                                    {thread.title}
                                  </span>
                                  {thread.conceptTitle ? (
                                    <Badge
                                      variant="secondary"
                                      className="mt-1 max-w-full truncate text-muted-foreground"
                                    >
                                      {thread.conceptTitle}
                                    </Badge>
                                  ) : null}
                                </span>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                  {relativeThreadTime(thread.updatedAt)}
                                </span>
                              </span>
                            </Button>
                          ))}
                        </section>
                      ))}
                    </div>
                  </SidebarContent>
                </>
              ) : (
                <>
                  <SidebarHeader className="border-b p-3">
                    <div className="flex items-center justify-between gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label="Chats"
                        onClick={() => setView('list')}
                      >
                        <ArrowLeft aria-hidden="true" />
                        Chats
                      </Button>
                      <h2 data-testid="tutor-conversation-title" className="sr-only">
                        {newChatSelected ? 'New chat' : (selectedThread?.title ?? 'Conversation')}
                      </h2>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          aria-label="New chat"
                          variant="ghost"
                          size="icon"
                          onClick={startNewChat}
                        >
                          <Plus aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          aria-label="Close tutor"
                          variant="ghost"
                          size="icon"
                          onClick={() => setOpen(false)}
                        >
                          <X aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                  </SidebarHeader>
                  <SidebarContent className="min-h-0 flex-1 p-0">
                    <Conversation aria-label="Tutor messages" contextRef={conversationContextRef}>
                      <ConversationContent
                        className="gap-4 p-4"
                        scrollClassName="tutor-message-scroll-area"
                      >
                        {showGreeting && greeting ? (
                          <Message data-testid="tutor-greeting" from="assistant">
                            <p className="w-full text-left text-xs font-medium text-muted-foreground">
                              Tutor
                            </p>
                            <MessageContent
                              style={{ '--katex-cover': 'var(--sidebar)' } as React.CSSProperties}
                            >
                              <Markdown wrapDisplayMath>
                                {repairTutorMarkdown(greeting.text)}
                              </Markdown>
                            </MessageContent>
                          </Message>
                        ) : null}
                        {messages.map((message) => (
                          <Message
                            key={message.id}
                            data-testid={
                              message.role === 'user'
                                ? 'tutor-user-message'
                                : 'tutor-assistant-message'
                            }
                            from={message.role === 'user' ? 'user' : 'assistant'}
                          >
                            <p
                              className={`w-full text-xs font-medium text-muted-foreground ${
                                message.role === 'user' ? 'text-right' : 'text-left'
                              }`}
                            >
                              {message.role === 'user' ? 'You' : 'Tutor'}
                            </p>
                            <MessageContent
                              style={
                                {
                                  '--katex-cover':
                                    message.role === 'user' ? 'var(--secondary)' : 'var(--sidebar)',
                                } as React.CSSProperties
                              }
                            >
                              <Markdown wrapDisplayMath>
                                {message.role === 'assistant'
                                  ? repairTutorMarkdown(message.content)
                                  : message.content}
                              </Markdown>
                            </MessageContent>
                          </Message>
                        ))}
                        {messages.length === 0 && !visiblePendingSend && !showGreeting ? (
                          <ConversationEmptyState title="Start a conversation" description="" />
                        ) : null}
                        {visiblePendingSend ? (
                          <>
                            <Message
                              data-testid="tutor-user-message"
                              from="user"
                              key={visiblePendingSend.id}
                            >
                              <p className="w-full text-right text-xs font-medium text-muted-foreground">
                                You
                              </p>
                              <MessageContent
                                style={
                                  { '--katex-cover': 'var(--secondary)' } as React.CSSProperties
                                }
                              >
                                <Markdown wrapDisplayMath>{visiblePendingSend.content}</Markdown>
                              </MessageContent>
                            </Message>
                            {mutation.isPending ? (
                              <Message data-testid="tutor-thinking-bubble" from="assistant">
                                <p className="w-full text-xs font-medium text-muted-foreground">
                                  Tutor
                                </p>
                                <MessageContent
                                  className="rounded-lg bg-muted px-4 py-3"
                                  style={{ '--katex-cover': 'var(--muted)' } as React.CSSProperties}
                                >
                                  <div
                                    role="status"
                                    aria-label="Tutor is responding"
                                    className="flex items-center gap-2 text-sm text-muted-foreground"
                                  >
                                    <Loader size={16} aria-hidden="true" />
                                    Tutor is responding…
                                  </div>
                                </MessageContent>
                              </Message>
                            ) : null}
                          </>
                        ) : null}
                      </ConversationContent>
                      <ConversationScrollButton
                        aria-label="Scroll to latest message"
                        className="bg-background shadow-md dark:bg-background"
                      />
                    </Conversation>
                  </SidebarContent>
                  <SidebarFooter className="border-t p-4">
                    {selectionPreview ? (
                      <div className="flex items-start gap-2 rounded-md border bg-background p-2">
                        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                          Selected: “{selectionPreview}”
                        </p>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Clear selected passage"
                          onClick={clearSelection}
                        >
                          <X aria-hidden="true" />
                        </Button>
                      </div>
                    ) : null}
                    <PromptInput
                      className="w-full space-y-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        send();
                      }}
                    >
                      {error ? (
                        <Alert variant="destructive">
                          <AlertDescription>{error}</AlertDescription>
                        </Alert>
                      ) : null}
                      <PromptInputTextarea
                        aria-label="Ask the tutor"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            send();
                          }
                        }}
                      />
                      <div className="flex items-center justify-between gap-2">
                        <PromptInputSubmit
                          aria-label={mutation.isPending ? undefined : 'Send'}
                          loading={mutation.isPending}
                          disabled={!draft.trim() || draftTooLong}
                        >
                          Send
                        </PromptInputSubmit>
                        {draftLength > TUTOR_QUESTION_MAX_LENGTH - 500 ? (
                          <span
                            data-testid="tutor-draft-length"
                            className={`text-xs ${draftTooLong ? 'text-destructive' : 'text-muted-foreground'}`}
                          >
                            {draftTooLong
                              ? `Too long by ${(draftLength - TUTOR_QUESTION_MAX_LENGTH).toLocaleString('en-US')} characters`
                              : `${draftLength.toLocaleString('en-US')} / ${TUTOR_QUESTION_MAX_LENGTH.toLocaleString('en-US')}`}
                          </span>
                        ) : null}
                      </div>
                    </PromptInput>
                    <ContextLine pageLabel={context.pageLabel} />
                  </SidebarFooter>
                </>
              )
            ) : (
              <>
                <SidebarHeader className="border-b p-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-base font-medium">
                      {view === 'list' ? 'Chats' : 'Conversation'}
                    </h2>
                    <Button
                      type="button"
                      aria-label="Close tutor"
                      variant="ghost"
                      size="icon"
                      onClick={() => setOpen(false)}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </div>
                </SidebarHeader>
                <SidebarContent className="p-4 text-sm text-muted-foreground">
                  Tutor is unavailable.
                </SidebarContent>
              </>
            )}
          </Sidebar>
        ) : null}
        {enabled && context.allowed && routeAllowed && !open ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                onClick={() => setOpen(true)}
                className="fixed bottom-5 right-5 z-40 size-12 rounded-full shadow-lg"
                size="icon-lg"
                aria-label="Open tutor"
              >
                <Sparkles aria-hidden="true" className="size-5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Tutor</TooltipContent>
          </Tooltip>
        ) : null}
      </TutorContext.Provider>
    </SidebarProvider>
  );
}

export function useTutorSidebar() {
  const value = useContext(TutorContext);
  if (!value) throw new Error('useTutorSidebar must be used inside TutorContextProvider');
  return value;
}

export function TutorLauncher({
  context,
  greeting = 'What would you like help with on this question?',
  children = 'Ask the tutor',
}: {
  context: Partial<TutorRequestContext>;
  greeting?: string;
  children?: React.ReactNode;
}) {
  const tutor = useTutorSidebar();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={context.allowed === false}
      onClick={() => tutor.startChat(context, greeting)}
    >
      {children}
    </Button>
  );
}
