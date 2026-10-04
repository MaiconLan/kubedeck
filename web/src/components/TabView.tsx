import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ContextInfo, type PortForward, type Settings } from '../api';
import {
  BUILTIN_TYPES, DASHBOARD_TYPE, FEATURES, HELM_TYPE, KIND_BY_TYPE, MAP_TYPE, genericKind, isScreen, kindByName, kindLabel,
  type ActionName, type Kind,
} from '../catalog';
import { isTyping, useAsync, useKey } from '../hooks';
import { t } from '../i18n';
import type { Route, Tab } from '../tabs';
import { ActionDialog } from './ActionDialog';
import { Dashboard } from './Dashboard';
import { DetailDrawer, type Target } from './DetailDrawer';
import { ForwardDialog } from './PortForward';
import { RelationMap } from './RelationMap';
import { ResourceTable, rowKey } from './ResourceTable';
import { Empty, ErrorBanner, Icon, Spinner } from './ui';

export const ALL = '*';

/** Catalog entry for a type; unknown types (CRDs) use discovery, or a placeholder until it loads. */
export function kindForType(type: string, discovery?: Array<{ type: string; kind: string; name: string; shortNames: string[]; namespaced: boolean }>): Kind {
  const known = KIND_BY_TYPE.get(type);
  if (known) return known;
  const res = discovery?.find((r) => r.type === type);
  if (res) return genericKind(res);
  return genericKind({ type, kind: type.split('.')[0], name: type.split('.')[0], shortNames: [], namespaced: true });
}

interface Props {
  tab: Tab;
  /** Shown in its pane (hidden tabs keep their state and log streams, but stop polling). */
  visible: boolean;
  /** Receives keyboard shortcuts. */
  focused: boolean;
  contexts: ContextInfo[];
  settings: Settings;
  paused: boolean;
  save: (patch: Partial<Settings>) => void;
  onNavigate: (patch: Partial<Route>, opts?: { detail?: boolean; replace?: boolean }) => void;
  onBack: () => void;
  onForward: () => void;
  onOpenTab: (route: Route, detail: boolean) => void;
  onOpenWindow: (route: Route, detail: boolean) => void;
  onAddCluster: () => void;
  onToast: (text: string) => void;
  onVisit: (ctx: string, target: Target) => void;
  onForwardStarted: (fwd: PortForward) => void;
}

