import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Sparkles, X } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
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
  lessonProblemId?: string;
  allowed: boolean;
  enabled: boolean;
}

type TutorMessage = TutorThreadDetail['messages'][number];

interface TutorContextValue {
  setContext: (context: TutorRequestContext) => void;
  open: (context?: Partial<TutorRequestContext>) => void;
}

const TutorContext = createContext<TutorContextValue | null>(null);
const OPEN_KEY = 'academy.tutor.open';
const THREAD_KEY = 'academy.tutor.thread';

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
  const response = await fetch(url);
  if (!response.ok) throw new Error('Tutor conversations could not be loaded.');
  return (await response.json()) as T;
}

export function TutorContextProvider({
  children,
  routeAllowed = true,
  sessionRoute = false,
}: {
  children: React.ReactNode;
  routeAllowed?: boolean;
  sessionRoute?: boolean;
}) {
  const queryClient = useQueryClient();
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
  const [selectionChecked, setSelectionChecked] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [pendingSend, setPendingSend] = useState<PendingTutorMessage | null>(null);
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
    if (!sessionRoute) setContext({ allowed: true, enabled: false });
  }, [sessionRoute]);
  useEffect(() => {
    if (selectedId) localStorage.setItem(THREAD_KEY, selectedId);
    else localStorage.removeItem(THREAD_KEY);
  }, [selectedId]);
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
      const response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, ...requestContext }),
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
  const value = useMemo<TutorContextValue>(
    () => ({
      setContext,
      open: (next) => {
        if (next) setContext((current) => ({ ...current, ...next }));
        setOpen(true);
      },
    }),
    [],
  );
  const messages = detail.data?.messages ?? [];
  const selectedThread =
    threads.data?.find((thread) => thread.id === selectedId) ?? detail.data?.thread;
  const visiblePendingSend = pendingSend?.threadId === selectedId ? pendingSend : null;
  const threadGroups = groupThreads(threads.data ?? []);
  const activeConceptTitle = newChatSelected
    ? context.conceptTitle
    : (selectedThread?.conceptTitle ??
      (selectedThread?.conceptId === context.conceptId ? context.conceptTitle : undefined));
  const startNewChat = () => {
    setDraft('');
    setError('');
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
  const send = () => {
    if (!draft.trim() || mutation.isPending) return;
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
  };
  return (
    <SidebarProvider
      open={open && routeAllowed}
      onOpenChange={setOpen}
      style={{ '--sidebar-width': '24rem' } as React.CSSProperties}
    >
      <TutorContext.Provider value={value}>
        <SidebarInset className="min-w-0">{children}</SidebarInset>
        {routeAllowed ? (
          <Sidebar side="right" collapsible="offcanvas" role="complementary" aria-label="Tutor">
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
                    <div className="flex min-w-0 items-center gap-2">
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
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <p
                          data-testid="tutor-conversation-title"
                          className="truncate text-sm font-medium"
                        >
                          {newChatSelected ? 'New chat' : (selectedThread?.title ?? 'Conversation')}
                        </p>
                        {activeConceptTitle ? (
                          <Badge
                            variant="secondary"
                            className="max-w-full truncate text-muted-foreground"
                          >
                            {activeConceptTitle}
                          </Badge>
                        ) : null}
                      </div>
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
                  <SidebarContent className="min-h-0 flex-1 p-0">
                    <Conversation aria-label="Tutor messages">
                      <ConversationContent className="gap-4 p-4">
                        {messages.length || visiblePendingSend ? (
                          messages.map((message) => (
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
                              <MessageContent>
                                <Markdown>{message.content}</Markdown>
                              </MessageContent>
                            </Message>
                          ))
                        ) : (
                          <ConversationEmptyState title="Start a conversation" description="" />
                        )}
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
                              <MessageContent>
                                <Markdown>{visiblePendingSend.content}</Markdown>
                              </MessageContent>
                            </Message>
                            {mutation.isPending ? (
                              <Message data-testid="tutor-thinking-bubble" from="assistant">
                                <p className="w-full text-xs font-medium text-muted-foreground">
                                  Tutor
                                </p>
                                <MessageContent className="rounded-lg bg-muted px-4 py-3">
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
                    </Conversation>
                  </SidebarContent>
                  <SidebarFooter className="border-t p-4">
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
                      <PromptInputSubmit
                        aria-label={mutation.isPending ? 'Sending…' : 'Send'}
                        disabled={mutation.isPending || !draft.trim()}
                      >
                        {mutation.isPending ? 'Sending…' : 'Send'}
                      </PromptInputSubmit>
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
  children = 'Ask the tutor',
}: {
  context: Partial<TutorRequestContext>;
  children?: React.ReactNode;
}) {
  const tutor = useTutorSidebar();
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => tutor.open(context)}>
      {children}
    </Button>
  );
}
