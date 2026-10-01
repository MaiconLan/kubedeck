import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ContextInfo, type PortForward, type Settings } from './api';
import {
  DASHBOARD_TYPE, HELM_TYPE, KIND_BY_TYPE, KINDS, MAP_TYPE, genericKind, isScreen, kindByName, kindLabel,
  type ActionName, type Kind,
} from './catalog';
import { ActionDialog } from './components/ActionDialog';
import { AddClusterDialog } from './components/AddClusterDialog';
import { CommandLog } from './components/CommandLog';
import { CommandPalette, type PaletteItem } from './components/CommandPalette';
import { Dashboard } from './components/Dashboard';
import { DetailDrawer, type Target } from './components/DetailDrawer';
import { ForwardDialog, ForwardsPanel } from './components/PortForward';
import { RelationMap } from './components/RelationMap';
import { ResourceTable, rowKey } from './components/ResourceTable';
import { ShortcutsHelp } from './components/ShortcutsHelp';
import { Sidebar } from './components/Sidebar';
import { Empty, ErrorBanner, Icon, Spinner } from './components/ui';
import { isTyping, useAsync, useKey } from './hooks';
import { detectLanguage, LANGUAGES, setLanguage, t, type Language } from './i18n';
import { buildHash, GO_KEYS, parseHash } from './route';

const ALL = '*';
const DEFAULT_KIND = KIND_BY_TYPE.get(DASHBOARD_TYPE)!;
const MAX_RECENT = 8;

export function App() {
  const [adding, setAdding] = useState(false);
  const boot = useAsync(async () => {
    const [settings, contexts] = await Promise.all([api.settings(), api.contexts()]);
    return { settings, contexts };
  }, []);
  if (boot.data?.settings.language) setLanguage(boot.data.settings.language);

  if (boot.error) {
    return <div className="boot"><ErrorBanner error={boot.error} onRetry={boot.reload} /></div>;
  }
  if (!boot.data) {
    return <div className="boot"><Spinner /> <span className="muted">{t('boot.readingKubeconfig')}</span></div>;
  }
  if (boot.data.contexts.contexts.length === 0) {
    return (
      <div className="boot">
        <Empty title={t('boot.noContexts')}>
          <p>{t('boot.noContextsBody')}</p>
          <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" /> {t('boot.addAks')}</button>
        </Empty>
        {adding && (
          <AddClusterDialog
            existingContexts={[]}
            onClose={() => setAdding(false)}
            onDone={async (context, protect) => {
              setAdding(false);
              await api.saveSettings({ lastContext: context, ...(protect ? { protectedContexts: [...boot.data!.settings.protectedContexts, context] } : {}) }).catch(() => {});
              boot.reload();
            }}
          />
        )}
      </div>
    );
  }
  return <Workspace initialSettings={boot.data.settings} contexts={boot.data.contexts.contexts} current={boot.data.contexts.current} />;
}

/** Catalog entry for a type; unknown types (CRDs) get a placeholder until discovery loads. */
function kindForType(type: string): Kind {
  return KIND_BY_TYPE.get(type) ?? genericKind({ type, kind: type.split('.')[0], name: type.split('.')[0], shortNames: [], namespaced: true });
}

type BottomPanel = 'commands' | 'forwards' | null;

