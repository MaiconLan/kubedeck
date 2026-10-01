import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, isDesktop, sessionToken, type ContextInfo, type PortForward, type Settings } from './api';
import { BUILTIN_TYPES, DASHBOARD_TYPE, HELM_TYPE, KIND_BY_TYPE, KINDS, genericKind, kindLabel } from './catalog';
import { AddClusterDialog } from './components/AddClusterDialog';
import { CommandLog } from './components/CommandLog';
import { CommandPalette, type PaletteItem } from './components/CommandPalette';
import type { Target } from './components/DetailDrawer';
import { ForwardsPanel } from './components/PortForward';
import { ShortcutsHelp } from './components/ShortcutsHelp';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { ALL, TabView } from './components/TabView';
import { Empty, ErrorBanner, Icon, Spinner } from './components/ui';
import { isTyping, useAsync, useKey } from './hooks';
import { detectLanguage, LANGUAGES, setLanguage, t, type Language } from './i18n';
import { GO_KEYS } from './route';
import {
  activate, activeTab, addTab, closeTab, cycleTab, goBack, goForward, hashForTab, MAX_PANES, moveTab,
  navigate, newTab, restore, routeFromHash, selectIndex, serialize, singlePane, splitRight,
  type Layout, type Route,
} from './tabs';

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
  return <Shell initialSettings={boot.data.settings} contexts={boot.data.contexts.contexts} current={boot.data.contexts.current} />;
}

type BottomPanel = 'commands' | 'forwards' | null;

interface RecentItem {
  ctx: string;
  target: Target;
}

const MAX_RECENT = 8;

