import { useMemo, useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';
import { t, type MessageKey } from '../i18n';
import { buildGraph, COLUMNS, components, type Column, type Graph, type TopologyInput } from '../topology';
import { Empty, ErrorBanner, Spinner } from './ui';

interface Props {
  ctx: string;
  ns: string;
  available: Set<string> | null;
  filter: string;
  refreshMs: number;
  onOpen: (kindName: string, name: string, ns?: string) => void;
}

const SOURCES: Array<[keyof TopologyInput, string]> = [
  ['services', 'services'],
  ['ingresses', 'ingresses.networking.k8s.io'],
  ['ingressRoutes', 'ingressroutes.traefik.io'],
  ['deployments', 'deployments.apps'],
  ['statefulSets', 'statefulsets.apps'],
  ['daemonSets', 'daemonsets.apps'],
  ['jobs', 'jobs.batch'],
  ['replicaSets', 'replicasets.apps'],
  ['pods', 'pods'],
];

const COLUMN_LABEL: Record<Column, MessageKey> = {
  entry: 'map.colEntry',
  service: 'map.colServices',
  workload: 'map.colWorkloads',
  pod: 'map.colPods',
  config: 'map.colConfig',
};

const CARD_W = 220;
const CARD_H = 46;
const ROW_H = 56;
const GAP_X = 70;
const BAND_GAP = 26;
const PAD = 12;
const LARGE_GRAPH = 700;

export function RelationMap({ ctx, ns, available, filter, refreshMs, onOpen }: Props) {
  const interval = refreshMs ? Math.max(refreshMs, 15_000) : 0;
  const { data, error, reload } = useAsync(async () => {
    const input = Object.fromEntries(SOURCES.map(([k]) => [k, [] as any[]])) as unknown as TopologyInput;
    const sources = SOURCES.filter(([, type]) => !available || available.has(type));
    const results = await Promise.allSettled(
      sources.map(async ([k, type]) => {
        input[k] = (await api.list(ctx, type, ns)).items;
      }),
    );
    // Pods are essential; everything else is best-effort (RBAC may hide some kinds).
    const podsFailed = results.find((r, i) => r.status === 'rejected' && sources[i][0] === 'pods');
    if (podsFailed && podsFailed.status === 'rejected') throw podsFailed.reason;
    return { graph: buildGraph(input), partial: results.some((r) => r.status === 'rejected') };
  }, [ctx, ns, available ? [...available].join() : ''], interval);

  if (error) return <ErrorBanner error={error} onRetry={reload} />;
  if (!data) return <div className="pad"><Spinner /></div>;
  return <MapView graph={data.graph} partial={data.partial} filter={filter} onOpen={onOpen} />;
}

function MapView({ graph, partial, filter, onOpen }: { graph: Graph; partial: boolean; filter: string; onOpen: Props['onOpen'] }) {
  const [hover, setHover] = useState<string | null>(null);

  const adjacency = useMemo(() => {
    const out = new Map<string, string[]>();
    const inc = new Map<string, string[]>();
    for (const [a, b] of graph.edges) {
      out.set(a, [...(out.get(a) ?? []), b]);
      inc.set(b, [...(inc.get(b) ?? []), a]);
    }
    return { out, inc };
  }, [graph]);

  const layout = useMemo(() => {
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const groups = components(graph).filter((ids) =>
      !terms.length || ids.some((id) => {
        const n = graph.nodes.get(id)!;
        const hay = `${n.kind} ${n.name} ${n.ns ?? ''} ${n.sub}`.toLowerCase();
        return terms.every((term) => hay.includes(term));
      }),
    );
    const pos = new Map<string, { x: number; y: number }>();
    const bands: Array<{ y: number; h: number }> = [];
    let y = PAD;
    for (const ids of groups) {
      const perColumn = COLUMNS.map((c) => ids.filter((id) => graph.nodes.get(id)!.column === c));
      const rows = Math.max(...perColumn.map((l) => l.length));
      const bandH = rows * ROW_H;
      perColumn.forEach((list, ci) => {
        const offset = ((rows - list.length) * ROW_H) / 2;
        list
          .sort((a, b) => graph.nodes.get(a)!.name.localeCompare(graph.nodes.get(b)!.name))
          .forEach((id, ri) => pos.set(id, { x: PAD + ci * (CARD_W + GAP_X), y: y + offset + ri * ROW_H }));
      });
      bands.push({ y: y - BAND_GAP / 2 + 4, h: bandH + BAND_GAP - 8 });
      y += bandH + BAND_GAP;
    }
    return { pos, bands, height: y, width: PAD * 2 + COLUMNS.length * CARD_W + (COLUMNS.length - 1) * GAP_X };
  }, [graph, filter]);

  // Everything upstream and downstream of the hovered card.
  const lit = useMemo(() => {
    if (!hover) return null;
    const seen = new Set<string>([hover]);
    const walk = (start: string, dir: Map<string, string[]>) => {
      const stack = [start];
      while (stack.length) {
        for (const next of dir.get(stack.pop()!) ?? []) {
          if (!seen.has(next)) {
            seen.add(next);
            stack.push(next);
          }
        }
      }
    };
    walk(hover, adjacency.out);
    walk(hover, adjacency.inc);
    return seen;
  }, [hover, adjacency]);

  if (graph.nodes.size === 0) return <Empty title={t('map.empty')} />;
  if (layout.pos.size === 0) return <Empty title={t('table.noMatch')} />;

  return (
    <div className="map-wrap">
      {(partial || graph.nodes.size > LARGE_GRAPH) && (
        <div className="callout callout-muted small map-note">
          {partial && t('map.partial')} {graph.nodes.size > LARGE_GRAPH && t('map.large')}
        </div>
      )}
      <div className="map-scroll">
        <div className="map-head" style={{ width: layout.width }}>
          {COLUMNS.map((c, i) => (
            <div key={c} className="map-col-label" style={{ left: PAD + i * (CARD_W + GAP_X), width: CARD_W }}>{t(COLUMN_LABEL[c])}</div>
          ))}
        </div>
        <div className="map-canvas" style={{ width: layout.width, height: layout.height }}>
          {layout.bands.map((b, i) => (
            <div key={i} className={`map-band${i % 2 ? ' alt' : ''}`} style={{ top: b.y, height: b.h }} />
          ))}
          <svg className="map-edges" width={layout.width} height={layout.height} aria-hidden="true">
            {graph.edges.map(([a, b]) => {
              const pa = layout.pos.get(a);
              const pb = layout.pos.get(b);
              if (!pa || !pb) return null;
              const x1 = pa.x + CARD_W;
              const y1 = pa.y + CARD_H / 2;
              const x2 = pb.x;
              const y2 = pb.y + CARD_H / 2;
              const dx = Math.max(30, (x2 - x1) / 2);
              const on = lit ? lit.has(a) && lit.has(b) : false;
              return (
                <path
                  key={`${a}>${b}`}
                  d={`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`}
                  className={`edge${on ? ' on' : lit ? ' dim' : ''}`}
                />
              );
            })}
          </svg>
          {[...layout.pos].map(([id, p]) => {
            const n = graph.nodes.get(id)!;
            return (
              <button
                key={id}
                className={`map-card tone-${n.tone}${lit ? (lit.has(id) ? ' on' : ' dim') : ''}${n.openable ? '' : ' static'}`}
                style={{ left: p.x, top: p.y, width: CARD_W, height: CARD_H }}
                onMouseEnter={() => setHover(id)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(id)}
                onBlur={() => setHover(null)}
                onClick={() => n.openable && onOpen(n.kind, n.name, n.ns)}
                title={`${n.kind}/${n.name}${n.ns ? `\n${n.ns}` : ''}\n${n.sub}`}
              >
                <span className="map-kind">{shortKind(n.kind)}</span>
                <span className="map-text">
                  <span className="map-name">{n.name}</span>
                  <span className="map-sub">{n.sub}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const SHORT: Record<string, string> = {
  Ingress: 'ING', IngressRoute: 'IR', Service: 'SVC', Deployment: 'DEP', StatefulSet: 'STS', DaemonSet: 'DS',
  Job: 'JOB', Pod: 'POD', ConfigMap: 'CM', Secret: 'SEC', PersistentVolumeClaim: 'PVC',
};

function shortKind(kind: string): string {
  return SHORT[kind] ?? kind.slice(0, 3).toUpperCase();
}
