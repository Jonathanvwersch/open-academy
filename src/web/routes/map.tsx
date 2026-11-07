import dagre from '@dagrejs/dagre';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Background, Controls, type Edge, type Node, ReactFlow } from '@xyflow/react';
import { X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/ui/button.js';
import { Card, CardContent } from '@/ui/card.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select.js';
import { apiFetch } from '../authenticated-fetch.js';
import { masteryStateLabels } from '../mastery-labels.js';
import { conceptQueryOptions, mapQueryOptions } from '../queries.js';
import { PageSkeleton } from '../skeletons.js';
import { useTutorSidebar } from '../tutor/TutorSidebar.js';
import '@xyflow/react/dist/style.css';

export const Route = createFileRoute('/map')({
  pendingComponent: PageSkeleton,
  loader: async ({ context }) => {
    const map = await context.queryClient.ensureQueryData(mapQueryOptions(null));
    await context.queryClient.ensureQueryData(mapQueryOptions(map.currentWeekDomain));
  },
  component: MapPage,
});

function MapPage() {
  const queryClient = useQueryClient();
  const tutorSidebar = useTutorSidebar();
  const [domain, setDomain] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const mapQuery = useSuspenseQuery(mapQueryOptions(domain));
  useEffect(() => {
    if (domain === null && mapQuery.data?.currentWeekDomain) {
      setDomain(mapQuery.data.currentWeekDomain);
    }
  }, [domain, mapQuery.data?.currentWeekDomain]);
  const graph = useMemo(() => {
    const data = mapQuery.data;
    const layout = new dagre.graphlib.Graph();
    layout.setGraph({ rankdir: 'TB', nodesep: 36, ranksep: 70 });
    layout.setDefaultEdgeLabel(() => ({}));
    for (const node of data.nodes) layout.setNode(node.id, { width: 190, height: 76 });
    for (const edge of data.edges) layout.setEdge(edge.prerequisiteId, edge.conceptId);
    dagre.layout(layout);
    const visible = data.nodes;
    const visibleIds = new Set(visible.map((node) => node.id));
    const domainTitles = new Map(data.domains.map((item) => [item.id, item.title]));
    const nodes = visible.map((node) => {
      const position = layout.node(node.id);
      const states = Object.values(node.dimensions).map((item) => item.state);
      const unavailable = !node.available && node.status !== 'stub';
      const color =
        node.status === 'stub'
          ? '#e5e5e5'
          : unavailable
            ? '#ede9fe'
            : states.includes('retained')
              ? '#dcfce7'
              : states.includes('independent')
                ? '#e0f2fe'
                : states.includes('assisted')
                  ? '#fef3c7'
                  : '#f5f5f5';
      return {
        id: node.id,
        position: { x: position.x - 95, y: position.y - 38 },
        data: {
          label: (
            <div className="leading-5">
              <div>{node.status === 'stub' ? `${node.title} · Not yet authored` : node.title}</div>
              {(!domain || node.domain !== domain) && (
                <span className="text-[10px] text-muted-foreground">
                  {domainTitles.get(node.domain) ?? node.domain}
                </span>
              )}
            </div>
          ),
        },
        style: {
          width: 190,
          borderRadius: 10,
          border: unavailable ? '2px dashed #7c3aed' : '1px solid #a3a3a3',
          background: color,
          opacity: node.available || node.status === 'stub' ? 1 : 0.9,
          padding: 10,
        },
      };
    });
    const edges: Edge[] = data.edges
      .filter((edge) => visibleIds.has(edge.prerequisiteId) && visibleIds.has(edge.conceptId))
      .map((edge) => ({
        id: `${edge.prerequisiteId}-${edge.conceptId}`,
        source: edge.prerequisiteId,
        target: edge.conceptId,
        type: 'smoothstep',
      }));
    return { nodes, edges };
  }, [domain, mapQuery.data]);
  const openConcept = async (_event: unknown, node: Node) => {
    const concept = await queryClient.ensureQueryData(conceptQueryOptions(node.id));
    setSelected(concept);
    const url = new URL(window.location.href);
    url.searchParams.set('concept', node.id);
    window.history.replaceState({}, '', url);
  };
  useEffect(() => {
    const conceptId = new URLSearchParams(window.location.search).get('concept');
    if (!conceptId) return;
    void queryClient.ensureQueryData(conceptQueryOptions(conceptId)).then(setSelected);
  }, [queryClient]);
  const studyNow = async () => {
    const concept = selected?.concept as { id?: string } | undefined;
    const response = await apiFetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ focusConceptId: concept?.id, budgetMinutes: 30 }),
    });
    const session = await response.json();
    if (response.ok) window.location.href = `/session/${session.id}`;
  };
  const concept = selected?.concept as
    | { id?: string; title?: string; description?: string; status?: string }
    | undefined;
  const hasLesson = selected?.lessonAvailable === true;
  const mastery = selected?.mastery as
    | Array<{
        dimension: string;
        state: string;
        inferred?: boolean;
        attempts?: Array<{
          exerciseId: string;
          correct: number;
          credit: number;
          hintsUsed: number;
          mode: string;
          createdAt: string;
        }>;
      }>
    | undefined;
  const selectedDomain = domain ?? mapQuery.data.currentWeekDomain;
  useEffect(() => {
    if (concept?.id && concept.title) {
      tutorSidebar.setContext({
        conceptId: concept.id,
        conceptTitle: concept.title,
        page: 'map',
        pageLabel: `Map · ${concept.title}`,
        allowed: true,
        enabled: false,
      });
    } else {
      tutorSidebar.setContext({
        page: 'map',
        pageLabel: 'Knowledge map',
        allowed: true,
        enabled: false,
      });
    }
    return () => tutorSidebar.clearContext();
  }, [concept?.id, concept?.title, tutorSidebar]);
  return (
    <section className="space-y-5">
      <h1 className="sr-only">Knowledge map</h1>
      <div className="flex flex-wrap items-end justify-end gap-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Domain</span>
          <Select
            value={selectedDomain || 'all'}
            onValueChange={(value) => setDomain(value === 'all' ? null : value)}
          >
            <SelectTrigger aria-label="Domain">
              <SelectValue placeholder="All domains" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All domains</SelectItem>
              {mapQuery.data.domains.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <Card className="h-[560px]">
        <div className="h-full w-full">
          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            fitView
            fitViewOptions={{ padding: 0.18 }}
            minZoom={0.35}
            onNodeClick={openConcept}
          >
            <Background color="#e5e5e5" />
            <Controls />
          </ReactFlow>
        </div>
      </Card>
      <ul
        aria-label="Mastery legend"
        className="flex flex-wrap gap-3 text-xs text-muted-foreground"
      >
        {[
          { color: '#f5f5f5', label: 'Not assessed / introduced' },
          { color: '#fef3c7', label: 'Assisted' },
          { color: '#e0f2fe', label: 'Independent' },
          { color: '#dcfce7', label: 'Retained' },
          { color: '#e5e5e5', label: 'Not yet authored' },
          {
            color: '#ede9fe',
            label: 'Prerequisites not met',
            border: '2px dashed #7c3aed',
          },
        ].map(({ color, label, border }) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className="h-4 w-4 rounded border border-neutral-300"
              style={{ background: color, ...(border ? { border } : {}) }}
            />
            {label}
          </li>
        ))}
      </ul>
      {concept ? (
        <Card aria-label={`${concept.title} details`}>
          <CardContent className="space-y-5">
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold">{concept.title}</h2>
                  <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
                    {concept.description}
                  </p>
                  {concept.status === 'stub' ? (
                    <p className="mt-2 text-sm font-medium text-muted-foreground">
                      Not yet authored
                    </p>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Close"
                  onClick={() => {
                    setSelected(null);
                    const url = new URL(window.location.href);
                    url.searchParams.delete('concept');
                    window.history.replaceState({}, '', url);
                  }}
                >
                  <X aria-hidden="true" className="size-4" />
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {concept.id && hasLesson ? (
                  <Button asChild variant="outline" size="sm">
                    <a href={`/lessons/${encodeURIComponent(concept.id)}`}>View lesson</a>
                  </Button>
                ) : null}
                {concept.status !== 'stub' ? (
                  <Button type="button" size="sm" onClick={studyNow}>
                    Study this now
                  </Button>
                ) : null}
              </div>
            </div>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Mastery</h3>
              <ul className="divide-y">
                {(mastery ?? []).map((record) => {
                  const dimension = record.dimension
                    .replaceAll('_', ' ')
                    .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
                  const state =
                    record.inferred || record.state === 'inferred'
                      ? 'Inferred'
                      : (masteryStateLabels[record.state] ?? record.state);
                  return (
                    <li
                      key={record.dimension}
                      className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0"
                    >
                      <span className="text-sm">{dimension}</span>
                      <span className="text-sm text-muted-foreground">{state}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Recent answers</h3>
              <ul className="divide-y">
                {(mastery ?? [])
                  .flatMap((record) => record.attempts ?? [])
                  .sort(
                    (first, second) =>
                      new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime(),
                  )
                  .slice(0, 5)
                  .map((attempt) => {
                    const correct = attempt.credit >= 1;
                    const result = correct
                      ? 'Correct'
                      : attempt.credit === 0
                        ? 'Incorrect'
                        : 'Partly correct';
                    const mode =
                      attempt.mode === 'practice'
                        ? 'Practice'
                        : attempt.mode === 'review'
                          ? 'Review'
                          : attempt.mode === 'assessment'
                            ? 'Assessment'
                            : attempt.mode;
                    return (
                      <li
                        key={`${attempt.exerciseId}-${attempt.createdAt}`}
                        className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
                      >
                        <div className="min-w-0">
                          <p className="font-medium">{concept.title}</p>
                          <p className="text-xs text-muted-foreground">{mode}</p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end text-right text-sm text-muted-foreground">
                          <span className={correct ? 'text-emerald-700 dark:text-emerald-300' : ''}>
                            {result}
                          </span>
                          <span>
                            {new Date(attempt.createdAt).toLocaleDateString(undefined, {
                              month: 'short',
                              day: 'numeric',
                            })}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                {!mastery?.some((record) => record.attempts?.length) ? (
                  <li className="py-2 text-sm text-muted-foreground">No answers yet.</li>
                ) : null}
              </ul>
            </section>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