/** Windows opened from another window start from a single tab and don't overwrite the saved layout. */
const fromHash = routeFromHash(window.location.hash);
const isSecondaryWindow = (() => {
  // Remembered per window, so reloading a secondary window keeps it secondary.
  const key = 'kubedeck.secondary';
  try {
    if (fromHash || /[#&]new\b/.test(window.location.hash)) sessionStorage.setItem(key, '1');
    return sessionStorage.getItem(key) === '1';
  } catch {
    return !!fromHash;
  }
})();

function Shell({ initialSettings, contexts: initialContexts, current }: { initialSettings: Settings; contexts: ContextInfo[]; current: string }) {
  const [settings, setSettings] = useState(initialSettings);
  const [contexts, setContexts] = useState(initialContexts);
  const names = contexts.map((c) => c.name);

  const defaultRoute = (ctx?: string): Route => {
    const c = ctx && names.includes(ctx) ? ctx : settings.lastContext && names.includes(settings.lastContext) ? settings.lastContext : current || names[0];
    const info = contexts.find((x) => x.name === c);
    return { ctx: c, ns: settings.lastNamespace[c] ?? info?.namespace ?? ALL, type: DASHBOARD_TYPE };
  };

  const [layout, setLayout] = useState<Layout>(() => {
    if (fromHash && names.includes(fromHash.route.ctx)) return singlePane(newTab(fromHash.route, fromHash.detail));
    if (!isSecondaryWindow) {
      const saved = restore(settings.layout, names);
      if (saved) return saved;
    }
    return singlePane(newTab(defaultRoute()));
  });
  const [paused, setPaused] = useState(false);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [adding, setAdding] = useState(false);
  const [panel, setPanel] = useState<BottomPanel>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const goPending = useRef(0);

  const language: Language = settings.language ?? detectLanguage();
  setLanguage(language);

  const focusedTab = activeTab(layout);
  const ctx = focusedTab.route.ctx;

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => {
    if (isSecondaryWindow) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  const save = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch, lastNamespace: { ...s.lastNamespace, ...(patch.lastNamespace ?? {}) } }));
    api.saveSettings(patch).catch(() => { /* preferences are best-effort */ });
  }, []);

  // Persist the main window's tabs (debounced).
  useEffect(() => {
    if (isSecondaryWindow) return;
    const id = window.setTimeout(() => {
      api.saveSettings({ layout: serialize(layout) }).catch(() => {});
    }, 800);
    return () => window.clearTimeout(id);
  }, [layout]);

  // Window title follows the focused tab (useful in the taskbar with several windows).
  useEffect(() => {
    const r = focusedTab.route;
    document.title = `${r.target ? r.target.name : kindLabel(KIND_BY_TYPE.get(r.type) ?? KINDS[0])} · ${r.ctx} — KubeDeck`;
  }, [focusedTab.route, language]);

  // ---- shared data for the sidebar and quick navigation (focused tab's context)
  const namespaces = useAsync(() => api.namespaces(ctx), [ctx]);
  const discovery = useAsync(() => api.discovery(ctx), [ctx]);
  const available = useMemo(() => {
    if (!discovery.data) return null;
    return new Set([...discovery.data.map((r) => r.type), ...BUILTIN_TYPES]);
  }, [discovery.data]);

  const forwards = useAsync(() => api.forwards(), [], 3000);
  const activeForwards = (forwards.data ?? []).filter((f) => f.status === 'active').length;
  const failedForwards = (forwards.data ?? []).some((f) => f.status === 'error');

  // ---- tab operations
  const nav = (tabId: string, patch: Partial<Route>, opts?: { detail?: boolean; replace?: boolean }) =>
    setLayout((l) => navigate(l, tabId, patch, opts));

  const openTab = (route: Route, detail: boolean, paneId?: string) => setLayout((l) => addTab(l, newTab(route, detail), paneId));

  const openWindow = (route: Route, detail: boolean) => {
    const url = `${window.location.origin}/?t=${encodeURIComponent(sessionToken())}${hashForTab(newTab(route, detail))}`;
    window.open(url, '_blank');
  };

  const closeTabById = (tabId: string) => setLayout((l) => closeTab(l, tabId, () => newTab(defaultRoute(activeTab(l).route.ctx))));

  const showToast = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast((x) => (x === text ? null : x)), 4000);
  };

  const visit = (visitCtx: string, target: Target) => {
    if (target.kind.type === HELM_TYPE) return;
    setRecent((r) => [{ ctx: visitCtx, target }, ...r.filter((x) => !(x.ctx === visitCtx && x.target.kind.type === target.kind.type && x.target.name === target.name && x.target.ns === target.ns))].slice(0, MAX_RECENT));
  };

  const goToType = (type: string) => nav(focusedTab.id, { type, target: undefined }, { detail: false });

  const switchContext = (name: string, list = contexts) => {
    const info = list.find((c) => c.name === name);
    nav(focusedTab.id, { ctx: name, ns: settings.lastNamespace[name] ?? info?.namespace ?? ALL, target: undefined }, { detail: false });
    save({ lastContext: name });
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
    if (protect && !settings.protectedContexts.includes(name)) save({ protectedContexts: [...settings.protectedContexts, name] });
    switchContext(name, fresh);
    showToast(t('content.clusterAdded', { name }));
  };

  // ---- keyboard
  useKey((e) => {
    if (document.querySelector('.modal-backdrop')) return;
    const mod = e.ctrlKey || e.metaKey;

    if ((e.key === 'k' && mod) || (e.key === ':' && !isTyping(e))) {
      e.preventDefault();
      setPalette(true);
      return;
    }
    // Browser tabs own Ctrl+T/W/Tab; the desktop app gives them to KubeDeck tabs.
    if (isDesktop && mod) {
      const k = e.key.toLowerCase();
      if (k === 't') { e.preventDefault(); openTab({ ...focusedTab.route, type: DASHBOARD_TYPE, target: undefined }, false); return; }
      if (k === 'w') { e.preventDefault(); closeTabById(focusedTab.id); return; }
      if (e.key === 'Tab') { e.preventDefault(); setLayout((l) => cycleTab(l, e.shiftKey ? -1 : 1)); return; }
      if (k === 'n') { e.preventDefault(); openWindow(focusedTab.route, focusedTab.detail); return; }
      if (e.key === '\\') { e.preventDefault(); setLayout((l) => splitRight(l, activeTab(l).id)); return; }
      if (/^[1-9]$/.test(e.key)) { e.preventDefault(); setLayout((l) => selectIndex(l, Number(e.key) - 1)); return; }
    }
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); setLayout((l) => goBack(l, activeTab(l).id)); return; }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); setLayout((l) => goForward(l, activeTab(l).id)); return; }
    if (isTyping(e) || mod || e.altKey) return;

    if (Date.now() - goPending.current < 1200) {
      goPending.current = 0;
      if (e.key === 'f') return setPanel((p) => (p === 'forwards' ? null : 'forwards'));
      if (e.key === 'l') return setPanel((p) => (p === 'commands' ? null : 'commands'));
      if (e.key === 't') return openTab({ ...focusedTab.route, type: DASHBOARD_TYPE, target: undefined }, false);
      if (e.key === 'w') return closeTabById(focusedTab.id);
      const go = GO_KEYS.find((g) => g.key === e.key);
      if (go && (!available || available.has(go.type))) goToType(go.type);
      return;
    }
    if (e.key === 'g') goPending.current = Date.now();
    else if (e.key === '?') setHelp(true);
    else if (e.key === 'Escape' && panel && !(focusedTab.route.target && !focusedTab.detail)) setPanel(null);
  });

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const tabId = focusedTab.id;
    const recentItems: PaletteItem[] = recent.map((r) => ({
      id: `recent:${r.ctx}/${r.target.kind.type}/${r.target.ns}/${r.target.name}`,
      group: t('palette.recent'),
      label: `${r.target.kind.kind}/${r.target.name}`,
      hint: [r.target.ns, r.ctx].filter(Boolean).join(' · '),
      keywords: ['recent', r.target.name.toLowerCase(), r.target.kind.kind.toLowerCase()],
      run: () => openTab({ ctx: r.ctx, ns: focusedTab.route.ns, type: r.target.kind.type, target: { type: r.target.kind.type, name: r.target.name, ns: r.target.ns } }, true),
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
      run: () => goToType(k.type),
    }));
    const ctxItems: PaletteItem[] = names.map((n) => ({
      id: `ctx:${n}`, group: t('palette.context'), label: n, keywords: ['ctx', 'context', n.toLowerCase()], run: () => switchContext(n),
    }));
    const nsList = namespaces.data?.forbidden ? settings.knownNamespaces[ctx] ?? [] : namespaces.data?.names ?? [];
    const nsItems: PaletteItem[] = [ALL, ...nsList].map((n) => ({
      id: `ns:${n}`, group: t('palette.namespace'), label: n === ALL ? t('palette.allNamespaces') : n,
      keywords: ['ns', 'namespace', n.toLowerCase()],
      run: () => {
        nav(tabId, { ns: n });
        save({ lastNamespace: { [ctx]: n } });
      },
    }));
    const tool = (id: string, label: string, keywords: string[], run: () => void): PaletteItem => ({
      id, group: t('palette.tools'), label, keywords: [...keywords, label.toLowerCase()], run,
    });
    const tools: PaletteItem[] = [
      tool('tab-new', t('tabs.new'), ['tab', 'new'], () => openTab({ ...focusedTab.route, type: DASHBOARD_TYPE, target: undefined }, false)),
      tool('tab-split', t('tabs.split'), ['split', 'pane'], () => setLayout((l) => splitRight(l, activeTab(l).id))),
      tool('tab-window', t('tabs.openInWindow'), ['window'], () => openWindow(focusedTab.route, focusedTab.detail)),
      tool('tab-close', t('tabs.close'), ['close', 'tab'], () => closeTabById(tabId)),
      { ...tool('add-aks', t('palette.addAks'), ['add', 'aks', 'azure', 'cluster'], () => setAdding(true)), group: t('palette.context') },
      tool('forwards', t('pf.panelTitle'), ['pf', 'port', 'forward'], () => setPanel('forwards')),
      tool('commands', t('cmdlog.title'), ['log', 'commands'], () => setPanel('commands')),
      tool('help', t('keys.title'), ['help', 'keys', 'shortcuts'], () => setHelp(true)),
    ];
    return [...recentItems, ...kinds, ...ctxItems, ...tools, ...nsItems];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, discovery.data, names.join(), namespaces.data, ctx, focusedTab, settings.knownNamespaces, language, recent]);

  const sidebarFooter = (
    <>
      <div className="side-row">
        <div className="segmented">
          <button className={paused ? 'paused' : ''} onClick={() => setPaused(!paused)} title={paused ? t('topbar.resume') : t('topbar.pause')}>
            <Icon name={paused ? 'play' : 'pause'} size={14} />
            {paused ? t('btn.paused') : t('btn.live')}
          </button>
          <select value={settings.refreshSeconds} onChange={(e) => save({ refreshSeconds: Number(e.target.value) })} title={t('topbar.interval')}>
            {[2, 5, 10, 30, 60].map((s) => <option key={s} value={s}>{t('btn.every', { n: s })}</option>)}
          </select>
        </div>
        <select className="select-sm lang" value={language} onChange={(e) => save({ language: e.target.value as Language })} title={t('topbar.language')}>
          {LANGUAGES.map((l) => <option key={l.id} value={l.id} title={l.label}>{l.short}</option>)}
        </select>
      </div>
      <div className="side-grid">
        <button className={`side-btn${panel === 'forwards' ? ' active' : ''}`} onClick={() => setPanel(panel === 'forwards' ? null : 'forwards')} title={t('pf.panelTitle')}>
          <Icon name="plug" size={15} />
          <span className="label">{t('btn.forwards')}</span>
          {(activeForwards > 0 || failedForwards) && <span className={`pill-badge${failedForwards ? ' err' : ''}`}>{activeForwards || '!'}</span>}
        </button>
        <button className={`side-btn${panel === 'commands' ? ' active' : ''}`} onClick={() => setPanel(panel === 'commands' ? null : 'commands')} title={t('topbar.commands')}>
          <Icon name="terminal" size={15} />
          <span className="label">{t('btn.commands')}</span>
        </button>
        <button className="side-btn" onClick={() => setPalette(true)} title={t('topbar.goTo')}>
          <kbd>:</kbd>
          <span className="label">{t('btn.goTo')}</span>
        </button>
        <button className="side-btn" onClick={() => setHelp(true)} title={t('keys.title')}>
          <Icon name="keyboard" size={15} />
          <span className="label">{t('btn.shortcuts')}</span>
        </button>
        <button className="side-btn wide" onClick={() => save({ theme: settings.theme === 'dark' ? 'light' : 'dark' })} title={t('topbar.theme')}>
          <Icon name={settings.theme === 'dark' ? 'sun' : 'moon'} size={15} />
          <span className="label">{settings.theme === 'dark' ? t('btn.lightTheme') : t('btn.darkTheme')}</span>
        </button>
      </div>
    </>
  );

  return (
    <div className="app">
      <Sidebar
        available={available}
        discovery={discovery.data ?? []}
        current={focusedTab.detail ? '' : focusedTab.route.type}
        onSelect={(k) => goToType(k.type)}
        footer={sidebarFooter}
      />

      <main className="panes" style={{ gridTemplateColumns: `repeat(${layout.panes.length}, minmax(0, 1fr))` }}>
        {layout.panes.map((pane) => {
          const paneFocused = pane.id === layout.focused;
          return (
            <section
              key={pane.id}
              className={`pane${paneFocused && layout.panes.length > 1 ? ' focused' : ''}`}
              onMouseDownCapture={() => !paneFocused && setLayout((l) => ({ ...l, focused: pane.id }))}
            >
              <TabBar
                pane={pane}
                focused={paneFocused}
                canSplit={layout.panes.length < MAX_PANES}
                canClosePane={layout.panes.length > 1}
                protectedContexts={settings.protectedContexts}
                onActivate={(tabId) => setLayout((l) => activate(l, pane.id, tabId))}
                onClose={closeTabById}
                onNew={() => {
                  const base = pane.tabs.find((x) => x.id === pane.active)?.route ?? defaultRoute();
                  openTab({ ...base, type: DASHBOARD_TYPE, target: undefined }, false, pane.id);
                }}
                onSplit={() => setLayout((l) => splitRight(l, pane.active))}
                onWindow={() => {
                  const tab = pane.tabs.find((x) => x.id === pane.active);
                  if (tab) openWindow(tab.route, tab.detail);
                }}
                onClosePane={() => setLayout((l) => {
                  let next = l;
                  for (const tab of pane.tabs) next = closeTab(next, tab.id, () => newTab(defaultRoute()));
                  return next;
                })}
                onDropTab={(tabId, index) => setLayout((l) => moveTab(l, tabId, pane.id, index))}
              />
              <div className="pane-body">
                {pane.tabs.map((tab) => (
                  <TabView
                    key={tab.id}
                    tab={tab}
                    visible={tab.id === pane.active}
                    focused={tab.id === pane.active && paneFocused}
                    contexts={contexts}
                    settings={settings}
                    paused={paused}
                    save={save}
                    onNavigate={(patch, opts) => nav(tab.id, patch, opts)}
                    onBack={() => setLayout((l) => goBack(l, tab.id))}
                    onForward={() => setLayout((l) => goForward(l, tab.id))}
                    onOpenTab={(route, detail) => openTab(route, detail, pane.id)}
                    onOpenWindow={openWindow}
                    onAddCluster={() => setAdding(true)}
                    onToast={showToast}
                    onVisit={visit}
                    onForwardStarted={(fwd: PortForward) => {
                      forwards.reload();
                      setPanel('forwards');
                      showToast(t('pf.started', { port: fwd.localPort }));
                    }}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </main>

      {panel === 'commands' && <CommandLog onClose={() => setPanel(null)} />}
      {panel === 'forwards' && <ForwardsPanel forwards={forwards.data ?? []} onChanged={forwards.reload} onClose={() => setPanel(null)} />}

      {adding && <AddClusterDialog existingContexts={names} onClose={() => setAdding(false)} onDone={clusterAdded} />}
      {palette && <CommandPalette items={paletteItems} onClose={() => setPalette(false)} />}
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}

      {toast && <div className="toast"><Icon name="check" /> {toast}</div>}
    </div>
  );
}
