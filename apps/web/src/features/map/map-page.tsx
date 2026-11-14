import type { StudyMapPayload } from '@academy/contracts/course';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Controls,
  Handle,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  useStore,
} from '@xyflow/react';
import { Popover } from 'radix-ui';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { topicStatusClasses, topicStatusLabels } from '../../components/topic-status.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent } from '../../components/ui/card.js';
import { emphasizeStudyMap } from './emphasis.js';
import { type GroupNode, type GroupTitleNode, layoutStudyMap, type TopicNode } from './layout.js';
import { studyMapQueryOptions } from './queries.js';
import { initialMapViewport, mapFitViewOptions } from './viewport.js';
import '@xyflow/react/dist/style.css';
import './map.css';

type Topic = StudyMapPayload['nodes'][number];
const topicLabel = (topic: Topic) =>
  topic.placedOut ? 'Placed out' : topicStatusLabels[topic.status];
const canOpen = (topic: Topic) => topic.status !== 'locked' && topic.lessonAvailable;
const TopicFocusContext = createContext<((id: string | null) => void) | null>(null);

function TopicAction({ topic, graph = false }: { topic: Topic; graph?: boolean }) {
  const label = topicLabel(topic);
  const className = `nodrag nopan pointer-events-auto flex w-full min-w-0 flex-col items-start justify-center gap-2 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${graph ? `h-full border bg-card p-3 shadow-sm ${topic.status === 'locked' ? 'border-dashed text-muted-foreground' : 'border-border hover:border-primary/50'}` : 'px-1 py-3'}`;
  const children = (
    <>
      <span className="line-clamp-2 font-medium leading-5">{topic.title}</span>
      <Badge variant="secondary" className={`text-xs ${topicStatusClasses(topic.status)}`}>
        {label}
      </Badge>
    </>
  );
  if (canOpen(topic))
    return (
      <Link
        to="/lessons/$conceptId"
        params={{ conceptId: topic.id }}
        search={{ from: undefined }}
        aria-label={`${topic.title}: ${label}`}
        className={className}
        onKeyDown={(event) => {
          if (event.key === ' ') {
            event.preventDefault();
            event.currentTarget.click();
          }
        }}
      >
        {children}
      </Link>
    );
  if (topic.status === 'locked')
    return (
      <Popover.Root>
        <Popover.Trigger asChild>
          <button type="button" aria-label={`${topic.title}: ${label}`} className={className}>
            {children}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            sideOffset={8}
            className="z-50 max-w-72 rounded-lg border bg-popover p-4 text-sm text-popover-foreground shadow-md"
          >
            <p className="font-medium">Needs:</p>
            <ul className="mt-2 list-inside list-disc space-y-1">
              {topic.missingPrereqTitles.map((title) => (
                <li key={title}>{title}</li>
              ))}
            </ul>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    );
  return (
    <button
      type="button"
      aria-disabled="true"
      aria-label={`${topic.title}: ${label}; lesson unavailable`}
      className={className}
    >
      {children}
    </button>
  );
}

function TopicGraphNode({ id, data }: NodeProps<TopicNode>) {
  const setFocus = useContext(TopicFocusContext);
  return (
    <div
      className="h-full"
      onFocusCapture={() => setFocus?.(id)}
      onBlurCapture={() => setFocus?.(null)}
    >
      <Handle type="target" position={Position.Left} className="invisible" />
      <TopicAction topic={data} graph />
      <Handle type="source" position={Position.Right} className="invisible" />
    </div>
  );
}

function CourseGroupNode() {
  return <div className="h-full rounded-xl border border-border bg-muted/30" />;
}

function CourseGroupTitleNode({ data }: NodeProps<GroupTitleNode>) {
  return (
    <div className="h-full truncate text-lg font-semibold" data-map-title title={data.title}>
      {data.title}
    </div>
  );
}
const nodeTypes = {
  topic: TopicGraphNode,
  courseGroup: CourseGroupNode,
  groupTitle: CourseGroupTitleNode,
};

function MapViewport({ groups }: { groups: GroupNode[] }) {
  const initialized = useNodesInitialized({ includeHiddenNodes: true });
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const { setViewport } = useReactFlow();
  const positioned = useRef(false);
  useEffect(() => {
    if (!initialized || positioned.current) return;
    const viewport = initialMapViewport(groups, width, height);
    if (!viewport) return;
    positioned.current = true;
    void setViewport(viewport);
  }, [groups, height, initialized, setViewport, width]);
  return <Controls showInteractive={false} fitViewOptions={mapFitViewOptions} />;
}