export function TabView(props: Props) {
  const { tab, visible, focused, contexts, settings, paused, save, onNavigate } = props;
  const { ctx, ns, type } = tab.route;
  const names = contexts.map((c) => c.name);
  const ctxInfo = contexts.find((c) => c.name === ctx);

  const [filter, setFilter] = useState('');
  const [dialog, setDialog] = useState<{ action: ActionName; target: Target; obj: any } | null>(null);
  const [forwardFor, setForwardFor] = useState<{ target: Target; obj: any } | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const isProtected = settings.protectedContexts.includes(ctx);
  const refreshMs = visible && !paused ? settings.refreshSeconds * 1000 : 0;

  // ---- data
  const namespaces = useAsync(() => api.namespaces(ctx), [ctx]);
  // Re-checked periodically (api.discovery is cached), so it recovers after the cluster was unreachable.
  const discovery = useAsync(() => api.discovery(ctx), [ctx], visible ? 60_000 : 0);
  const available = useMemo(() => {
    if (!discovery.data) return null;
    return new Set([...discovery.data.map((r) => r.type), ...BUILTIN_TYPES]);
  }, [discovery.data]);

  const kind = useMemo(() => kindForType(type, discovery.data), [type, discovery.data]);
  const target: Target | null = useMemo(
    () => (tab.route.target ? { kind: kindForType(tab.route.target.type, discovery.data), name: tab.route.target.name, ns: tab.route.target.ns } : null),
    [tab.route.target, discovery.data],
  );
  const screen = isScreen(kind);
  const showList = !screen && !tab.detail;

  const list = useAsync(
    async () => {
      if (!showList) return null;
      if (kind.type === HELM_TYPE) return { namespaced: true, items: await api.helmReleases(ctx, ns) };
      return api.list(ctx, kind.type, ns);
    },
    [ctx, kind.type, ns, showList],
    showList ? refreshMs : 0,
  );

  // A kind missing from this cluster (e.g. no Flux) falls back to the dashboard.
  useEffect(() => {
    if (!available || tab.detail) return;
    if (!available.has(kind.type)) onNavigate({ type: DASHBOARD_TYPE, target: undefined }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, kind.type, tab.detail]);

  // When namespaces cannot be listed, "all namespaces" will fail too: pick a concrete one.
  useEffect(() => {
    if (namespaces.data?.forbidden && ns === ALL) {
      onNavigate({ ns: ctxInfo?.namespace || settings.knownNamespaces[ctx]?.[0] || 'default' }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespaces.data, ns, ctx]);

  useEffect(() => setFilter(''), [ctx, type]);

  // ---- navigation
  const switchContext = (name: string) => {
    const info = contexts.find((c) => c.name === name);
    onNavigate({ ctx: name, ns: settings.lastNamespace[name] ?? info?.namespace ?? ALL, target: undefined }, { detail: false });
    save({ lastContext: name });
  };

  const switchNamespace = (value: string) => {
    onNavigate({ ns: value, target: tab.detail ? tab.route.target : undefined });
    save({ lastNamespace: { [ctx]: value } });
    if (namespaces.data?.forbidden && value !== ALL) {
      const known = settings.knownNamespaces[ctx] ?? [];
      if (!known.includes(value)) save({ knownNamespaces: { ...settings.knownNamespaces, [ctx]: [value, ...known].slice(0, 30) } });
    }
  };

  const routeFor = (k: Kind, name: string, targetNs?: string): Route => ({
    ctx, ns, type: k.type, target: { type: k.type, name, ns: targetNs },
  });

  const openTarget = (k: Kind, name: string, targetNs?: string, newTab = false) => {
    if (newTab) {
      props.onOpenTab(routeFor(k, name, targetNs), true);
      return;
    }
    // Overview screens keep their place and show the resource in a drawer.
    onNavigate({ type: screen && !tab.detail ? type : k.type, target: { type: k.type, name, ns: targetNs } });
    props.onVisit(ctx, { kind: k, name, ns: targetNs });
  };

  const openItem = (item: any, newTab: boolean) => {
    if (kind.type === HELM_TYPE) openTarget(kind, item.name, item.namespace, newTab);
    else openTarget(kind, item.metadata.name, item.metadata.namespace, newTab);
  };

  const navigateTo = (kindName: string, name: string, targetNs?: string) => {
    const k = kindByName(kindName);
    if (k) openTarget(k, name, targetNs);
  };

  const closeTarget = () => onNavigate({ target: undefined });

  const toggleProtected = () => {
    save({
      protectedContexts: isProtected ? settings.protectedContexts.filter((c) => c !== ctx) : [...settings.protectedContexts, ctx],
    });
  };

  useKey((e) => {
    if (!focused || document.querySelector('.modal-backdrop')) return;
    if (e.key === '/' && !isTyping(e) && !screen) {
      e.preventDefault();
      filterRef.current?.focus();
    } else if (e.key === 'Escape' && !isTyping(e) && target && !tab.detail) {
      closeTarget();
    }
  });

  const items = list.data?.items ?? [];
  const selectedKey = target
    ? items.map(rowKey).find((_, i) => (items[i].metadata?.name ?? items[i].name) === target.name)
    : undefined;

  const drawerProps = target && {
    ctx,
    target,
    refreshMs,
    onNavigate: navigateTo,
    onAction: (action: ActionName, tg: Target, obj: any) => setDialog({ action, target: tg, obj }),
    onForward: (tg: Target, obj: any) => setForwardFor({ target: tg, obj }),
    onOpenNewWindow: () => props.onOpenWindow(routeFor(target.kind, target.name, target.ns), true),
  };

  return (
    <div className="tab-view" style={visible ? undefined : { display: 'none' }}>
      <header className={`topbar${isProtected ? ' protected' : ''}`}>
        <div className="history-nav">
          <button className="btn btn-ghost btn-sm" onClick={props.onBack} disabled={!tab.back.length} title={t('topbar.back')}><Icon name="back" /></button>
          <button className="btn btn-ghost btn-sm" onClick={props.onForward} disabled={!tab.forward.length} title={t('topbar.forward')}><Icon name="forward" /></button>
        </div>

        <div className="picker" title={t('topbar.context')}>
          <label>ctx</label>
          <span className="picker-dot" />
          <select value={ctx} onChange={(e) => switchContext(e.target.value)} title={ctxInfo?.server}>
            {names.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <button
            className={`picker-btn${isProtected ? ' on' : ''}`}
            onClick={toggleProtected}
            title={isProtected ? t('topbar.protectedOn') : t('topbar.protectedOff')}
          >
            <Icon name={isProtected ? 'lock' : 'unlock'} size={14} />
            <span className="label">{isProtected ? t('btn.protected') : t('btn.protect')}</span>
          </button>
          <button className="picker-btn" onClick={props.onAddCluster} title={t('topbar.addCluster')}>
            <Icon name="plus" size={14} />
            <span className="label">{t('btn.addCluster')}</span>
          </button>
        </div>

        <div className="picker" title={t('topbar.namespace')}>
          <label>ns</label>
          {namespaces.data?.forbidden ? (
            <NamespaceInput id={`ns-${tab.id}`} value={ns} options={settings.knownNamespaces[ctx] ?? []} onCommit={switchNamespace} />
          ) : (
            <select value={ns} onChange={(e) => switchNamespace(e.target.value)} disabled={!namespaces.data && !namespaces.error}>
              <option value={ALL}>{t('topbar.allNamespaces')}</option>
              {(namespaces.data?.names ?? (ns !== ALL ? [ns] : [])).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          )}
        </div>

        {showList || kind.type === MAP_TYPE ? (
          <div className="search-box grow">
            <Icon name="search" size={14} />
            <input ref={filterRef} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('topbar.filter', { kind: kindLabel(kind).toLowerCase() })} />
            {filter
              ? <button className="btn btn-ghost btn-xs" onClick={() => setFilter('')}><Icon name="close" size={12} /></button>
              : <kbd>/</kbd>}
          </div>
        ) : <span className="spacer" />}

        {showList && (
          <button className="btn btn-ghost btn-sm" onClick={list.reload} title={t('topbar.refreshNow')}>
            {list.loading ? <Spinner small /> : <Icon name="refresh" size={15} />}
            <span className="label">{t('btn.refresh')}</span>
          </button>
        )}
      </header>

      <section className="content">
        {tab.detail && target ? (
          <div className="page-wrap">
            <div className="content-head">
              <div className="head-title">
                <button className="crumb crumb-link" onClick={() => onNavigate({ type: target.kind.type, target: undefined }, { detail: false })}>
                  {kindLabel(target.kind)}
                </button>
              </div>
              <span className="spacer" />
              <span className="muted small ctx-summary">{ctx}{target.ns ? ` · ${target.ns}` : ''}</span>
            </div>
            <div className="page-body">
              <DetailDrawer key={`${ctx}/${target.kind.type}/${target.ns}/${target.name}`} {...drawerProps!} variant="page" onClose={closeTarget} />
            </div>
          </div>
        ) : (
          <>
            <div className="content-head">
              <div className="head-title">
                <span className="crumb">{t(`section.${kind.section}`)}</span>
                <div className="head-line">
                  <h1>{kindLabel(kind)}</h1>
                  {showList && <span className="count">{list.data ? items.length : ''}</span>}
                  {kind.section === 'crds' && <span className="muted small">{kind.type}</span>}
                </div>
              </div>
              <span className="spacer" />
              <span className="muted small ctx-summary">
                {ctx} · {list.data?.namespaced === false ? t('content.clusterScoped') : ns === ALL ? t('content.allNamespaces') : ns}
              </span>
            </div>

            {kind.type === DASHBOARD_TYPE && (
              <div className="screen-scroll">
                <Dashboard ctx={ctx} ns={ns} refreshMs={refreshMs} onOpen={navigateTo} />
              </div>
            )}
            {FEATURES.relationMap && kind.type === MAP_TYPE && (
              <RelationMap ctx={ctx} ns={ns} available={available} filter={filter} refreshMs={refreshMs} onOpen={navigateTo} />
            )}

            {showList && (
              <>
                {discovery.error && discovery.error.kind === 'auth' && !list.error && <ErrorBanner error={discovery.error} onRetry={discovery.reload} />}
                {list.error && <ErrorBanner error={list.error} onRetry={() => { list.reload(); discovery.reload(); namespaces.reload(); }} />}

                {!list.data && !list.error && <div className="loading-rows">{Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton" />)}</div>}
                {list.data && items.length === 0 && (
                  <Empty title={t('content.emptyTitle', { kind: kindLabel(kind).toLowerCase() })}>
                    {ns !== ALL && list.data.namespaced ? t('content.emptyNamespace', { ns }) : null}
                  </Empty>
                )}
                {list.data && items.length > 0 && (
                  <ResourceTable
                    kind={kind}
                    items={items}
                    filter={filter}
                    showNamespace={ns === ALL}
                    selectedKey={selectedKey}
                    onOpen={openItem}
                  />
                )}
              </>
            )}
          </>
        )}
      </section>

      {target && !tab.detail && (
        <DetailDrawer
          key={`${ctx}/${target.kind.type}/${target.ns}/${target.name}`}
          {...drawerProps!}
          onClose={closeTarget}
          onOpenNewTab={() => props.onOpenTab(routeFor(target.kind, target.name, target.ns), true)}
        />
      )}

      {dialog && (
        <ActionDialog
          ctx={ctx}
          action={dialog.action}
          target={dialog.target}
          obj={dialog.obj}
          isProtected={isProtected}
          onClose={() => setDialog(null)}
          onDone={(message) => {
            const deleted = dialog.action === 'delete';
            setDialog(null);
            props.onToast(message);
            list.reload();
            if (deleted && !tab.detail) closeTarget();
          }}
        />
      )}

      {forwardFor && (
        <ForwardDialog
          ctx={ctx}
          target={forwardFor.target}
          obj={forwardFor.obj}
          onClose={() => setForwardFor(null)}
          onStarted={(fwd) => {
            setForwardFor(null);
            props.onForwardStarted(fwd);
          }}
        />
      )}
    </div>
  );
}

function NamespaceInput({ id, value, options, onCommit }: { id: string; value: string; options: string[]; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value === ALL ? '' : value);
  useEffect(() => setText(value === ALL ? '' : value), [value]);
  const commit = () => {
    const v = text.trim();
    if (v && v !== value) onCommit(v);
  };
  return (
    <>
      <input
        className="ns-input"
        list={id}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        placeholder="namespace"
        title={t('topbar.nsInputTitle')}
        spellCheck={false}
      />
      <datalist id={id}>{options.map((o) => <option key={o} value={o} />)}</datalist>
    </>
  );
}
