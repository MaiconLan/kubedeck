import { useState, type ReactNode } from 'react';
import { kindByName } from '../catalog';
import { age, dateTime, podStatus, readyState, type Tone } from '../format';
import { t } from '../i18n';
import { Badge } from './ui';

interface Props {
  obj: any;
  onNavigate: (kindName: string, name: string, ns?: string) => void;
}

export function Overview({ obj, onNavigate }: Props) {
  const md = obj.metadata ?? {};
  const ready = readyState(obj);
  const conditions: any[] = obj.status?.conditions ?? [];

  return (
    <div className="overview">
      <section className="facts">
        <Fact label={t('ov.kind')}>{obj.kind}</Fact>
        {md.namespace && <Fact label="Namespace">{md.namespace}</Fact>}
        <Fact label={t('ov.created')}>{dateTime(md.creationTimestamp)} <span className="muted">({age(md.creationTimestamp)})</span></Fact>
        {obj.kind === 'Pod' && <Fact label={t('ov.status')}><Badge tone={podStatus(obj).tone}>{podStatus(obj).text}</Badge></Fact>}
        {obj.kind !== 'Pod' && ready.text !== '—' && <Fact label={t('ov.status')}><Badge tone={ready.tone} title={ready.message}>{ready.text}</Badge></Fact>}
        {obj.kind === 'Pod' && <Fact label={t('ov.node')}>{obj.spec?.nodeName}</Fact>}
        {obj.kind === 'Pod' && <Fact label={t('ov.ip')}>{obj.status?.podIP}</Fact>}
        {obj.spec?.replicas !== undefined && (
          <Fact label={t('ov.replicas')}>{t('ov.replicasValue', { ready: obj.status?.readyReplicas ?? 0, total: obj.spec.replicas })}</Fact>
        )}
        {obj.status?.lastAppliedRevision && <Fact label={t('ov.appliedRevision')}><code>{obj.status.lastAppliedRevision}</code></Fact>}
        {obj.status?.lastHandledReconcileAt && <Fact label={t('ov.lastReconcile')}>{dateTime(obj.status.lastHandledReconcileAt)}</Fact>}
        {obj.status?.artifact?.revision && <Fact label={t('ov.artifact')}><code>{obj.status.artifact.revision}</code></Fact>}
        {md.ownerReferences?.length > 0 && (
          <Fact label={t('ov.owner')}>
            {md.ownerReferences.map((o: any) => (
              kindByName(o.kind)
                ? <button key={o.uid} className="link" onClick={() => onNavigate(o.kind, o.name, md.namespace)}>{o.kind}/{o.name}</button>
                : <span key={o.uid}>{o.kind}/{o.name}</span>
            ))}
          </Fact>
        )}
      </section>

      {ready.message && ready.tone !== 'ok' && <div className={`callout callout-${ready.tone}`}>{ready.message}</div>}

      {obj.kind === 'Pod' && <PodContainers pod={obj} />}
      {obj.spec?.template?.spec?.containers && <TemplateContainers spec={obj.spec.template.spec} />}

      {conditions.length > 0 && (
        <section>
          <h4>{t('ov.conditions')}</h4>
          <table className="mini">
            <thead><tr><th>{t('col.type')}</th><th>{t('col.status')}</th><th>{t('col.reason')}</th><th>{t('col.message')}</th><th>{t('col.when')}</th></tr></thead>
            <tbody>
              {conditions.map((c) => (
                <tr key={c.type}>
                  <td>{c.type}</td>
                  <td><Badge tone={conditionTone(c)}>{c.status}</Badge></td>
                  <td>{c.reason}</td>
                  <td className="wrap-cell">{c.message}</td>
                  <td className="nowrap muted">{age(c.lastTransitionTime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <KeyValues title={t('ov.labels')} values={md.labels} />
      <KeyValues title={t('ov.annotations')} values={md.annotations} collapsed />
    </div>
  );
}

function conditionTone(c: any): Tone {
  const negative = /Pressure|Unavailable|Stalled|Reconciling/.test(c.type);
  if (c.status === 'True') return negative ? 'warn' : 'ok';
  if (c.status === 'False') return negative ? 'ok' : 'err';
  return 'warn';
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fact">
      <div className="fact-label">{label}</div>
      <div className="fact-value">{children}</div>
    </div>
  );
}

function PodContainers({ pod }: { pod: any }) {
  const statuses = new Map<string, any>(
    [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])].map((s: any) => [s.name, s]),
  );
  const all = [
    ...(pod.spec?.initContainers ?? []).map((c: any) => ({ ...c, init: true })),
    ...(pod.spec?.containers ?? []),
  ];
  return (
    <section>
      <h4>{t('ov.containers')}</h4>
      <div className="containers">
        {all.map((c: any) => {
          const s = statuses.get(c.name) ?? {};
          const [stateName, stateInfo] = Object.entries(s.state ?? {})[0] ?? ['unknown', {}];
          const info = stateInfo as any;
          const tone: Tone = stateName === 'running' ? (s.ready ? 'ok' : 'warn') : stateName === 'waiting' ? 'warn' : info?.exitCode === 0 ? 'muted' : 'err';
          const last = s.lastState?.terminated;
          return (
            <div key={c.name} className="container-card">
              <div className="container-head">
                <strong>{c.name}</strong>
                {c.init && <span className="tag">init</span>}
                <Badge tone={tone}>{info?.reason ?? stateName}</Badge>
                <span className="muted small">restarts: {s.restartCount ?? 0}</span>
              </div>
              <code className="small">{c.image}</code>
              {info?.message && <div className="small err-text">{info.message}</div>}
              {last && (
                <div className="small muted">
                  {t('ov.lastTermination', { reason: last.reason ?? '', code: last.exitCode ?? '', age: age(last.finishedAt) })}
                </div>
              )}
              <Resources c={c} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TemplateContainers({ spec }: { spec: any }) {
  return (
    <section>
      <h4>{t('ov.templateContainers')}</h4>
      <div className="containers">
        {spec.containers.map((c: any) => (
          <div key={c.name} className="container-card">
            <div className="container-head"><strong>{c.name}</strong></div>
            <code className="small">{c.image}</code>
            {c.ports?.length > 0 && (
              <div className="small muted">{t('ov.ports', { ports: c.ports.map((p: any) => `${p.containerPort}/${p.protocol ?? 'TCP'}${p.name ? ` (${p.name})` : ''}`).join(', ') })}</div>
            )}
            <Resources c={c} />
          </div>
        ))}
      </div>
    </section>
  );
}

function Resources({ c }: { c: any }) {
  const r = c.resources ?? {};
  if (!r.requests && !r.limits) return null;
  const fmt = (x: any) => (x ? `cpu ${x.cpu ?? '—'} · mem ${x.memory ?? '—'}` : '—');
  return <div className="small muted">{t('ov.resources', { requests: fmt(r.requests), limits: fmt(r.limits) })}</div>;
}

function KeyValues({ title, values, collapsed }: { title: string; values?: Record<string, string>; collapsed?: boolean }) {
  const [open, setOpen] = useState(!collapsed);
  const entries = Object.entries(values ?? {});
  if (!entries.length) return null;
  return (
    <section>
      <h4 className="clickable" onClick={() => setOpen(!open)}>
        {title} <span className="muted">({entries.length})</span> <span className="muted small">{open ? '▾' : '▸'}</span>
      </h4>
      {open && (
        <div className="kv">
          {entries.map(([k, v]) => (
            <div key={k} className="kv-row"><span className="kv-k">{k}</span><span className="kv-v">{v}</span></div>
          ))}
        </div>
      )}
    </section>
  );
}
