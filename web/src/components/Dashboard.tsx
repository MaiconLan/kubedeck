import { useMemo } from 'react';
import { api, errorMessage, type ApiError, type DashboardData, type Part } from '../api';
import { age, bytes, condition, cores, percent, podStatus, readyState, restarts, ts, type Tone } from '../format';
import { useAsync } from '../hooks';
import { t } from '../i18n';
import { Badge, Empty, ErrorBanner, Icon, Spinner } from './ui';

interface Props {
  ctx: string;
  ns: string;
  refreshMs: number;
  onOpen: (kindName: string, name: string, ns?: string) => void;
}

interface Problem {
  tone: Tone;
  kind: string;
  name: string;
  ns?: string;
  reason: string;
  detail: string;
}

export function Dashboard({ ctx, ns, refreshMs, onOpen }: Props) {
  // The dashboard runs several kubectl calls; poll it less often than tables.
  const interval = refreshMs ? Math.max(refreshMs, 10_000) : 0;
  const { data, error, reload } = useAsync(() => api.dashboard(ctx, ns), [ctx, ns], interval);

  if (error) return <ErrorBanner error={error} onRetry={reload} />;
  if (!data) return <div className="pad"><Spinner /></div>;
  return <DashboardView data={data} onOpen={onOpen} />;
}

