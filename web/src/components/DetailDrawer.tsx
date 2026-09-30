import { useEffect, useState } from 'react';
import { api } from '../api';
import { HELM_TYPE, type ActionName, type Kind } from '../catalog';
import { age } from '../format';
import { useAsync } from '../hooks';
import { getLanguage, t, type MessageKey } from '../i18n';
import { CodeBlock } from './CodeBlock';
import { LogViewer } from './LogViewer';
import { Overview } from './Overview';
import { SecretView } from './SecretView';
import { Badge, CopyButton, Empty, ErrorBanner, Icon, Spinner } from './ui';

export interface Target {
  kind: Kind;
  name: string;
  ns?: string;
  /** Row data from the list, used for Helm releases. */
  row?: any;
}

interface Props {
  ctx: string;
  target: Target;
  refreshMs: number;
  onClose: () => void;
  onNavigate: (kindName: string, name: string, ns?: string) => void;
  onAction: (action: ActionName, target: Target, obj: any) => void;
}

const ACTION_META: Record<ActionName, { label: MessageKey; icon: string; danger?: boolean }> = {
  restart: { label: 'action.restart', icon: 'restart' },
  scale: { label: 'action.scale', icon: 'scale' },
  delete: { label: 'action.delete', icon: 'trash', danger: true },
  reconcile: { label: 'action.reconcile', icon: 'sync' },
  suspend: { label: 'action.suspend', icon: 'suspend' },
  resume: { label: 'action.resume', icon: 'resume' },
};

export function DetailDrawer(props: Props) {
  const { target, onClose } = props;
  const isHelm = target.kind.type === HELM_TYPE;

  return (
    <aside className="drawer" aria-label={t('drawer.label')}>
      <header className="drawer-head">
        <div className="drawer-title">
          <span className="tag">{target.kind.kind}</span>
          <h2 title={target.name}>{target.name}</h2>
          {target.ns && <span className="muted">{t('drawer.in', { ns: target.ns })}</span>}
          <CopyButton text={target.name} label="" />
        </div>
        <button className="btn btn-ghost" onClick={onClose} title={t('drawer.close')}><Icon name="close" /></button>
      </header>
      {isHelm ? <HelmDetail {...props} /> : <ResourceDetail {...props} />}
    </aside>
  );
}

type Tab = 'overview' | 'logs' | 'secret' | 'describe' | 'yaml' | 'events';

