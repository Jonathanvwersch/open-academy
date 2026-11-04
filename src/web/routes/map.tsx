import dagre from '@dagrejs/dagre';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Background, Controls, type Edge, type Node, ReactFlow } from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';
import '@xyflow/react/dist/style.css';

export const Route = createFileRoute('/map')({
  component: MapPage,
});

interface MapNode {
  id: string;
  title: string;
  domain: string;
  status: string;
  available: boolean;
  dimensions: Record<string, { state: string; inferred?: boolean }>;
}

function MapPage() {
  const [domain, setDomain] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const mapQuery = useQuery({
    queryKey: ['map', domain],
    queryFn: async () => {
      const filter = domain === null ? '' : `?domain=${domain || 'all'}`;
      const response = await fetch(`/api/map${filter}`);
      return response.json() as Promise<{
        nodes: MapNode[];
        edges: Array<{ conceptId: string; prerequisiteId: string }>;
        domains: Array<{ id: string; title: string }>;
        currentWeekDomain: string;
      }>;
    },
  });
  const graph = useMemo(() => {
    const data = mapQuery.data;
    if (!data) return { nodes: [] as Node[], edges: [] as Edge[] };
    const layout = new dagre.graphlib.Graph();
    layout.setGraph({ rankdir: 'TB', nodesep: 36, ranksep: 70 });
    layout.setDefaultEdgeLabel(() => ({}));
    for (const node of data.nodes) layout.setNode(node.id, { width: 190, height: 64 });
    for (const edge of data.edges) layout.setEdge(edge.prerequisiteId, edge.conceptId);
    dagre.layout(layout);
    const visible = data.nodes;
    const visibleIds = new Set(visible.map((node) => node.id));
    const nodes = visible.map((node) => {
      const position = layout.node(node.id);
      const states = Object.values(node.dimensions).map((item) => item.state);
      const color =
        node.status === 'stub'
          ? '#e5e5e5'
          : states.includes('retained')
            ? '#dcfce7'
            : states.includes('independent')
              ? '#e0f2fe'
              : states.includes('assisted')
                ? '#fef3c7'
                : '#f5f5f5';
      return {
        id: node.id,
        position: { x: position.x - 95, y: position.y - 32 },
        data: { label: node.status === 'stub' ? `${node.title} · Not yet authored` : node.title },
        style: {
          width: 190,
          borderRadius: 10,
          border: node.available ? '1px solid #a3a3a3' : '1px dashed #a3a3a3',
          background: color,
          opacity: node.available ? 1 : 0.62,
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
  }, [mapQuery.data]);
  const openConcept = async (_event: unknown, node: Node) => {
    const response = await fetch(`/api/concepts/${node.id}`);
    if (response.ok) {
      setSelected(await response.json());
      const url = new URL(window.location.href);
      url.searchParams.set('concept', node.id);
      window.history.replaceState({}, '', url);
    }
  };
  useEffect(() => {
    const conceptId = new URLSearchParams(window.location.search).get('concept');
    if (!conceptId) return;
    void fetch(`/api/concepts/${conceptId}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data) setSelected(data);
      });
  }, []);
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
  const selectedDomain = domain ?? mapQuery.data?.currentWeekDomain ?? '';
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-neutral-500">Prerequisites and mastery</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Knowledge map</h1>
        </div>
        <label className="text-sm text-neutral-600">
          Domain
          <select
            value={selectedDomain}
            onChange={(event) => setDomain(event.target.value)}
            className="ml-2 rounded-md border border-neutral-300 bg-white px-3 py-2"
          >
            <option value="">All domains</option>
            {(mapQuery.data?.domains ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="h-[560px] rounded-xl border border-neutral-200 bg-white">
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
      <ul aria-label="Mastery legend" className="flex flex-wrap gap-3 text-xs text-neutral-700">
        {[
          ['#f5f5f5', 'Not assessed / introduced'],
          ['#fef3c7', 'Assisted'],
          ['#e0f2fe', 'Independent'],
          ['#dcfce7', 'Retained'],
          ['#e5e5e5', 'Not yet authored'],
        ].map(([color, label]) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className="h-4 w-4 rounded border border-neutral-300"
              style={{ background: color }}
            />
            {label}
          </li>
        ))}
      </ul>
      {concept ? (
        <aside
          className="rounded-xl border border-neutral-200 bg-white p-6"
          aria-label={`${concept.title} details`}
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">{concept.title}</h2>
              <p className="mt-1 max-w-[70ch] text-sm text-neutral-600">{concept.description}</p>
              {concept.status === 'stub' ? (
                <p className="mt-2 text-sm font-medium text-neutral-500">Not yet authored</p>
              ) : null}
            </div>
            <div className="flex gap-2">
              {concept.status !== 'stub' ? (
                <button
                  type="button"
                  onClick={studyNow}
                  className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white"
                >
                  Study this now
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setSelected(null);
                  const url = new URL(window.location.href);
                  url.searchParams.delete('concept');
                  window.history.replaceState({}, '', url);
                }}
                className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
              >
                Close
              </button>
            </div>
          </div>
          <h3 className="mt-5 text-sm font-semibold">Mastery by dimension</h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {(mastery ?? []).map((record) => (
              <li key={record.dimension} className="rounded-full bg-neutral-100 px-3 py-1 text-sm">
                {record.dimension}: {record.inferred ? 'inferred' : record.state}
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
        </aside>
      ) : null}
    </section>
  );
}
