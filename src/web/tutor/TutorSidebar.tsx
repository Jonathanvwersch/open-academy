import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Markdown } from '../components.js';
import {
  type TutorThreadDetail,
  type TutorThreadSummary,
  tutorThreadQueryOptions,
  tutorThreadsQueryOptions,
} from '../queries.js';
import { Alert, AlertDescription } from '../ui/alert.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.js';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet.js';
import { Textarea } from '../ui/textarea.js';

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
    <TutorContext.Provider value={value}>
      {children}
      {enabled && context.allowed && routeAllowed ? (
        <Sheet open={open} onOpenChange={setOpen} modal={false}>
          <Button
            type="button"
            onClick={() => setOpen(true)}
            className="fixed bottom-5 right-5 z-40 rounded-full shadow-lg"
            aria-label="Open tutor"
          >
            Tutor
          </Button>
          <SheetContent
            aria-label="Tutor sidebar"
            side="right"
            showOverlay={false}
            showCloseButton={false}
            className="flex h-full w-[400px] max-w-[100vw] flex-col gap-0 p-0"
          >
            <SheetHeader className="gap-3 border-b p-4">
              <div className="flex items-center justify-between">
                <SheetTitle>Tutor</SheetTitle>
                <Button
                  type="button"
                  aria-label="Close tutor"
                  variant="ghost"
                  size="icon"
                  onClick={() => setOpen(false)}
                >
                  ×
                </Button>
              </div>
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
            </SheetHeader>
            <div className="border-b px-4 py-2 text-xs text-muted-foreground">
              {context.conceptTitle ?? context.conceptId ?? 'General'}
              {context.lessonProblemId || context.exerciseId ? ' · current problem' : ''}
              {selectedThread ? ` · ${selectedThread.messageCount} messages` : ''}
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={
                    message.role === 'user'
                      ? 'ml-8 rounded-lg bg-muted p-3'
                      : 'mr-4 rounded-lg border p-3'
                  }
                >
                  <p className="mb-1 text-xs font-medium text-muted-foreground">
                    {message.role === 'user' ? 'You' : 'Tutor'}
                  </p>
                  <Markdown>{message.content}</Markdown>
                </div>
              ))}
            </div>
            <form
              className="space-y-2 border-t border-neutral-200 p-4"
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
              <Textarea
                aria-label="Ask the tutor"
                className="min-h-24 w-full"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
              <Button type="submit" disabled={mutation.isPending || !draft.trim()}>
                {mutation.isPending ? 'Sending…' : 'Send'}
              </Button>
            </form>
          </SheetContent>
        </Sheet>
      ) : null}
    </TutorContext.Provider>
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