function ResourceDetail({ ctx, target, refreshMs, onNavigate, onAction }: Props) {
  const { kind, name, ns } = target;
  const obj = useAsync(() => api.object(ctx, kind.type, name, ns), [ctx, kind.type, name, ns], refreshMs);
  const tabs: Array<[Tab, MessageKey]> = [
    ['overview', 'tab.overview'],
    ...(kind.logs ? [['logs', 'tab.logs'] as [Tab, MessageKey]] : []),
    ...(kind.type === 'secrets' ? [['secret', 'tab.values'] as [Tab, MessageKey]] : []),
    ['describe', 'tab.describe'],
    ['yaml', 'tab.yaml'],
    ['events', 'tab.events'],
  ];
  const [tab, setTab] = useState<Tab>('overview');
  useEffect(() => setTab('overview'), [ctx, kind.type, name, ns]);

  const data = obj.data;
  const suspended = data?.spec?.suspend === true;
  const actions = (kind.actions ?? []).filter((a) => (a === 'suspend' ? !suspended : a === 'resume' ? suspended : true));

  return (
    <>
      <div className="drawer-bar">
        <nav className="tabs">
          {tabs.map(([id, label]) => (
            <button key={id} className={`tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>{t(label)}</button>
          ))}
        </nav>
        <div className="drawer-actions">
          {actions.map((a) => (
            <button
              key={a}
              className={`btn btn-sm${ACTION_META[a].danger ? ' btn-danger' : ''}`}
              disabled={!data}
              onClick={() => onAction(a, target, data)}
            >
              <Icon name={ACTION_META[a].icon} /> {t(ACTION_META[a].label)}
            </button>
          ))}
        </div>
      </div>
      <div className={`drawer-body${tab === 'logs' ? ' no-pad' : ''}`}>
        {tab === 'overview' && (
          obj.error ? <ErrorBanner error={obj.error} onRetry={obj.reload} />
            : !data ? <Spinner />
              : <Overview obj={data} onNavigate={onNavigate} />
        )}
        {tab === 'logs' && data && (
          <LogViewer ctx={ctx} ns={ns ?? ''} type={kind.type} name={name} containers={containersOf(data)} />
        )}
        {tab === 'secret' && <SecretView ctx={ctx} ns={ns ?? ''} name={name} />}
        {tab === 'describe' && <TextTab load={() => api.describe(ctx, kind.type, name, ns)} deps={[ctx, kind.type, name, ns]} />}
        {tab === 'yaml' && <TextTab load={() => api.yaml(ctx, kind.type, name, ns)} deps={[ctx, kind.type, name, ns]} yaml />}
        {tab === 'events' && <EventsTab ctx={ctx} kind={kind.kind} name={name} ns={ns} />}
      </div>
    </>
  );
}

function containersOf(obj: any): string[] {
  const spec = obj.kind === 'Pod' ? obj.spec : obj.spec?.template?.spec;
  return [...(spec?.containers ?? []), ...(spec?.initContainers ?? [])].map((c: any) => c.name);
}

function TextTab({ load, deps, yaml }: { load: () => Promise<{ text: string }>; deps: unknown[]; yaml?: boolean }) {
  const { data, error, loading, reload } = useAsync(load, deps);
  if (error) return <ErrorBanner error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  return (
    <CodeBlock
      text={data.text}
      language={yaml ? 'yaml' : 'text'}
      toolbar={<button className="btn btn-ghost btn-sm" onClick={reload} title={t('common.reload')}>{loading ? <Spinner small /> : <Icon name="refresh" />}</button>}
    />
  );
}

function EventsTab({ ctx, kind, name, ns }: { ctx: string; kind: string; name: string; ns?: string }) {
  const { data, error, reload } = useAsync(() => api.events(ctx, kind, name, ns), [ctx, kind, name, ns], 5000);
  if (error) return <ErrorBanner error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  if (data.length === 0) return <Empty title={t('events.empty')}>{t('events.emptyBody')}</Empty>;
  return (
    <table className="mini events">
      <thead><tr><th>{t('col.when')}</th><th>{t('col.type')}</th><th>{t('col.reason')}</th><th>{t('col.message')}</th><th>{t('col.count')}</th></tr></thead>
      <tbody>
        {data.map((e: any) => (
          <tr key={e.metadata?.uid}>
            <td className="nowrap muted">{age(e.lastTimestamp || e.eventTime || e.metadata?.creationTimestamp)}</td>
            <td><Badge tone={e.type === 'Warning' ? 'warn' : 'muted'}>{e.type}</Badge></td>
            <td className="nowrap">{e.reason}</td>
            <td className="wrap-cell">{e.message}</td>
            <td>{e.count ?? 1}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type HelmTab = 'status' | 'values' | 'values-all' | 'history' | 'manifest' | 'notes';

function HelmDetail({ ctx, target }: Props) {
  const [tab, setTab] = useState<HelmTab>('status');
  const ns = target.ns ?? target.row?.namespace ?? '';
  const tabs: Array<[HelmTab, MessageKey]> = [
    ['status', 'tab.status'],
    ['values', 'tab.helmValues'],
    ['values-all', 'tab.helmValuesAll'],
    ['history', 'tab.history'],
    ['manifest', 'tab.manifest'],
    ['notes', 'tab.notes'],
  ];
  return (
    <>
      <div className="drawer-bar">
        <nav className="tabs">
          {tabs.map(([id, label]) => (
            <button key={id} className={`tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>{t(label)}</button>
          ))}
        </nav>
      </div>
      <div className="drawer-body">
        {tab === 'history'
          ? <HelmHistory ctx={ctx} ns={ns} name={target.name} />
          : <TextTab
              key={tab}
              load={() => api.helmDetail(ctx, ns, target.name, tab)}
              deps={[ctx, ns, target.name, tab]}
              yaml={tab !== 'status' && tab !== 'notes'}
            />}
      </div>
    </>
  );
}

function HelmHistory({ ctx, ns, name }: { ctx: string; ns: string; name: string }) {
  const { data, error, reload } = useAsync(() => api.helmDetail(ctx, ns, name, 'history'), [ctx, ns, name]);
  if (error) return <ErrorBanner error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  let rows: any[] = [];
  try { rows = JSON.parse(data.text).reverse(); } catch { /* shown empty */ }
  return (
    <table className="mini">
      <thead><tr><th>{t('col.revision')}</th><th>{t('col.updated')}</th><th>{t('col.status')}</th><th>{t('col.chart')}</th><th>{t('col.app')}</th><th>{t('col.description')}</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.revision}>
            <td>{r.revision}</td>
            <td className="nowrap">{new Date(r.updated).toLocaleString(getLanguage())}</td>
            <td><Badge tone={r.status === 'deployed' ? 'ok' : r.status === 'failed' ? 'err' : 'muted'}>{r.status}</Badge></td>
            <td><code>{r.chart}</code></td>
            <td><code>{r.app_version}</code></td>
            <td className="wrap-cell">{r.description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