function DashboardView({ data, onOpen }: { data: DashboardData; onOpen: Props['onOpen'] }) {
  const nodes = data.nodes.ok ? data.nodes.data : [];
  const pods = data.pods.ok ? data.pods.data : [];
  const nodeUsage = new Map((data.nodeMetrics.ok ? data.nodeMetrics.data : []).map((m) => [m.name, m]));
  const metricsOk = data.nodeMetrics.ok;

  // Requests per node are only complete when every namespace is loaded.
  const requestsByNode = useMemo(() => {
    const map = new Map<string, { cpu: number; memory: number }>();
    if (!data.allNamespaces) return map;
    for (const p of pods) {
      if (!p.spec?.nodeName || ['Succeeded', 'Failed'].includes(p.status?.phase)) continue;
      const acc = map.get(p.spec.nodeName) ?? { cpu: 0, memory: 0 };
      acc.cpu += p.requests?.cpu ?? 0;
      acc.memory += p.requests?.memory ?? 0;
      map.set(p.spec.nodeName, acc);
    }
    return map;
  }, [pods, data.allNamespaces]);

  const totals = useMemo(() => {
    const sum = { allocCpu: 0, allocMem: 0, useCpu: 0, useMem: 0, reqCpu: 0, reqMem: 0 };
    for (const n of nodes) {
      sum.allocCpu += n.allocatable.cpu;
      sum.allocMem += n.allocatable.memory;
      sum.useCpu += nodeUsage.get(n.name)?.cpu ?? 0;
      sum.useMem += nodeUsage.get(n.name)?.memory ?? 0;
      sum.reqCpu += requestsByNode.get(n.name)?.cpu ?? 0;
      sum.reqMem += requestsByNode.get(n.name)?.memory ?? 0;
    }
    return sum;
  }, [nodes, nodeUsage, requestsByNode]);

  const podBuckets = useMemo(() => {
    const b = { ok: 0, warn: 0, err: 0, done: 0 };
    for (const p of pods) {
      const s = podStatus(p);
      if (s.tone === 'ok') b.ok++;
      else if (s.tone === 'err') b.err++;
      else if (s.tone === 'muted') b.done++;
      else b.warn++;
    }
    return b;
  }, [pods]);

  const workloads = data.workloads.ok ? data.workloads.data : [];
  const unhealthyWorkloads = workloads.filter((w) => workloadTone(w) !== 'ok');
  const flux = data.flux?.ok ? data.flux.data : [];
  const fluxReady = flux.filter((f) => readyState(f).tone === 'ok').length;
  const readyNodes = nodes.filter((n) => condition({ status: { conditions: n.conditions } }, 'Ready')?.status === 'True').length;

  const problems = useMemo(() => findProblems(pods, workloads, flux), [pods, workloads, flux]);

  return (
    <div className="dash">
      <div className="dash-meta muted small">
        {data.version.ok && data.version.data && <span>Kubernetes {data.version.data}</span>}
        <span>{data.allNamespaces ? t('content.allNamespaces') : t('dash.scopeNamespace')}</span>
      </div>

      <div className="tiles">
        <Tile
          label={t('dash.nodes')} part={data.nodes} tone={readyNodes === nodes.length ? 'ok' : 'err'}
          value={`${readyNodes}/${nodes.length}`} unit={t('dash.ready')}
          segments={[{ tone: 'ok', n: readyNodes, label: t('dash.ready') }, { tone: 'err', n: nodes.length - readyNodes, label: 'NotReady' }]}
        />
        <Tile
          label={t('dash.pods')} part={data.pods} tone={podBuckets.err ? 'err' : podBuckets.warn ? 'warn' : 'ok'}
          value={String(pods.length)}
          segments={[
            { tone: 'ok', n: podBuckets.ok, label: t('dash.healthy') },
            { tone: 'warn', n: podBuckets.warn, label: t('dash.pending') },
            { tone: 'err', n: podBuckets.err, label: t('dash.failing') },
            { tone: 'muted', n: podBuckets.done, label: t('dash.completed'), hideWhenZero: true },
          ]}
          legend
        />
        <Tile
          label={t('dash.workloads')} part={data.workloads} tone={unhealthyWorkloads.length ? 'warn' : 'ok'}
          value={`${workloads.length - unhealthyWorkloads.length}/${workloads.length}`} unit={t('dash.healthy')}
          segments={[
            { tone: 'ok', n: workloads.length - unhealthyWorkloads.length, label: t('dash.healthy') },
            { tone: 'warn', n: unhealthyWorkloads.length, label: t('dash.unhealthy') },
          ]}
        />
        {data.flux && (
          <Tile
            label="Flux" part={data.flux} tone={fluxReady === flux.length ? 'ok' : 'err'}
            value={`${fluxReady}/${flux.length}`} unit={t('dash.ready')}
            segments={[{ tone: 'ok', n: fluxReady, label: t('dash.ready') }, { tone: 'err', n: flux.length - fluxReady, label: t('dash.failing') }]}
          />
        )}
      </div>

      <div className="dash-grid">
        <section className="card">
          <h3>{t('dash.clusterUsage')}</h3>
          {!metricsOk && <MetricsNote error={(data.nodeMetrics as { error: ApiError }).error} />}
          {data.nodes.ok ? (
            <div className="usage">
              <UsageRow label="CPU" used={metricsOk ? totals.useCpu : undefined} requested={data.allNamespaces ? totals.reqCpu : undefined}
                total={totals.allocCpu} fmt={(v) => cores(v)} unit={t('dash.cores')} />
              <UsageRow label={t('dash.memory')} used={metricsOk ? totals.useMem : undefined} requested={data.allNamespaces ? totals.reqMem : undefined}
                total={totals.allocMem} fmt={bytes} />
              <Legend showRequests={data.allNamespaces} />
            </div>
          ) : <PartError part={data.nodes} />}
        </section>

        <section className="card">
          <h3>{t('dash.problems')} {problems.length > 0 && <span className="count">{problems.length}</span>}</h3>
          {problems.length === 0 ? (
            <div className="all-good"><Icon name="check" /> {t('dash.noProblems')}</div>
          ) : (
            <div className="problems">
              {problems.slice(0, 40).map((p) => (
                <button key={`${p.kind}/${p.ns}/${p.name}`} className="problem" onClick={() => onOpen(p.kind, p.name, p.ns)}>
                  <Badge tone={p.tone}>{p.reason}</Badge>
                  <span className="problem-name">
                    <span className="muted">{p.kind}/</span>{p.name}
                    {p.ns && <span className="muted small"> · {p.ns}</span>}
                  </span>
                  {p.detail && <span className="problem-detail muted small" title={p.detail}>{p.detail}</span>}
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="card">
        <h3>{t('dash.nodes')}</h3>
        {data.nodes.ok ? (
          <table className="mini nodes-table">
            <thead>
              <tr>
                <th>{t('col.name')}</th><th>{t('col.status')}</th><th className="meter-col">CPU</th>
                <th className="meter-col">{t('dash.memory')}</th><th className="right">{t('dash.pods')}</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => {
                const use = nodeUsage.get(n.name);
                const req = data.allNamespaces ? requestsByNode.get(n.name) : undefined;
                const ready = condition({ status: { conditions: n.conditions } }, 'Ready')?.status === 'True';
                const podCount = pods.filter((p) => p.spec?.nodeName === n.name).length;
                return (
                  <tr key={n.name} className="clickable-row" onClick={() => onOpen('Node', n.name)}>
                    <td>{n.name}</td>
                    <td><Badge tone={ready ? (n.unschedulable ? 'warn' : 'ok') : 'err'}>{ready ? (n.unschedulable ? 'Cordoned' : 'Ready') : 'NotReady'}</Badge></td>
                    <td><Meter used={use?.cpu} requested={req?.cpu} total={n.allocatable.cpu} text={(v) => cores(v)} /></td>
                    <td><Meter used={use?.memory} requested={req?.memory} total={n.allocatable.memory} text={bytes} /></td>
                    <td className="right">{podCount}{data.allNamespaces ? <span className="muted">/{n.allocatable.pods}</span> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <PartError part={data.nodes} />}
      </section>

      <div className="dash-grid">
        <TopPods title={t('dash.topCpu')} part={data.podMetrics} pods={pods} metric="cpu" fmt={(v) => cores(v)} onOpen={onOpen} />
        <TopPods title={t('dash.topMemory')} part={data.podMetrics} pods={pods} metric="memory" fmt={bytes} onOpen={onOpen} />
      </div>

      <section className="card">
        <h3>{t('dash.warnings')}</h3>
        {data.warnings.ok ? (
          data.warnings.data.length === 0 ? <div className="all-good"><Icon name="check" /> {t('dash.noWarnings')}</div> : (
            <table className="mini">
              <thead><tr><th>{t('col.lastSeen')}</th><th>{t('col.reason')}</th><th>{t('col.object')}</th><th>{t('col.message')}</th></tr></thead>
              <tbody>
                {data.warnings.data.map((e) => (
                  <tr key={e.uid} className="clickable-row" onClick={() => onOpen(e.involvedObject.kind, e.involvedObject.name, e.involvedObject.namespace)}>
                    <td className="nowrap muted">{age(e.lastTimestamp)}</td>
                    <td className="nowrap"><Badge tone="warn">{e.reason}</Badge></td>
                    <td className="nowrap mono">{e.involvedObject.kind?.toLowerCase()}/{e.involvedObject.name}</td>
                    <td className="wrap-cell">{e.message}{e.count > 1 && <span className="muted"> (×{e.count})</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : <PartError part={data.warnings} />}
      </section>
    </div>
  );
}

interface Segment {
  tone: Tone;
  n: number;
  label: string;
  hideWhenZero?: boolean;
}

function Tile(props: { label: string; value: string; unit?: string; tone?: Tone; part: Part<unknown>; segments: Segment[]; legend?: boolean }) {
  const { label, value, unit, tone, part, segments, legend } = props;
  const shown = segments.filter((s) => !(s.hideWhenZero && s.n === 0));
  return (
    <div className={`tile${tone ? ` tile-${tone}` : ''}`}>
      <div className="tile-head">
        <span className="tile-dot" />
        <span className="tile-label">{label}</span>
      </div>
      {part.ok ? (
        <>
          <div className="tile-main">
            <span className="tile-value">{value}</span>
            {unit && <span className="tile-unit">{unit}</span>}
          </div>
          <div className="tile-bar">
            {shown.filter((s) => s.n > 0).map((s) => <span key={s.label} className={`seg-${s.tone}`} style={{ flex: s.n }} title={`${s.n} ${s.label}`} />)}
          </div>
          {legend && (
            <div className="tile-split tile-sub">
              {shown.map((s) => <Count key={s.label} tone={s.tone} n={s.n} label={s.label} />)}
            </div>
          )}
        </>
      ) : <div className="tile-sub muted" title={errorMessage(part.error)}>{t('dash.unavailable')}</div>}
    </div>
  );
}

function Count({ tone, n, label }: { tone: Tone; n: number; label: string }) {
  return <span className={`count-dot dot-${tone}`} title={label}><i /><span className="n">{n}</span> {label}</span>;
}

function PartError({ part }: { part: Part<unknown> | null }) {
  if (!part || part.ok) return null;
  return <ErrorBanner error={part.error} compact />;
}

function MetricsNote({ error }: { error: ApiError }) {
  return <div className="callout callout-muted small" title={errorMessage(error)}>{t('dash.noMetrics')}</div>;
}

function UsageRow(props: { label: string; used?: number; requested?: number; total: number; fmt: (v: number) => string; unit?: string }) {
  const { label, used, requested, total, fmt, unit } = props;
  const main = used ?? requested;
  return (
    <div className="usage-row">
      <div className="usage-head">
        <span className="usage-label">{label}</span>
        <span className="usage-value">
          <strong>{main !== undefined ? fmt(main) : '—'}</strong>
          <span className="muted"> / {fmt(total)}{unit ? ` ${unit}` : ''}</span>
        </span>
      </div>
      <Meter used={used} requested={requested} total={total} text={fmt} big />
      <div className="usage-foot muted small">
        {used !== undefined && <span>{t('dash.used', { pct: percent(used, total) })}</span>}
        {requested !== undefined && <span>{t('dash.requested', { pct: percent(requested, total) })}</span>}
      </div>
    </div>
  );
}

function Legend({ showRequests }: { showRequests: boolean }) {
  return (
    <div className="meter-legend muted small">
      <span><i className="lg-used" /> {t('dash.legendUsed')}</span>
      {showRequests && <span><i className="lg-req" /> {t('dash.legendRequested')}</span>}
      <span><i className="lg-free" /> {t('dash.legendAllocatable')}</span>
    </div>
  );
}

/** Usage bar over allocatable capacity, with a tick for the sum of requests. */
function Meter({ used, requested, total, text, big }: { used?: number; requested?: number; total: number; text: (v: number) => string; big?: boolean }) {
  const usedPct = used !== undefined ? Math.min(100, percent(used, total)) : undefined;
  const reqPct = requested !== undefined ? Math.min(100, percent(requested, total)) : undefined;
  const tone = usedPct === undefined ? '' : usedPct >= 90 ? ' hot' : usedPct >= 75 ? ' warm' : '';
  const title = [
    used !== undefined ? `${t('dash.legendUsed')}: ${text(used)} (${usedPct}%)` : '',
    requested !== undefined ? `${t('dash.legendRequested')}: ${text(requested)} (${percent(requested, total)}%)` : '',
    `${t('dash.legendAllocatable')}: ${text(total)}`,
  ].filter(Boolean).join('\n');
  return (
    <div className={`meter${big ? ' meter-big' : ''}`} title={title}>
      <div className="meter-track">
        {usedPct !== undefined && <div className={`meter-fill${tone}`} style={{ width: `${usedPct}%` }} />}
        {reqPct !== undefined && <div className="meter-req" style={{ left: `${reqPct}%` }} />}
      </div>
      {!big && <span className="meter-text">{usedPct !== undefined ? `${usedPct}%` : reqPct !== undefined ? t('dash.reqShort', { pct: reqPct }) : '—'}</span>}
    </div>
  );
}

function TopPods(props: {
  title: string;
  part: DashboardData['podMetrics'];
  pods: any[];
  metric: 'cpu' | 'memory';
  fmt: (v: number) => string;
  onOpen: Props['onOpen'];
}) {
  const { title, part, pods, metric, fmt, onOpen } = props;
  if (!part.ok) {
    return <section className="card"><h3>{title}</h3><MetricsNote error={part.error} /></section>;
  }
  const requests = new Map(pods.map((p) => [`${p.metadata.namespace}/${p.metadata.name}`, p.requests]));
  const top = [...part.data].sort((a, b) => b[metric] - a[metric]).slice(0, 8);
  const max = top[0]?.[metric] || 1;
  return (
    <section className="card">
      <h3>{title}</h3>
      {top.length === 0 ? <Empty title={t('dash.noData')} /> : (
        <div className="bars">
          {top.map((p) => {
            const req = requests.get(`${p.namespace}/${p.name}`)?.[metric] ?? 0;
            return (
              <button key={`${p.namespace}/${p.name}`} className="bar-row" onClick={() => onOpen('Pod', p.name, p.namespace)}
                title={`${p.namespace}/${p.name}\n${fmt(p[metric])}${req ? ` · ${t('dash.ofRequest', { pct: percent(p[metric], req) })}` : ''}`}>
                <span className="bar-name">{p.name}<span className="muted small"> · {p.namespace}</span></span>
                <span className="bar-track"><span className="bar-fill" style={{ width: `${Math.max(2, (p[metric] / max) * 100)}%` }} /></span>
                <span className="bar-value">{fmt(p[metric])}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function workloadTone(w: any): Tone {
  if (w.kind === 'DaemonSet') {
    const want = w.status?.desiredNumberScheduled ?? 0;
    const ready = w.status?.numberReady ?? 0;
    return ready >= want ? 'ok' : ready === 0 ? 'err' : 'warn';
  }
  const want = w.spec?.replicas ?? 0;
  const ready = w.status?.readyReplicas ?? 0;
  if (want === 0) return 'ok';
  return ready >= want ? 'ok' : ready === 0 ? 'err' : 'warn';
}

const STALE_MS = 2 * 60_000;

function findProblems(pods: any[], workloads: any[], flux: any[]): Problem[] {
  const out: Problem[] = [];
  for (const p of pods) {
    const s = podStatus(p);
    const old = Date.now() - ts(p.metadata?.creationTimestamp) > STALE_MS;
    const r = restarts(p);
    if (s.tone === 'err' || (s.tone === 'warn' && old)) {
      out.push({ tone: s.tone, kind: 'Pod', name: p.metadata.name, ns: p.metadata.namespace, reason: s.text, detail: waitingMessage(p) });
    } else if (r >= 5 && s.tone !== 'muted') {
      out.push({ tone: 'warn', kind: 'Pod', name: p.metadata.name, ns: p.metadata.namespace, reason: t('dash.restarts', { n: r }), detail: '' });
    }
  }
  for (const w of workloads) {
    const tone = workloadTone(w);
    if (tone === 'ok') continue;
    const ready = w.kind === 'DaemonSet' ? w.status?.numberReady ?? 0 : w.status?.readyReplicas ?? 0;
    const want = w.kind === 'DaemonSet' ? w.status?.desiredNumberScheduled ?? 0 : w.spec?.replicas ?? 0;
    out.push({ tone, kind: w.kind, name: w.metadata.name, ns: w.metadata.namespace, reason: t('dash.readyOf', { ready, want }), detail: '' });
  }
  for (const f of flux) {
    const r = readyState(f);
    if (r.tone === 'ok' || r.tone === 'muted') continue;
    out.push({ tone: r.tone, kind: f.kind, name: f.metadata.name, ns: f.metadata.namespace, reason: r.text, detail: r.message });
  }
  const rank: Record<Tone, number> = { err: 0, warn: 1, info: 2, muted: 3, ok: 4 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone] || a.name.localeCompare(b.name));
}

function waitingMessage(pod: any): string {
  for (const c of pod.status?.containerStatuses ?? []) {
    const m = c.state?.waiting?.message ?? c.state?.terminated?.message;
    if (m) return m;
  }
  return '';
}