function Workspace({ initialSettings, contexts: initialContexts, current }: { initialSettings: Settings; contexts: ContextInfo[]; current: string }) {
  const [settings, setSettings] = useState(initialSettings);
  const [contexts, setContexts] = useState(initialContexts);
  const names = contexts.map((c) => c.name);

  // The URL wins over saved preferences, so links and reloads land on the same screen.
  const initialRoute = useMemo(() => {
    const r = parseHash(window.location.hash);
    return r && names.includes(r.ctx) ? r : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [ctx, setCtx] = useState(() =>
    initialRoute?.ctx ?? (settings.lastContext && names.includes(settings.lastContext) ? settings.lastContext : current || names[0]),
  );
  const ctxInfo = contexts.find((c) => c.name === ctx);
  const [ns, setNs] = useState(() => initialRoute?.ns ?? settings.lastNamespace[ctx] ?? ctxInfo?.namespace ?? ALL);
  const [kind, setKind] = useState<Kind>(() => (initialRoute ? kindForType(initialRoute.type) : DEFAULT_KIND));
  const [target, setTarget] = useState<Target | null>(() =>
    initialRoute?.target ? { kind: kindForType(initialRoute.target.type), name: initialRoute.target.name, ns: initialRoute.target.ns } : null,
  );
  const [filter, setFilter] = useState('');
  const [paused, setPaused] = useState(false);
  const [dialog, setDialog] = useState<{ action: ActionName; target: Target; obj: any } | null>(null);
  const [forwardFor, setForwardFor] = useState<{ target: Target; obj: any } | null>(null);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [adding, setAdding] = useState(false);
  const [panel, setPanel] = useState<BottomPanel>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [recent, setRecent] = useState<Target[]>([]);
  const filterRef = useRef<HTMLInputElement>(null);
  const goPending = useRef(0);

  const language: Language = settings.language ?? detectLanguage();
  setLanguage(language);

  const isProtected = settings.protectedContexts.includes(ctx);
  const refreshMs = paused ? 0 : settings.refreshSeconds * 1000;
  const screen = isScreen(kind);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  const save = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch, lastNamespace: { ...s.lastNamespace, ...(patch.lastNamespace ?? {}) } }));
    api.saveSettings(patch).catch(() => { /* preferences are best-effort */ });
  }, []);

  // ---- data
  const namespaces = useAsync(() => api.namespaces(ctx), [ctx]);
  const discovery = useAsync(() => api.discovery(ctx), [ctx]);
  const available = useMemo(() => {
    if (!discovery.data) return null;
    return new Set([...discovery.data.map((r) => r.type), HELM_TYPE, DASHBOARD_TYPE, MAP_TYPE]);
  }, [discovery.data]);

  const list = useAsync(
    async () => {
      if (isScreen(kind)) return null;
      if (kind.type === HELM_TYPE) return { namespaced: true, items: await api.helmReleases(ctx, ns) };
      return api.list(ctx, kind.type, ns);
    },
    [ctx, kind.type, ns],
    screen ? 0 : refreshMs,
  );

  const forwards = useAsync(() => api.forwards(), [], 3000);
  const activeForwards = (forwards.data ?? []).filter((f) => f.status === 'active').length;
  const failedForwards = (forwards.data ?? []).some((f) => f.status === 'error');

  // A kind missing from this cluster (e.g. no Flux) falls back to the dashboard;
  // a CRD placeholder from the URL gets its real definition once discovery loads.
  useEffect(() => {
    if (!available || !discovery.data) return;
    if (kind.section === 'crds') {
      const res = discovery.data.find((r) => r.type === kind.type);
      if (res && res.kind !== kind.kind) setKind(genericKind(res));
      else if (!res) setKind(DEFAULT_KIND);
    } else if (!available.has(kind.type)) {
      setKind(DEFAULT_KIND);
    }
  }, [available, discovery.data, kind]);

  // When namespaces cannot be listed, "all namespaces" will fail too: pick a concrete one.
  useEffect(() => {
    if (namespaces.data?.forbidden && ns === ALL) setNs(ctxInfo?.namespace || settings.knownNamespaces[ctx]?.[0] || 'default');
  }, [namespaces.data, ns, ctx, ctxInfo, settings.knownNamespaces]);

  // ---- URL sync: every navigation becomes a history entry
  const firstSync = useRef(true);
  useEffect(() => {
    const hash = buildHash({ ctx, ns, type: kind.type, target: target ? { type: target.kind.type, ns: target.ns, name: target.name } : undefined });
    if (hash === window.location.hash) return;
    if (firstSync.current) window.history.replaceState(null, '', hash);
    else window.history.pushState(null, '', hash);
    firstSync.current = false;
  }, [ctx, ns, kind.type, target]);

  useEffect(() => {
    const onPop = () => {
      const r = parseHash(window.location.hash);
      if (!r || !names.includes(r.ctx)) return;
      setCtx(r.ctx);
      setNs(r.ns);
      setKind(kindForType(r.type));
      setTarget(r.target ? { kind: kindForType(r.target.type), name: r.target.name, ns: r.target.ns } : null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [names.join()]);

  // ---- navigation
  const openTarget = (next: Target | null) => {
    setTarget(next);
    if (next && next.kind.type !== HELM_TYPE) {
      setRecent((r) => [next, ...r.filter((x) => !(x.kind.type === next.kind.type && x.name === next.name && x.ns === next.ns))].slice(0, MAX_RECENT));
    }
  };

  const clusterAdded = async (name: string, protect: boolean) => {
    setAdding(false);
    let fresh = contexts;
    try {
      fresh = (await api.contexts()).contexts;
      setContexts(fresh);
    } catch {
      /* the list refreshes on next load */
    }
    if (protect && !settings.protectedContexts.includes(name)) {
      save({ protectedContexts: [...settings.protectedContexts, name] });
    }
    switchContext(name, fresh);
    showToast(t('content.clusterAdded', { name }));
  };

  const switchContext = (name: string, list = contexts) => {
    setCtx(name);
    setTarget(null);
    setFilter('');
    const info = list.find((c) => c.name === name);
    setNs(settings.lastNamespace[name] ?? info?.namespace ?? ALL);
    save({ lastContext: name });
  };

  const switchNamespace = (value: string) => {
    setNs(value);
    setTarget(null);
    save({ lastNamespace: { [ctx]: value } });
    if (namespaces.data?.forbidden && value !== ALL) {
      const known = settings.knownNamespaces[ctx] ?? [];
      if (!known.includes(value)) save({ knownNamespaces: { ...settings.knownNamespaces, [ctx]: [value, ...known].slice(0, 30) } });
    }
  };

  const selectKind = (k: Kind) => {
    setKind(k);
    setTarget(null);
    setFilter('');
  };

  const openItem = (item: any) => {
    if (kind.type === HELM_TYPE) openTarget({ kind, name: item.name, ns: item.namespace, row: item });
    else openTarget({ kind, name: item.metadata.name, ns: item.metadata.namespace });
  };

  /** Opens a resource by Kind name and switches the list to that kind (keeps screens in place). */
  const navigateTo = (kindName: string, name: string, targetNs?: string) => {
    const k = kindByName(kindName);
    if (!k) return;
    if (!screen) setKind(k);
    setFilter('');
    openTarget({ kind: k, name, ns: targetNs });
  };

  const toggleProtected = () => {
    const next = isProtected
      ? settings.protectedContexts.filter((c) => c !== ctx)
      : [...settings.protectedContexts, ctx];
    save({ protectedContexts: next });
  };

  const showToast = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast((x) => (x === text ? null : x)), 4000);
  };

  // ---- keyboard
  const modalOpen = !!(dialog || palette || help || adding || forwardFor);
  useKey((e) => {
    if (modalOpen) return;
    if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === ':' && !isTyping(e))) {
      e.preventDefault();
      setPalette(true);
      return;
    }
    if (isTyping(e)) {
      if (e.key === 'Escape') (e.target as HTMLElement).blur();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (Date.now() - goPending.current < 1200) {
      goPending.current = 0;
      if (e.key === 'f') return setPanel((p) => (p === 'forwards' ? null : 'forwards'));
      if (e.key === 'l') return setPanel((p) => (p === 'commands' ? null : 'commands'));
      const go = GO_KEYS.find((g) => g.key === e.key);
      const k = go && KIND_BY_TYPE.get(go.type);
      if (k && (!available || available.has(k.type))) selectKind(k);
      return;
    }
    if (e.key === 'g') goPending.current = Date.now();
    else if (e.key === '?') setHelp(true);
    else if (e.key === '/') {
      e.preventDefault();
      filterRef.current?.focus();
    } else if (e.key === 'Escape') {
      if (target) setTarget(null);
      else if (panel) setPanel(null);
    }
  });

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const recentItems: PaletteItem[] = recent.map((r) => ({
      id: `recent:${r.kind.type}/${r.ns}/${r.name}`,
      group: t('palette.recent'),
      label: `${r.kind.kind}/${r.name}`,
      hint: r.ns,
      keywords: ['recent', r.name.toLowerCase(), r.kind.kind.toLowerCase()],
      run: () => {
        if (!screen) setKind(r.kind);
        openTarget(r);
      },
    }));
    const kinds: PaletteItem[] = [
      ...KINDS.filter((k) => !available || available.has(k.type)),
      ...(discovery.data ?? []).filter((r) => !KIND_BY_TYPE.has(r.type) && r.verbs.includes('list') && r.group).map(genericKind),
    ].map((k) => ({
      id: `kind:${k.type}`,
      group: t(`section.${k.section}`),
      label: kindLabel(k),
      hint: k.short.join(', '),
      keywords: [...k.short, kindLabel(k).toLowerCase(), k.kind.toLowerCase(), k.type],
      run: () => selectKind(k),
    }));
    const ctxItems: PaletteItem[] = names.map((n) => ({
      id: `ctx:${n}`, group: t('palette.context'), label: n, keywords: ['ctx', 'context', n.toLowerCase()], run: () => switchContext(n),
    }));
    const nsList = namespaces.data?.forbidden ? settings.knownNamespaces[ctx] ?? [] : namespaces.data?.names ?? [];
    const nsItems: PaletteItem[] = [ALL, ...nsList].map((n) => ({
      id: `ns:${n}`, group: t('palette.namespace'), label: n === ALL ? t('palette.allNamespaces') : n,
      keywords: ['ns', 'namespace', n.toLowerCase()], run: () => switchNamespace(n),
    }));
    const tools: PaletteItem[] = [
      {
        id: 'add-aks', group: t('palette.context'), label: t('palette.addAks'),
        keywords: ['add', 'aks', 'azure', 'cluster', t('palette.addAks').toLowerCase()], run: () => setAdding(true),
      },
      {
        id: 'forwards', group: t('palette.tools'), label: t('pf.panelTitle'),
        keywords: ['pf', 'port', 'forward', t('pf.panelTitle').toLowerCase()], run: () => setPanel('forwards'),
      },
      {
        id: 'commands', group: t('palette.tools'), label: t('cmdlog.title'),
        keywords: ['log', 'commands', t('cmdlog.title').toLowerCase()], run: () => setPanel('commands'),
      },
      {
        id: 'help', group: t('palette.tools'), label: t('keys.title'),
        keywords: ['help', 'keys', 'shortcuts', t('keys.title').toLowerCase()], run: () => setHelp(true),
      },
    ];
    return [...recentItems, ...kinds, ...ctxItems, ...tools, ...nsItems];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, discovery.data, names.join(), namespaces.data, ctx, settings.knownNamespaces, language, recent, screen]);

  const items = list.data?.items ?? [];
  const showNamespaceCol = ns === ALL;
  const selectedKey = target
    ? items.map(rowKey).find((_, i) => (items[i].metadata?.name ?? items[i].name) === target.name)
    : undefined;

  return (
    <div className={`app${target ? ' with-drawer' : ''}`}>
      <Sidebar available={available} discovery={discovery.data ?? []} current={kind.type} onSelect={selectKind} />

      <main className="main">
        <header className={`topbar${isProtected ? ' protected' : ''}`}>
          <div className="history-nav">
            <button className="btn btn-ghost btn-sm" onClick={() => window.history.back()} title={t('topbar.back')}><Icon name="back" /></button>
            <button className="btn btn-ghost btn-sm" onClick={() => window.history.forward()} title={t('topbar.forward')}><Icon name="forward" /></button>
          </div>

          <div className="picker">
            <label>{t('topbar.context')}</label>
            <select value={ctx} onChange={(e) => switchContext(e.target.value)} title={ctxInfo?.server}>
              {names.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <button
              className={`btn btn-ghost btn-sm lock${isProtected ? ' on' : ''}`}
              onClick={toggleProtected}
              title={isProtected ? t('topbar.protectedOn') : t('topbar.protectedOff')}
            >
              <Icon name={isProtected ? 'lock' : 'unlock'} />
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setAdding(true)} title={t('topbar.addCluster')}>
              <Icon name="plus" />
            </button>
          </div>

          <div className="picker">
            <label>{t('topbar.namespace')}</label>
            {namespaces.data?.forbidden ? (
              <NamespaceInput value={ns} options={settings.knownNamespaces[ctx] ?? []} onCommit={switchNamespace} />
            ) : (
              <select value={ns} onChange={(e) => switchNamespace(e.target.value)} disabled={!namespaces.data && !namespaces.error}>
                <option value={ALL}>{t('topbar.allNamespaces')}</option>
                {(namespaces.data?.names ?? (ns !== ALL ? [ns] : [])).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            )}
          </div>

          {kind.type !== DASHBOARD_TYPE ? (
            <div className="search-box grow">
              <Icon name="search" size={14} />
              <input ref={filterRef} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('topbar.filter', { kind: kindLabel(kind).toLowerCase() })} />
              {filter && <button className="btn btn-ghost btn-xs" onClick={() => setFilter('')}><Icon name="close" size={12} /></button>}
            </div>
          ) : <span className="spacer" />}

          <button className="btn btn-ghost" onClick={() => setPalette(true)} title={t('topbar.goTo')}>
            <kbd>:</kbd>
          </button>
          <div className="refresh">
            <button className="btn btn-ghost btn-sm" onClick={() => setPaused(!paused)} title={paused ? t('topbar.resume') : t('topbar.pause')}>
              <Icon name={paused ? 'play' : 'pause'} />
            </button>
            <select
              value={settings.refreshSeconds}
              onChange={(e) => save({ refreshSeconds: Number(e.target.value) })}
              className="select-sm"
              title={t('topbar.interval')}
            >
              {[2, 5, 10, 30, 60].map((s) => <option key={s} value={s}>{s}s</option>)}
            </select>
            {!screen && (
              <button className="btn btn-ghost btn-sm" onClick={list.reload} title={t('topbar.refreshNow')}>
                {list.loading ? <Spinner small /> : <Icon name="refresh" />}
              </button>
            )}
          </div>
          <button
            className={`btn btn-ghost badge-btn${panel === 'forwards' ? ' active' : ''}`}
            onClick={() => setPanel(panel === 'forwards' ? null : 'forwards')}
            title={t('pf.panelTitle')}
          >
            <Icon name="plug" />
            {(activeForwards > 0 || failedForwards) && <span className={`btn-badge${failedForwards ? ' err' : ''}`}>{activeForwards || '!'}</span>}
          </button>
          <button className={`btn btn-ghost${panel === 'commands' ? ' active' : ''}`} onClick={() => setPanel(panel === 'commands' ? null : 'commands')} title={t('topbar.commands')}>
            <Icon name="terminal" />
          </button>
          <button className="btn btn-ghost" onClick={() => setHelp(true)} title={t('keys.title')}>
            <Icon name="keyboard" />
          </button>
          <select
            className="select-sm lang"
            value={language}
            onChange={(e) => save({ language: e.target.value as Language })}
            title={t('topbar.language')}
          >
            {LANGUAGES.map((l) => <option key={l.id} value={l.id} title={l.label}>{l.short}</option>)}
          </select>
          <button className="btn btn-ghost" onClick={() => save({ theme: settings.theme === 'dark' ? 'light' : 'dark' })} title={t('topbar.theme')}>
            <Icon name={settings.theme === 'dark' ? 'sun' : 'moon'} />
          </button>
        </header>

        <section className="content">
          <div className="content-head">
            <span className="crumb">{t(`section.${kind.section}`)}</span>
            <span className="crumb-sep">›</span>
            <h1>{kindLabel(kind)}</h1>
            {!screen && <span className="count">{list.data ? items.length : ''}</span>}
            <span className="muted small">{kind.section === 'crds' ? kind.type : ''}</span>
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
          {kind.type === MAP_TYPE && (
            <RelationMap ctx={ctx} ns={ns} available={available} filter={filter} refreshMs={refreshMs} onOpen={navigateTo} />
          )}

          {!screen && (
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
                  showNamespace={showNamespaceCol}
                  selectedKey={selectedKey}
                  onOpen={openItem}
                />
              )}
            </>
          )}
        </section>
      </main>

      {target && (
        <DetailDrawer
          key={`${ctx}/${target.kind.type}/${target.ns}/${target.name}`}
          ctx={ctx}
          target={target}
          refreshMs={refreshMs}
          onClose={() => setTarget(null)}
          onNavigate={navigateTo}
          onAction={(action, tg, obj) => setDialog({ action, target: tg, obj })}
          onForward={(tg, obj) => setForwardFor({ target: tg, obj })}
        />
      )}

      {panel === 'commands' && <CommandLog onClose={() => setPanel(null)} />}
      {panel === 'forwards' && <ForwardsPanel forwards={forwards.data ?? []} onChanged={forwards.reload} onClose={() => setPanel(null)} />}

      {dialog && (
        <ActionDialog
          ctx={ctx}
          action={dialog.action}
          target={dialog.target}
          obj={dialog.obj}
          isProtected={isProtected}
          onClose={() => setDialog(null)}
          onDone={(message) => {
            setDialog(null);
            showToast(message);
            list.reload();
            if (dialog.action === 'delete') setTarget(null);
          }}
        />
      )}

      {forwardFor && (
        <ForwardDialog
          ctx={ctx}
          target={forwardFor.target}
          obj={forwardFor.obj}
          onClose={() => setForwardFor(null)}
          onStarted={(fwd: PortForward) => {
            setForwardFor(null);
            forwards.reload();
            setPanel('forwards');
            showToast(t('pf.started', { port: fwd.localPort }));
          }}
        />
      )}

      {adding && <AddClusterDialog existingContexts={names} onClose={() => setAdding(false)} onDone={clusterAdded} />}
      {palette && <CommandPalette items={paletteItems} onClose={() => setPalette(false)} />}
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}

      {toast && <div className="toast"><Icon name="check" /> {toast}</div>}
    </div>
  );
}

function NamespaceInput({ value, options, onCommit }: { value: string; options: string[]; onCommit: (v: string) => void }) {
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
        list="known-ns"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        placeholder="namespace"
        title={t('topbar.nsInputTitle')}
        spellCheck={false}
      />
      <datalist id="known-ns">{options.map((o) => <option key={o} value={o} />)}</datalist>
    </>
  );
}
