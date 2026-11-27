import type {
  TutorLessonStage,
  TutorThreadDetail,
  TutorThreadSummary,
} from '@academy/aesop/api/tutor';
import {
  repairTutorMarkdown,
  TUTOR_QUESTION_MAX_LENGTH,
  tutorQuestionTooLongMessage,
} from '@academy/shared/tutor';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Square, X } from 'lucide-react';
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { StickToBottomContext } from 'use-stick-to-bottom';
import { apiFetch } from '../../api/authenticated-fetch.js';
import { getJson } from '../../api/query-client.js';
import { AcademyMascot } from '../../components/academy-mascot.js';
import { ThinkingIndicator } from '../../components/thinking-indicator.js';
import { TortoiseMark } from '../../components/tortoise-mark.js';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '../../components/ui/ai/conversation.js';
import { Loader } from '../../components/ui/ai/loader.js';
import { Message, MessageContent } from '../../components/ui/ai/message.js';
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
} from '../../components/ui/ai/prompt-input.js';
import { Alert, AlertDescription } from '../../components/ui/alert.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Separator } from '../../components/ui/separator.js';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
} from '../../components/ui/sidebar.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js';
import { useIsMobile } from '../../hooks/use-mobile.js';
import { readBrowserStorage, writeBrowserStorage } from '../../lib/browser-storage.js';
import {
  tutorStatusQueryOptions,
  tutorThreadQueryOptions,
  tutorThreadsQueryOptions,
} from './queries.js';
import { checkTutorSvg, tutorSvgPlaceholder } from './tutor-svg.js';

