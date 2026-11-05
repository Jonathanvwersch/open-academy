import dagre from '@dagrejs/dagre';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Background, Controls, type Edge, type Node, ReactFlow } from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/ui/badge.js';
import { Button } from '@/ui/button.js';
import { Card, CardContent } from '@/ui/card.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select.js';
import { conceptQueryOptions, mapQueryOptions } from '../queries.js';
import { useTutorSidebar } from '../tutor/TutorSidebar.js';
import '@xyflow/react/dist/style.css';

export const Route = createFileRoute('/map')({
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
                <span className="text-[10px] text-neutral-500">
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
    const response = await fetch('/api/sessions', {
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
  const events = selected?.events as
    | Array<{
        dimension: string;
        fromState: string;
        toState: string;
        rule: string;
        createdAt: string;
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
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-neutral-500">Prerequisites and mastery</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Knowledge map</h1>
        </div>
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
      <Card className="h-[560px] p-0">
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
      <ul aria-label="Mastery legend" className="flex flex-wrap gap-3 text-xs text-neutral-700">
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
          <CardContent className="space-y-4 p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold">{concept.title}</h2>
                <p className="mt-1 max-w-[70ch] text-sm text-neutral-600">{concept.description}</p>
                {concept.status === 'stub' ? (
                  <p className="mt-2 text-sm font-medium text-neutral-500">Not yet authored</p>
                ) : null}
              </div>
              <div className="flex gap-2">
                {concept.id && hasLesson ? (
                  <Button asChild variant="outline" size="sm">
                    <a href={`/lessons/${encodeURIComponent(concept.id)}`}>View lesson</a>
                  </Button>
                ) : null}
                {concept.status !== 'stub' ? (
                  <Button type="button" onClick={studyNow}>
                    Study this now
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setSelected(null);
                    const url = new URL(window.location.href);
                    url.searchParams.delete('concept');
                    window.history.replaceState({}, '', url);
                  }}
                >
                  Close
                </Button>
              </div>
            </div>
            <h3 className="mt-5 text-sm font-semibold">Mastery by dimension</h3>
            <ul className="mt-2 flex flex-wrap gap-2">
              {(mastery ?? []).map((record) => (
                <li key={record.dimension}>
                  <Badge variant="secondary">
                    {record.dimension}: {record.inferred ? 'inferred' : record.state}
                  </Badge>
                </li>
              ))}
            </ul>
            <h3 className="mt-5 text-sm font-semibold">Mastery history</h3>
            <ul className="mt-2 space-y-2 text-sm text-neutral-600">
              {(mastery ?? []).flatMap((record) =>
                (record.attempts ?? []).map((attempt) => (
                  <li key={`${record.dimension}-${attempt.exerciseId}-${attempt.createdAt}`}>
                    {record.dimension}: {attempt.exerciseId} · {attempt.correct} correct ·{' '}
                    {attempt.credit} credit · {attempt.hintsUsed} hints · {attempt.mode} ·{' '}
                    {new Date(attempt.createdAt).toLocaleDateString()}
                  </li>
                )),
              )}
              {!mastery?.some((record) => record.attempts?.length) ? (
                <li>No attempt evidence recorded yet.</li>
              ) : null}
            </ul>
            <h3 className="mt-5 text-sm font-semibold">Mastery events</h3>
            <ul className="mt-2 space-y-2 text-sm text-neutral-600">
              {(events ?? []).map((event) => (
                <li key={`${event.dimension}-${event.createdAt}-${event.rule}`}>
                  {event.dimension}: {event.fromState} → {event.toState} · {event.rule} ·{' '}
                  {new Date(event.createdAt).toLocaleDateString()}
                </li>
              ))}
              {!events?.length ? <li>No recorded mastery events yet.</li> : null}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
