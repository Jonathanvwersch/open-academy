import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.js';
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
  const [newChatSelected, setNewChatSelected] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
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
    enabled: open && !!selectedId && enabled && context.allowed && routeAllowed,
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
    if (!threads.data || selectedId || newChatSelected) return;
    const newestForConcept = context.conceptId
      ? threads.data.find((thread) => thread.conceptId === context.conceptId)
      : undefined;
    if (newestForConcept) setSelectedId(newestForConcept.id);
  }, [context.conceptId, newChatSelected, selectedId, threads.data]);
  const mutation = useMutation({
    mutationFn: async (question: string) => {
      const target = selectedId
        ? `/api/tutor/threads/${encodeURIComponent(selectedId)}/messages`
        : '/api/tutor/threads';
      const response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, ...context }),
      });
      const payload = (await response.json()) as {
        thread?: TutorThreadSummary;
        messages?: TutorMessage[];
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? 'Tutor is unavailable.');
      return payload;
    },
    onSuccess: async (payload) => {
      if (payload.thread) {
        setNewChatSelected(false);
        setSelectedId(payload.thread.id);
      }
      setDraft('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tutor', 'threads'] }),
        queryClient.invalidateQueries({ queryKey: ['tutor', 'thread'] }),
      ]);
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : 'Tutor is unavailable.'),
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
  const selectedThread = threads.data?.find((thread) => thread.id === selectedId);
  const send = () => {
    if (!draft.trim() || mutation.isPending) return;
    setError('');
    mutation.mutate(draft.trim());
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
            <SidebarHeader className="gap-3 border-b p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-medium">Tutor</h2>
                <Button
                  type="button"
                  aria-label="Close tutor"
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setOpen(false);
                  }}
                >
                  ×
                </Button>
              </div>
              {enabled && context.allowed ? (
                <div className="flex min-w-0 items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <Select
                      value={selectedId}
                      onValueChange={(threadId) => {
                        setNewChatSelected(false);
                        setSelectedId(threadId);
                      }}
                    >
                      <SelectTrigger aria-label="Tutor conversation" className="w-full min-w-0">
                        <SelectValue className="min-w-0 truncate" placeholder="Choose chat">
                          {selectedThread ? (
                            <span className="flex min-w-0 items-center gap-2">
                              <Badge variant="secondary" className="max-w-[10rem] truncate">
                                {selectedThread.conceptTitle ?? 'General'}
                              </Badge>
                              <span className="shrink-0 text-xs">
                                {selectedThread.title.split(' · ').at(-1)}
                              </span>
                            </span>
                          ) : undefined}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent aria-label="Saved tutor conversations">
                        {(threads.data ?? []).map((thread) => (
                          <SelectItem key={thread.id} value={thread.id}>
                            <span className="flex min-w-0 items-center gap-2">
                              <Badge variant="secondary" className="max-w-[10rem] truncate">
                                {thread.conceptTitle ?? 'General'}
                              </Badge>
                              <span className="min-w-0 truncate text-xs">
                                {thread.lastMessagePreview}
                              </span>
                              <span className="shrink-0 text-xs">
                                {thread.title.split(' · ').at(-1)}
                              </span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 whitespace-nowrap"
                    onClick={() => {
                      setNewChatSelected(true);
                      setSelectedId('');
                    }}
                  >
                    New chat
                  </Button>
                </div>
              ) : null}
            </SidebarHeader>
            {enabled && context.allowed ? (
              <>
                <div className="border-b px-4 py-2 text-xs text-muted-foreground">
                  {context.conceptTitle ?? context.conceptId ?? 'General'}
                  {context.lessonProblemId || context.exerciseId ? ' · current problem' : ''}
                  {selectedThread ? ` · ${selectedThread.messageCount} messages` : ''}
                </div>
                <SidebarContent className="min-h-0 flex-1 p-0">
                  <Conversation aria-label="Tutor messages">
                    <ConversationContent className="gap-4 p-4">
                      {messages.length ? (
                        messages.map((message) => (
                          <Message
                            key={message.id}
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
                      {mutation.isPending ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader size={16} aria-label="Tutor is responding" />
                          Tutor is responding…
                        </div>
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
                    <PromptInputSubmit disabled={mutation.isPending || !draft.trim()}>
                      {mutation.isPending ? 'Sending…' : 'Send'}
                    </PromptInputSubmit>
                  </PromptInput>
                </SidebarFooter>
              </>
            ) : (
              <SidebarContent className="p-4 text-sm text-muted-foreground">
                Tutor is unavailable.
              </SidebarContent>
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