export interface TutorRequestContext {
  conceptId?: string;
  conceptTitle?: string;
  activityId?: string;
  exerciseId?: string;
  questionLabel?: string;
  lessonStage?: TutorLessonStage;
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

function mergeConfirmedTutorMessages(
  detail: TutorThreadDetail,
  confirmed: Iterable<TutorMessage>,
): TutorThreadDetail {
  const messages = [...detail.messages];
  for (const message of confirmed) {
    if (
      !messages.some(
        (existing) =>
          existing.id === message.id ||
          (message.clientId !== null && existing.clientId === message.clientId),
      )
    ) {
      messages.push(message);
    }
  }
  messages.sort((first, second) => Date.parse(first.createdAt) - Date.parse(second.createdAt));
  return { ...detail, messages };
}

interface TutorContextValue {
  setContext: (context: TutorRequestContext) => void;
  clearContext: () => void;
  open: (context?: Partial<TutorRequestContext>) => void;
  openConversation: (context?: Partial<TutorRequestContext>) => void;
  startChat: (context: Partial<TutorRequestContext>, greeting: string) => void;
  isOpen: boolean;
}

const LazyMarkdown = lazy(() =>
  import('../../components/markdown.js').then((module) => ({ default: module.Markdown })),
);

export function renderTutorSvgCodeBlock(
  { language, source }: { language: string; source: string },
  isStreaming = false,
) {
  if (!/\blanguage-svg\b/.test(`language-${language}`)) return undefined;
  const diagram = checkTutorSvg(source);
  if (diagram.status !== 'valid') {
    return (
      <p className="text-xs text-muted-foreground">
        {tutorSvgPlaceholder(diagram.status, isStreaming)}
      </p>
    );
  }
  return (
    <figure className="my-3 flex w-full min-w-0 justify-center rounded-lg border border-border bg-card p-3">
      <img
        src={`data:image/svg+xml;utf8,${encodeURIComponent(source)}`}
        alt={diagram.label}
        className="h-auto w-full max-w-full"
      />
    </figure>
  );
}

function TutorMarkdown({
  children,
  isStreaming = false,
}: {
  children: string;
  isStreaming?: boolean;
}) {
  return (
    <Suspense
      fallback={
        <div className="whitespace-pre-wrap break-words text-base leading-7">{children}</div>
      }
    >
      <LazyMarkdown
        wrapDisplayMath
        renderCodeBlock={(block) => renderTutorSvgCodeBlock(block, isStreaming)}
      >
        {children}
      </LazyMarkdown>
    </Suspense>
  );
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
  const storedWidth = readBrowserStorage('localStorage', WIDTH_KEY);
  if (storedWidth === null || !storedWidth.trim()) {
    return clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
  }
  const width = Number(storedWidth);
  return clampSidebarWidth(Number.isFinite(width) ? width : DEFAULT_SIDEBAR_WIDTH);
}

interface TutorSendVariables {
  question: string;
  threadId: string;
  createThread: boolean;
  context: TutorRequestContext;
  clientMessageId: string;
  earlier: Array<{ clientMessageId: string; question: string }>;
  signal: AbortSignal;
  sendId: number;
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
  superseded?: boolean;
}

interface LocalTutorMessage {
  clientId: string;
  threadId: string;
  context: TutorRequestContext;
  content: string;
  createThread: boolean;
  status: 'sending' | 'failed';
  reason?: string;
  sendId: number;
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
  const contextRef = useRef(context);
  contextRef.current = context;
  const [open, setOpen] = useState(() => readBrowserStorage('localStorage', OPEN_KEY) === 'true');
  const [selectedId, setSelectedId] = useState(
    () => readBrowserStorage('localStorage', THREAD_KEY) || '',
  );
  const [view, setView] = useState<'list' | 'conversation'>(() =>
    readBrowserStorage('localStorage', THREAD_KEY) ? 'conversation' : 'list',
  );
  const [newChatSelected, setNewChatSelected] = useState(false);
  const [greeting, setGreeting] = useState<{ text: string; threadId: string | null } | null>(null);
  const [selectionChecked, setSelectionChecked] = useState(false);
  const [focusComposerOnOpen, setFocusComposerOnOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [localMessages, setLocalMessages] = useState<LocalTutorMessage[]>([]);
  const requestControllersByThread = useRef(new Map<string, AbortController>());
  const nextSendId = useRef(0);
  const latestSendByThread = useRef(new Map<string, number>());
  const [latestInFlightByThread, setLatestInFlightByThread] = useState<Record<string, number>>({});
  const newThreadId = useRef('');
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
  const tutorFlag = useQuery(tutorStatusQueryOptions());
  const enabled = context.enabled || tutorFlag.data?.tutorEnabled === true;
  const visibleOpen = open && routeAllowed && context.allowed;
  const loadingTutor = !context.enabled && tutorFlag.isPending && context.allowed;
  const confirmedMessagesByThread = useRef(new Map<string, Map<string, TutorMessage>>());
  const threads = useQuery({
    ...tutorThreadsQueryOptions(),
    enabled: open && enabled && context.allowed && routeAllowed,
  });
  const detailOptions = tutorThreadQueryOptions(selectedId);
  const detail = useQuery({
    ...detailOptions,
    staleTime: 0,
    queryFn: async (queryContext) => {
      const fetchDetail = detailOptions.queryFn;
      if (!fetchDetail) throw new Error('Tutor detail query is unavailable');
      const fresh = await fetchDetail(queryContext);
      const confirmedMessages = confirmedMessagesByThread.current.get(selectedId);
      return confirmedMessages?.size
        ? mergeConfirmedTutorMessages(fresh, confirmedMessages.values())
        : fresh;
    },
    enabled:
      open && view === 'conversation' && !!selectedId && enabled && context.allowed && routeAllowed,
  });
  useEffect(() => {
    writeBrowserStorage('localStorage', OPEN_KEY, String(open));
  }, [open]);
  useEffect(() => {
    if (selectedId) writeBrowserStorage('localStorage', THREAD_KEY, selectedId);
    else writeBrowserStorage('localStorage', THREAD_KEY, null);
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
  useEffect(() => {
    const threadId = newThreadId.current;
    if (
      !newChatSelected ||
      !threadId ||
      localMessages.some(
        (message) => message.status === 'sending' && message.threadId !== threadId,
      ) ||
      !threads.data?.some((thread) => thread.id === threadId)
    ) {
      return;
    }
    setSelectedId(threadId);
  }, [localMessages, newChatSelected, threads.data]);
  const mutation = useMutation({
    mutationFn: async ({
      question,
      threadId,
      createThread,
      context: requestContext,
      clientMessageId,
      earlier,
      signal,
    }: TutorSendVariables) => {
      const target = createThread
        ? '/api/tutor/threads'
        : `/api/tutor/threads/${encodeURIComponent(threadId)}/messages`;
      const response = await apiFetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          question,
          clientMessageId,
          earlier,
          ...(createThread ? { threadId } : {}),
          conceptId: requestContext.conceptId ?? undefined,
          activityId: requestContext.activityId ?? undefined,
          exerciseId: requestContext.exerciseId ?? undefined,
          questionLabel: requestContext.questionLabel ?? undefined,
          lessonStage: requestContext.lessonStage ?? undefined,
          lessonProblemId: requestContext.lessonProblemId ?? undefined,
          page: requestContext.page ?? undefined,
          knowledgePointId: requestContext.knowledgePointId ?? undefined,
          paperId: requestContext.paperId ?? undefined,
          pageNumber: requestContext.pageNumber ?? undefined,
          selection: requestContext.selection ?? undefined,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as TutorSendResponse;
      if (!response.ok) {
        throw Object.assign(new Error(payload.error ?? 'Tutor is unavailable.'), {
          reason: payload.error,
        });
      }
      return payload;
    },
    onSuccess: (payload, variables) => {
      if (payload.superseded) {
        if (payload.thread) {
          void queryClient.invalidateQueries({
            queryKey: ['tutor', 'thread', payload.thread.id],
          });
        }
        return;
      }
      if (payload.thread) {
        const shouldSelectCreatedThread =
          variables.createThread && newThreadId.current === payload.thread.id;
        if (shouldSelectCreatedThread) {
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
        const confirmedMessages =
          confirmedMessagesByThread.current.get(payload.thread.id) ??
          new Map<string, TutorMessage>();
        for (const message of payload.messages ?? []) {
          confirmedMessages.set(message.clientId ?? message.id, message);
        }
        confirmedMessagesByThread.current.set(payload.thread.id, confirmedMessages);
        const addedMessages = (payload.messages ?? []).filter(
          (message) =>
            !previousDetail?.messages.some(
              (existing) =>
                existing.id === message.id ||
                (message.clientId !== null && existing.clientId === message.clientId),
            ),
        );
        const mergedMessages = [...(previousDetail?.messages ?? []), ...addedMessages];
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
          messages: mergedMessages,
        });
        const confirmedClientIds = new Set(
          mergedMessages.flatMap((message) => (message.clientId ? [message.clientId] : [])),
        );
        setLocalMessages((current) => {
          const remaining = current.filter(
            (message) =>
              message.threadId !== payload.thread?.id || !confirmedClientIds.has(message.clientId),
          );
          return remaining.length === current.length ? current : remaining;
        });
        if (shouldSelectCreatedThread) {
          setNewChatSelected(false);
          setSelectedId(payload.thread.id);
          setView('conversation');
          newThreadId.current = '';
        }
      }
      void queryClient.invalidateQueries({ queryKey: ['tutor', 'threads'] });
    },
    onSettled: async (_payload, cause, variables) => {
      if (requestControllersByThread.current.get(variables.threadId)?.signal === variables.signal) {
        requestControllersByThread.current.delete(variables.threadId);
      }
      if (latestSendByThread.current.get(variables.threadId) !== variables.sendId) return;
      setLatestInFlightByThread((current) => {
        if (current[variables.threadId] !== variables.sendId) return current;
        const next = { ...current };
        delete next[variables.threadId];
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ['tutor', 'threads'] });
      let refetchedMessages: TutorMessage[] = [];
      try {
        const refreshed = await queryClient.fetchQuery({
          ...tutorThreadQueryOptions(variables.threadId),
          staleTime: 0,
          queryFn: async () => {
            const fresh = await getJson<TutorThreadDetail>(
              `/api/tutor/threads/${encodeURIComponent(variables.threadId)}`,
              'Tutor conversation unavailable',
            );
            const confirmedMessages = confirmedMessagesByThread.current.get(variables.threadId);
            return confirmedMessages?.size
              ? mergeConfirmedTutorMessages(fresh, confirmedMessages.values())
              : fresh;
          },
        });
        refetchedMessages = refreshed.messages;
      } catch {}
      if (latestSendByThread.current.get(variables.threadId) !== variables.sendId) return;
      const confirmedClientIds = new Set(
        refetchedMessages.flatMap((message) => (message.clientId ? [message.clientId] : [])),
      );
      const failureReason =
        cause && typeof cause === 'object' && 'reason' in cause
          ? (cause as { reason?: unknown }).reason
          : undefined;
      const reason =
        typeof failureReason === 'string' && failureReason !== 'Tutor unavailable'
          ? failureReason
          : undefined;
      setLocalMessages((current) => {
        let changed = false;
        const next = current.flatMap((message) => {
          if (message.threadId !== variables.threadId) return [message];
          if (confirmedClientIds.has(message.clientId)) {
            changed = true;
            return [];
          }
          if (message.status !== 'sending') return [message];
          changed = true;
          return [{ ...message, status: 'failed' as const, reason }];
        });
        return changed ? next : current;
      });
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
  const openTutor = useCallback(
    (next?: Partial<TutorRequestContext>) => {
      if (!contextRef.current.allowed || !routeAllowed) return;
      if (next) setContext((current) => ({ ...current, ...next }));
      setOpen(true);
    },
    [routeAllowed],
  );
  const openConversation = useCallback(
    (next?: Partial<TutorRequestContext>) => {
      if (!contextRef.current.allowed || !routeAllowed) return;
      if (next) setContext((current) => ({ ...current, ...next }));
      setError('');
      if (view !== 'conversation') {
        setDraft('');
        newThreadId.current = '';
        setNewChatSelected(true);
        setSelectedId('');
        setView('conversation');
      }
      setFocusComposerOnOpen(true);
      setOpen(true);
    },
    [routeAllowed, view],
  );
  const startChat = useCallback(
    (next: Partial<TutorRequestContext>, greetingText: string) => {
      if (!contextRef.current.allowed || !routeAllowed) return;
      setContext((current) => ({ ...current, ...next }));
      setError('');
      setDraft('');
      newThreadId.current = '';
      setNewChatSelected(true);
      setSelectedId('');
      setView('conversation');
      setGreeting({ text: greetingText, threadId: null });
      setFocusComposerOnOpen(true);
      setOpen(true);
    },
    [routeAllowed],
  );
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
  useEffect(() => {
    const confirmedClientIds = new Set(
      messages.flatMap((message) => (message.clientId ? [message.clientId] : [])),
    );
    if (!selectedId || confirmedClientIds.size === 0) return;
    setLocalMessages((current) => {
      const remaining = current.filter(
        (message) =>
          message.threadId !== selectedId ||
          message.status !== 'failed' ||
          !confirmedClientIds.has(message.clientId),
      );
      return remaining.length === current.length ? current : remaining;
    });
  }, [messages, selectedId]);
  const selectedThread =
    threads.data?.find((thread) => thread.id === selectedId) ?? detail.data?.thread;
  const showGreeting =
    (newChatSelected && greeting?.threadId === null) ||
    (greeting !== null && greeting.threadId !== null && greeting.threadId === selectedId);
  const visibleThreadId = selectedId || (newChatSelected ? newThreadId.current : '');
  const serverClientIds = new Set(
    messages.flatMap((message) => (message.clientId ? [message.clientId] : [])),
  );
  const visibleLocalMessages = localMessages
    .filter(
      (message) => message.threadId === visibleThreadId && !serverClientIds.has(message.clientId),
    )
    .sort((first, second) => first.sendId - second.sendId);
  const isSending = visibleThreadId !== '' && latestInFlightByThread[visibleThreadId] !== undefined;
  const threadGroups = groupThreads(threads.data ?? []);
  const noChats = !threads.isPending && !threads.isError && threadGroups.length === 0;
  const selectionPreview = context.selection
    ? `${context.selection.slice(0, 120)}${context.selection.length > 120 ? '…' : ''}`
    : null;
  const startNewChat = () => {
    setDraft('');
    setError('');
    setGreeting(null);
    newThreadId.current = '';
    setNewChatSelected(true);
    setSelectedId('');
    setView('conversation');
    setFocusComposerOnOpen(true);
  };
  const openThread = (threadId: string) => {
    setError('');
    newThreadId.current = '';
    setNewChatSelected(false);
    setSelectedId(threadId);
    setView('conversation');
  };
  const draftLength = draft.trim().length;
  const draftTooLong = draftLength > TUTOR_QUESTION_MAX_LENGTH;
  const submitQuestion = (
    question: string,
    threadId: string,
    createThread: boolean,
    requestContext: TutorRequestContext,
    retryClientId?: string,
  ) => {
    const cachedDetail = queryClient.getQueryData<TutorThreadDetail>(['tutor', 'thread', threadId]);
    const knownClientIds = new Set(
      cachedDetail?.messages.flatMap((message) => (message.clientId ? [message.clientId] : [])) ??
        [],
    );
    const clientMessageId = retryClientId ?? crypto.randomUUID();
    const earlier = localMessages
      .filter(
        (message) =>
          message.threadId === threadId &&
          message.clientId !== clientMessageId &&
          message.status === 'sending' &&
          !knownClientIds.has(message.clientId),
      )
      .sort((first, second) => first.sendId - second.sendId)
      .slice(0, 5)
      .map(({ clientId, content }) => ({ clientMessageId: clientId, question: content }));
    if (createThread) newThreadId.current = threadId;
    requestControllersByThread.current.get(threadId)?.abort();
    const controller = new AbortController();
    requestControllersByThread.current.set(threadId, controller);
    const sendId = nextSendId.current + 1;
    nextSendId.current = sendId;
    latestSendByThread.current.set(threadId, sendId);
    setLatestInFlightByThread((current) => ({ ...current, [threadId]: sendId }));
    setLocalMessages((current) => {
      const existing = current.some((message) => message.clientId === clientMessageId);
      if (!existing) {
        return [
          ...current,
          {
            clientId: clientMessageId,
            threadId,
            content: question,
            context: requestContext,
            createThread,
            status: 'sending',
            sendId,
          },
        ];
      }
      return current.map((message) =>
        message.clientId === clientMessageId
          ? { ...message, status: 'sending', reason: undefined, sendId }
          : message,
      );
    });
    setError('');
    mutation.mutate({
      question,
      threadId,
      createThread,
      context: requestContext,
      clientMessageId,
      earlier,
      signal: controller.signal,
      sendId,
    });
    conversationContextRef.current?.scrollToBottom();
    if (requestContext.selection) clearSelection();
  };
  const send = () => {
    const question = draft.trim();
    if (!question) {
      const controller = requestControllersByThread.current.get(visibleThreadId);
      controller?.abort();
      return;
    }
    if (draftTooLong) {
      setError(tutorQuestionTooLongMessage());
      return;
    }
    const createThread = newChatSelected || !selectedId;
    const threadId = createThread ? newThreadId.current || crypto.randomUUID() : selectedId;
    setDraft('');
    submitQuestion(question, threadId, createThread, context);
  };
  const retryFailedSend = (failedMessage: LocalTutorMessage) => {
    submitQuestion(
      failedMessage.content,
      failedMessage.threadId,
      failedMessage.createThread,
      failedMessage.context,
      failedMessage.clientId,
    );
  };
  const editFailedSend = (failedMessage: LocalTutorMessage) => {
    setDraft((current) =>
      current.trim() ? `${failedMessage.content}\n${current}` : failedMessage.content,
    );
    setLocalMessages((current) =>
      current.filter((message) => message.clientId !== failedMessage.clientId),
    );
    setError('');
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
    writeBrowserStorage('localStorage', WIDTH_KEY, String(Math.round(width)));
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
    writeBrowserStorage('localStorage', WIDTH_KEY, String(Math.round(width)));
  };
  const resetSidebarWidth = () => {
    const width = clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    setSidebarWidth(width);
    writeBrowserStorage('localStorage', WIDTH_KEY, String(Math.round(width)));
  };
  return (
    <SidebarProvider
      open={visibleOpen}
      onOpenChange={(nextOpen) => {
        if (context.allowed && routeAllowed) setOpen(nextOpen);
      }}
      openMobile={visibleOpen}
      onOpenMobileChange={(nextOpen) => {
        if (context.allowed && routeAllowed) setOpen(nextOpen);
      }}
      disableKeyboardShortcut={!context.allowed || !routeAllowed}
      data-resizing={isResizing ? 'true' : undefined}
      className="min-h-0 flex-1"
      style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}
    >
      <TutorContext.Provider value={value}>
        <SidebarInset as="div" className="min-h-0 min-w-0">
          {children}
        </SidebarInset>
        {routeAllowed && context.allowed && (!shouldPushSidebar || visibleOpen) ? (
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
                      <h2 className="flex items-center gap-2 text-base font-medium">
                        <TortoiseMark className="size-6" />
                        Chats
                      </h2>
                      <div className="flex items-center gap-1">
                        {threads.isPending || threads.isError || threadGroups.length > 0 ? (
                          <Button type="button" variant="outline" size="sm" onClick={startNewChat}>
                            <Plus aria-hidden="true" />
                            New chat
                          </Button>
                        ) : null}
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
                      <div role="status" aria-label="Loading chats" className="space-y-1 p-1">
                        {['first', 'second', 'third', 'fourth'].map((row) => (
                          <div
                            key={row}
                            data-testid="tutor-thread-skeleton"
                            className="flex min-h-16 items-start justify-between gap-3 rounded-md px-3 py-2"
                          >
                            <div className="min-w-0 flex-1 space-y-2">
                              <Skeleton className="h-4 w-[70%]" />
                              <Skeleton className="h-4 w-24 rounded-full" />
                            </div>
                            <Skeleton className="mt-0.5 h-3 w-10 shrink-0" />
                          </div>
                        ))}
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
                    {noChats ? (
                      <div
                        data-testid="tutor-empty-thread-list"
                        className="flex flex-col items-center gap-3 px-4 py-8 text-center"
                      >
                        <AcademyMascot className="size-20" />
                        <p className="text-sm text-muted-foreground">
                          No chats yet. Ask a question below.
                        </p>
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
                        <TortoiseMark className="size-5" />
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
                        {newChatSelected &&
                        !showGreeting &&
                        messages.length === 0 &&
                        visibleLocalMessages.length === 0 ? (
                          threads.isPending ? null : threads.isError ? (
                            <Alert variant="destructive">
                              <AlertDescription>
                                {threads.error instanceof Error
                                  ? threads.error.message
                                  : 'Tutor conversations could not be loaded.'}
                              </AlertDescription>
                            </Alert>
                          ) : (
                            <p
                              data-testid="tutor-empty-conversation"
                              className="my-auto px-4 text-center text-sm text-muted-foreground"
                            >
                              {noChats
                                ? 'No chats yet. Ask a question below.'
                                : 'Ask a question below to start a new chat.'}
                            </p>
                          )
                        ) : null}
                        {!newChatSelected &&
                        selectedId &&
                        detail.isPending &&
                        messages.length === 0 &&
                        visibleLocalMessages.length === 0 ? (
                          <div
                            role="status"
                            aria-label="Loading conversation"
                            className="flex flex-col gap-4 py-2"
                          >
                            <div className="space-y-2 self-start">
                              <Skeleton className="h-3 w-10" />
                              <Skeleton className="h-12 w-48 rounded-2xl" />
                            </div>
                            <div className="space-y-2 self-end">
                              <Skeleton className="h-3 w-10" />
                              <Skeleton className="h-12 w-56 rounded-2xl" />
                            </div>
                          </div>
                        ) : null}
                        {!newChatSelected && selectedId && detail.isError ? (
                          <Alert variant="destructive">
                            <AlertDescription>
                              {detail.error instanceof Error
                                ? detail.error.message
                                : 'Tutor conversation could not be loaded.'}
                            </AlertDescription>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              loading={detail.isFetching}
                              onClick={() => void detail.refetch()}
                            >
                              Retry
                            </Button>
                          </Alert>
                        ) : null}
                        {showGreeting && greeting ? (
                          <Message data-testid="tutor-greeting" from="assistant">
                            <p className="w-full text-left text-xs font-medium text-muted-foreground">
                              Tutor
                            </p>
                            <MessageContent>
                              <TutorMarkdown>{repairTutorMarkdown(greeting.text)}</TutorMarkdown>
                            </MessageContent>
                          </Message>
                        ) : null}
                        {messages.map((message) => (
                          <Message
                            key={message.clientId ?? message.id}
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
                            <MessageContent className="has-[figure]:w-full">
                              <TutorMarkdown>
                                {message.role === 'assistant'
                                  ? repairTutorMarkdown(message.content)
                                  : message.content}
                              </TutorMarkdown>
                            </MessageContent>
                          </Message>
                        ))}
                        {visibleLocalMessages.map((message) => (
                          <Message
                            key={message.clientId}
                            data-testid={
                              message.status === 'failed'
                                ? 'tutor-failed-message'
                                : 'tutor-user-message'
                            }
                            from="user"
                          >
                            <p className="w-full text-right text-xs font-medium text-muted-foreground">
                              You
                            </p>
                            <MessageContent>
                              <TutorMarkdown>{message.content}</TutorMarkdown>
                            </MessageContent>
                            {message.status === 'failed' ? (
                              <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
                                <span>
                                  Didn't send.
                                  {message.reason ? ` ${message.reason}` : ''}
                                </span>
                                <Button
                                  type="button"
                                  variant="link"
                                  size="sm"
                                  className="h-auto px-0 py-0 text-xs"
                                  onClick={() => retryFailedSend(message)}
                                >
                                  Retry
                                </Button>
                                <Button
                                  type="button"
                                  variant="link"
                                  size="sm"
                                  className="h-auto px-0 py-0 text-xs"
                                  onClick={() => editFailedSend(message)}
                                >
                                  Edit
                                </Button>
                              </div>
                            ) : null}
                          </Message>
                        ))}
                        {isSending ? (
                          <Message data-testid="tutor-thinking-bubble" from="assistant">
                            <p className="w-full text-xs font-medium text-muted-foreground">
                              Tutor
                            </p>
                            <MessageContent className="w-full">
                              <ThinkingIndicator />
                            </MessageContent>
                          </Message>
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
                      className="w-full space-y-2 rounded-xl border bg-card p-2 transition-shadow focus-within:ring-2 focus-within:ring-ring/30"
                      onSubmit={(event) => {
                        event.preventDefault();
                        send();
                      }}
                    >
                      {error ? (
                        <p role="alert" className="px-2 text-xs text-destructive">
                          {error}
                        </p>
                      ) : null}
                      <PromptInputTextarea
                        className="max-h-[min(30dvh,16rem)] min-h-24 resize-none overflow-y-auto rounded-lg border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:border-transparent focus-visible:ring-0"
                        aria-label="Ask the tutor"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (
                            event.key === 'Enter' &&
                            !event.shiftKey &&
                            !event.nativeEvent.isComposing
                          ) {
                            event.preventDefault();
                            send();
                          }
                        }}
                      />
                      <div className="flex items-center justify-end gap-2">
                        {isSending && !draft.trim() ? (
                          <Button
                            type="submit"
                            size="icon"
                            variant="default"
                            className="rounded-full"
                            aria-label="Stop"
                          >
                            <Square className="size-3.5 fill-current" aria-hidden="true" />
                          </Button>
                        ) : (
                          <PromptInputSubmit disabled={!draft.trim() || draftTooLong}>
                            Send
                          </PromptInputSubmit>
                        )}
                        {draftLength >= TUTOR_QUESTION_MAX_LENGTH * 0.8 ? (
                          <span
                            data-testid="tutor-draft-length"
                            className={`order-first mr-auto text-xs ${draftTooLong ? 'text-destructive' : 'text-muted-foreground'}`}
                          >
                            {draftTooLong
                              ? `Too long by ${(draftLength - TUTOR_QUESTION_MAX_LENGTH).toLocaleString('en-US')} characters`
                              : `${draftLength.toLocaleString('en-US')} / ${TUTOR_QUESTION_MAX_LENGTH.toLocaleString('en-US')}`}
                          </span>
                        ) : null}
                      </div>
                    </PromptInput>
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
                  {loadingTutor ? (
                    <div
                      role="status"
                      aria-label="Loading tutor"
                      className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground"
                    >
                      <Loader size={16} aria-hidden="true" />
                      Loading tutor…
                    </div>
                  ) : (
                    'Tutor is unavailable.'
                  )}
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
                variant="outline"
                className="fixed bottom-5 right-5 z-40 size-11 rounded-full bg-card shadow-md"
                size="icon-lg"
                aria-label="Open tutor"
              >
                <TortoiseMark className="size-7" />
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
  if (context.allowed === false) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => tutor.startChat(context, greeting)}
    >
      <TortoiseMark className="size-4" />
      {children}
    </Button>
  );
}
