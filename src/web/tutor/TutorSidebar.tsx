import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Markdown } from '../components.js';
import {
  type TutorThreadDetail,
  type TutorThreadSummary,
  tutorThreadQueryOptions,
  tutorThreadsQueryOptions,
} from '../queries.js';

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
  const [dropdownOpen, setDropdownOpen] = useState(false);
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
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-40 rounded-full bg-blue-700 px-5 py-3 font-medium text-white shadow-lg"
          aria-label="Open tutor"
        >
          Tutor
        </button>
      ) : null}
      {open && enabled && context.allowed && routeAllowed ? (
        <aside
          aria-label="Tutor sidebar"
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[400px] flex-col border-l border-neutral-200 bg-white shadow-2xl"
        >
          <header className="flex items-center gap-2 border-b border-neutral-200 p-4">
            <h2 className="mr-auto font-semibold">Tutor</h2>
            <div className="relative min-w-0 shrink">
              <button
                type="button"
                aria-label="Tutor conversation"
                aria-expanded={dropdownOpen}
                onClick={() => setDropdownOpen((shown) => !shown)}
                className="min-w-0 max-w-48 truncate rounded border border-neutral-300 px-2 py-1 text-left text-sm"
              >
                {selectedThread
                  ? `${selectedThread.conceptTitle ?? 'General'} · ${selectedThread.title.split(' · ').at(-1)}`
                  : 'Choose chat'}
              </button>
              {dropdownOpen ? (
                <div
                  role="listbox"
                  aria-label="Saved tutor conversations"
                  className="absolute right-0 top-full z-10 mt-1 max-h-72 w-72 overflow-y-auto rounded-md border border-neutral-200 bg-white p-1 shadow-lg"
                >
                  {(threads.data ?? []).map((thread) => (
                    <button
                      key={thread.id}
                      type="button"
                      role="option"
                      aria-selected={thread.id === selectedId}
                      onClick={() => {
                        setNewChatSelected(false);
                        setSelectedId(thread.id);
                        setDropdownOpen(false);
                      }}
                      className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-neutral-100"
                    >
                      <span className="rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-800">
                        {thread.conceptTitle ?? 'General'}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-neutral-600">
                        {thread.lastMessagePreview}
                      </span>
                      <span className="ml-auto text-xs text-neutral-500">
                        {thread.title.split(' · ').at(-1)}
                      </span>
                    </button>
                  ))}
                  {threads.data?.length === 0 ? (
                    <p className="px-2 py-2 text-sm text-neutral-500">No saved conversations</p>
                  ) : null}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="shrink-0 whitespace-nowrap rounded px-2 py-1 text-sm hover:bg-neutral-100"
              onClick={() => {
                setNewChatSelected(true);
                setSelectedId('');
                setDropdownOpen(false);
              }}
            >
              New chat
            </button>
            <button
              type="button"
              aria-label="Close tutor"
              className="rounded px-2 py-1 text-lg hover:bg-neutral-100"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </header>
          <div className="border-b border-neutral-100 px-4 py-2 text-xs text-neutral-500">
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
                    ? 'ml-8 rounded-lg bg-blue-50 p-3'
                    : 'mr-4 rounded-lg bg-neutral-50 p-3'
                }
              >
                <p className="mb-1 text-xs font-medium text-neutral-500">
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
              <p role="alert" className="text-sm text-red-700">
                {error}
              </p>
            ) : null}
            <textarea
              aria-label="Ask the tutor"
              className="min-h-24 w-full rounded-md border border-neutral-300 p-2 text-sm"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <button
              type="submit"
              disabled={mutation.isPending || !draft.trim()}
              className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {mutation.isPending ? 'Sending…' : 'Send'}
            </button>
          </form>
        </aside>
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
    <button
      type="button"
      className="rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-50"
      onClick={() => tutor.open(context)}
    >
      {children}
    </button>
  );
}