function GroupNavigation({ groups }: { groups: GroupNode[] }) {
  const { fitBounds } = useReactFlow();
  const initialized = useNodesInitialized({ includeHiddenNodes: true });
  return (
    <nav aria-label="Jump to group" className="flex flex-wrap gap-2 px-4 sm:px-6">
      {groups.map((group) => (
        <Button
          key={group.id}
          type="button"
          variant="outline"
          size="sm"
          disabled={!initialized}
          onClick={() =>
            void fitBounds(
              {
                ...group.position,
                width: Number(group.style?.width),
                height: Number(group.style?.height),
              },
              { padding: 0.1, duration: 400 },
            )
          }
        >
          {group.data.title}
        </Button>
      ))}
    </nav>
  );
}

function StatusLegend({ className }: { className: string }) {
  return (
    <ul aria-label="Topic status legend" className={className}>
      {(['complete', 'in_progress', 'quiz', 'not_started', 'locked'] as const).map((status) => (
        <li key={status}>
          <Badge variant="secondary" className={`text-[10px] ${topicStatusClasses(status)}`}>
            {topicStatusLabels[status]}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function MapKey() {
  return (
    <div className="flex justify-end px-2 py-1">
      <StatusLegend className="hidden flex-nowrap gap-1 rounded-lg border border-border bg-card p-1 sm:flex" />
      <div className="sm:hidden">
        <Popover.Root>
          <Popover.Trigger asChild>
            <Button type="button" variant="outline" size="sm" className="bg-card">
              Key
            </Button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              aria-label="Map key"
              align="end"
              sideOffset={8}
              collisionPadding={8}
              className="z-50 max-w-72 rounded-lg border border-border bg-card p-2 shadow-md"
            >
              <StatusLegend className="flex flex-wrap gap-1" />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
    </div>
  );
}

export function MapPage() {
  const { data } = useSuspenseQuery(studyMapQueryOptions());
  const graph = useMemo(() => (data.nodes.length ? layoutStudyMap(data) : null), [data]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const emphasized = useMemo(
    () => (graph ? emphasizeStudyMap(graph, hovered ?? focused) : null),
    [graph, hovered, focused],
  );
  const touchOrigin = useRef<{ x: number; y: number } | null>(null);
  if (!graph || !emphasized)
    return (
      <section className="space-y-3 px-4 sm:px-6">
        <h1 className="sr-only">Map</h1>
        <p>Add a course to see your map.</p>
        <Link to="/courses" className="text-sm text-primary underline-offset-4 hover:underline">
          Browse courses
        </Link>
      </section>
    );
  return (
    <section className="space-y-5">
      <h1 className="sr-only">Map</h1>
      <ReactFlowProvider>
        <div className="grid h-[calc(100dvh-5.5rem)] min-h-min grid-rows-[auto_minmax(560px,1fr)] gap-3 md:h-[calc(100dvh-2rem)]">
          <GroupNavigation groups={graph.nodes.filter((node) => node.type === 'courseGroup')} />
          <section
            aria-label="Study map graph"
            className="study-map relative grid min-h-[560px] w-full grid-rows-[auto_minmax(0,1fr)] border-y border-border"
            onTouchStartCapture={(event) => {
              const touch = event.touches[0];
              touchOrigin.current =
                event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY } : null;
            }}
            onTouchMoveCapture={(event) => {
              const touch = event.touches[0];
              const origin = touchOrigin.current;
              if (
                event.touches.length === 1 &&
                touch &&
                origin &&
                Math.abs(touch.clientY - origin.y) > Math.abs(touch.clientX - origin.x)
              )
                event.stopPropagation();
            }}
          >
            <MapKey />
            <TopicFocusContext.Provider value={setFocused}>
              <ReactFlow
                nodes={emphasized.nodes}
                edges={emphasized.edges}
                nodeTypes={nodeTypes}
                onNodeMouseEnter={(_, node) => {
                  if (node.type === 'topic') setHovered(node.id);
                }}
                onNodeMouseLeave={() => setHovered(null)}
                fitViewOptions={mapFitViewOptions}
                minZoom={0.01}
                maxZoom={1}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                zIndexMode="manual"
                defaultEdgeOptions={{ zIndex: 1 }}
              >
                <MapViewport groups={graph.nodes.filter((node) => node.type === 'courseGroup')} />
              </ReactFlow>
            </TopicFocusContext.Provider>
          </section>
        </div>
      </ReactFlowProvider>
      <div className="grid gap-4 px-4 sm:px-6 md:grid-cols-2">
        {data.groups.map((group) => (
          <Card key={group.id}>
            <CardContent>
              <h2 className="font-semibold">{group.title}</h2>
              <ul className="mt-2 divide-y">
                {data.nodes
                  .filter((topic) => topic.groupId === group.id)
                  .map((topic) => (
                    <li key={topic.id}>
                      <TopicAction topic={topic} />
                    </li>
                  ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
