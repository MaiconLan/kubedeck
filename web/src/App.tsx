import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ContextInfo, type Settings } from './api';
import { HELM_TYPE, KIND_BY_TYPE, KINDS, genericKind, kindByName, type ActionName, type Kind } from './catalog';
import { ActionDialog } from './components/ActionDialog';
import { AddClusterDialog } from './components/AddClusterDialog';
import { CommandLog } from './components/CommandLog';
import { CommandPalette, type PaletteItem } from './components/CommandPalette';
import { DetailDrawer, type Target } from './components/DetailDrawer';
import { ResourceTable, rowKey } from './components/ResourceTable';
import { Sidebar } from './components/Sidebar';
import { Empty, ErrorBanner, Icon, Spinner } from './components/ui';
import { isTyping, useAsync, useKey } from './hooks';

const ALL = '*';
const DEFAULT_KIND = KIND_BY_TYPE.get('pods')!;

export function App() {
  const [adding, setAdding] = useState(false);
  const boot = useAsync(async () => {
    const [settings, contexts] = await Promise.all([api.settings(), api.contexts()]);
    return { settings, contexts };
  }, []);

  if (boot.error) {
    return <div className="boot"><ErrorBanner error={boot.error} onRetry={boot.reload} /></div>;
  }
  if (!boot.data) {
    return <div className="boot"><Spinner /> <span className="muted">Lendo kubeconfig…</span></div>;
  }
  if (boot.data.contexts.contexts.length === 0) {
    return (
      <div className="boot">
        <Empty title="Nenhum contexto no kubeconfig">
          <p>Adicione um cluster AKS por aqui, ou configure o acesso com <code>kubectl config</code> e recarregue a página.</p>
          <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" /> Adicionar cluster AKS</button>
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

function Workspace({ initialSettings, contexts: initialContexts, current }: { initialSettings: Settings; contexts: ContextInfo[]; current: string }) {
  const [settings, setSettings] = useState(initialSettings);
  const [contexts, setContexts] = useState(initialContexts);
  const [adding, setAdding] = useState(false);
  const names = contexts.map((c) => c.name);
  const [ctx, setCtx] = useState(() =>
    settings.lastContext && names.includes(settings.lastContext) ? settings.lastContext : current || names[0],
  );
  const ctxInfo = contexts.find((c) => c.name === ctx);
  const [ns, setNs] = useState(() => settings.lastNamespace[ctx] ?? ctxInfo?.namespace ?? ALL);
  const [kind, setKind] = useState<Kind>(DEFAULT_KIND);
  const [filter, setFilter] = useState('');
  const [paused, setPaused] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [dialog, setDialog] = useState<{ action: ActionName; target: Target; obj: any } | null>(null);
  const [palette, setPalette] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const isProtected = settings.protectedContexts.includes(ctx);
  const refreshMs = paused ? 0 : settings.refreshSeconds * 1000;

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
    return new Set([...discovery.data.map((r) => r.type), HELM_TYPE]);
  }, [discovery.data]);

  const list = useAsync(
    async () => {
      if (kind.type === HELM_TYPE) return { namespaced: true, items: await api.helmReleases(ctx, ns) };
      return api.list(ctx, kind.type, ns);
    },
    [ctx, kind.type, ns],
    refreshMs,
  );

  // If the chosen kind does not exist in this cluster (e.g. no Flux), fall back to pods.
  useEffect(() => {
    if (available && kind.section !== 'CRDs' && !available.has(kind.type)) setKind(DEFAULT_KIND);
  }, [available, kind]);

  // When namespaces cannot be listed, "all namespaces" will fail too: pick a concrete one.
  useEffect(() => {
    if (namespaces.data?.forbidden && ns === ALL) setNs(ctxInfo?.namespace || settings.knownNamespaces[ctx]?.[0] || 'default');
  }, [namespaces.data, ns, ctx, ctxInfo, settings.knownNamespaces]);

  // ---- navigation
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
    showToast(`Cluster ${name} adicionado.`);
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
    if (kind.type === HELM_TYPE) setTarget({ kind, name: item.name, ns: item.namespace, row: item });
    else setTarget({ kind, name: item.metadata.name, ns: item.metadata.namespace });
  };

  const navigateTo = (kindName: string, name: string, targetNs?: string) => {
    const k = kindByName(kindName);
    if (!k) return;
    setKind(k);
    setFilter('');
    setTarget({ kind: k, name, ns: targetNs });
  };

  const toggleProtected = () => {
    const next = isProtected
      ? settings.protectedContexts.filter((c) => c !== ctx)
      : [...settings.protectedContexts, ctx];
    save({ protectedContexts: next });
  };

  const showToast = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast((t) => (t === text ? null : t)), 4000);
  };

  // ---- keyboard
  useKey((e) => {
    if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === ':' && !isTyping(e))) {
      e.preventDefault();
      setPalette(true);
    } else if (e.key === '/' && !isTyping(e)) {
      e.preventDefault();
      filterRef.current?.focus();
    } else if (e.key === 'Escape' && !dialog && !palette) {
      if (isTyping(e)) (e.target as HTMLElement).blur();
      else if (target) setTarget(null);
      else if (showLog) setShowLog(false);
    }
  });

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const kinds: PaletteItem[] = [
      ...KINDS.filter((k) => !available || available.has(k.type)),
      ...(discovery.data ?? []).filter((r) => !KIND_BY_TYPE.has(r.type) && r.verbs.includes('list') && r.group).map(genericKind),
    ].map((k) => ({
      id: `kind:${k.type}`,
      group: k.section,
      label: k.label,
      hint: k.short.join(', '),
      keywords: [...k.short, k.label.toLowerCase(), k.kind.toLowerCase(), k.type],
      run: () => selectKind(k),
    }));
    const ctxItems: PaletteItem[] = names.map((n) => ({
      id: `ctx:${n}`, group: 'Contexto', label: n, keywords: ['ctx', 'context', n.toLowerCase()], run: () => switchContext(n),
    }));
    const nsList = namespaces.data?.forbidden ? settings.knownNamespaces[ctx] ?? [] : namespaces.data?.names ?? [];
    const nsItems: PaletteItem[] = [ALL, ...nsList].map((n) => ({
      id: `ns:${n}`, group: 'Namespace', label: n === ALL ? 'todos os namespaces' : n,
      keywords: ['ns', 'namespace', n.toLowerCase()], run: () => switchNamespace(n),
    }));
    const addItem: PaletteItem = {
      id: 'add-aks', group: 'Contexto', label: 'Adicionar cluster AKS…', keywords: ['add', 'aks', 'azure', 'adicionar', 'cluster'],
      run: () => setAdding(true),
    };
    return [...kinds, ...ctxItems, addItem, ...nsItems];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, discovery.data, names.join(), namespaces.data, ctx, settings.knownNamespaces]);

  const items = list.data?.items ?? [];
  const showNamespaceCol = ns === ALL;

  return (
    <div className={`app${target ? ' with-drawer' : ''}`}>
      <Sidebar available={available} discovery={discovery.data ?? []} current={kind.type} onSelect={selectKind} />

      <main className="main">
        <header className={`topbar${isProtected ? ' protected' : ''}`}>
          <div className="picker">
            <label>Contexto</label>
            <select value={ctx} onChange={(e) => switchContext(e.target.value)} title={ctxInfo?.server}>
              {names.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <button
              className={`btn btn-ghost btn-sm lock${isProtected ? ' on' : ''}`}
              onClick={toggleProtected}
              title={isProtected ? 'Contexto protegido: ações pedem digitar o nome. Clique para desproteger.' : 'Proteger este contexto (recomendado para produção/trabalho)'}
            >
              <Icon name={isProtected ? 'lock' : 'unlock'} />
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setAdding(true)} title="Adicionar cluster AKS ao kubeconfig">
              <Icon name="plus" />
            </button>
          </div>

          <div className="picker">
            <label>Namespace</label>
            {namespaces.data?.forbidden ? (
              <NamespaceInput value={ns} options={settings.knownNamespaces[ctx] ?? []} onCommit={switchNamespace} />
            ) : (
              <select value={ns} onChange={(e) => switchNamespace(e.target.value)} disabled={!namespaces.data && !namespaces.error}>
                <option value={ALL}>todos</option>
                {(namespaces.data?.names ?? (ns !== ALL ? [ns] : [])).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            )}
          </div>

          <div className="search-box grow">
            <Icon name="search" size={14} />
            <input ref={filterRef} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filtrar ${kind.label.toLowerCase()}  ( / )`} />
            {filter && <button className="btn btn-ghost btn-xs" onClick={() => setFilter('')}><Icon name="close" size={12} /></button>}
          </div>

          <button className="btn btn-ghost" onClick={() => setPalette(true)} title="Ir para (: ou Ctrl+K)">
            <kbd>:</kbd>
          </button>
          <div className="refresh">
            <button className="btn btn-ghost btn-sm" onClick={() => setPaused(!paused)} title={paused ? 'Retomar atualização automática' : 'Pausar atualização automática'}>
              <Icon name={paused ? 'play' : 'pause'} />
            </button>
            <select
              value={settings.refreshSeconds}
              onChange={(e) => save({ refreshSeconds: Number(e.target.value) })}
              className="select-sm"
              title="Intervalo de atualização"
            >
              {[2, 5, 10, 30, 60].map((s) => <option key={s} value={s}>{s}s</option>)}
            </select>
            <button className="btn btn-ghost btn-sm" onClick={list.reload} title="Atualizar agora">
              {list.loading ? <Spinner small /> : <Icon name="refresh" />}
            </button>
          </div>
          <button className={`btn btn-ghost${showLog ? ' active' : ''}`} onClick={() => setShowLog(!showLog)} title="Comandos executados">
            <Icon name="terminal" />
          </button>
          <button className="btn btn-ghost" onClick={() => save({ theme: settings.theme === 'dark' ? 'light' : 'dark' })} title="Tema">
            <Icon name={settings.theme === 'dark' ? 'sun' : 'moon'} />
          </button>
        </header>

        <section className="content">
          <div className="content-head">
            <h1>{kind.label}</h1>
            <span className="count">{list.data ? items.length : ''}</span>
            <span className="muted small">{kind.section === 'CRDs' ? kind.type : ''}</span>
            <span className="spacer" />
            <span className="muted small ctx-summary">
              {ctx}{list.data?.namespaced === false ? ' · recurso do cluster' : ns === ALL ? ' · todos os namespaces' : ` · ${ns}`}
            </span>
          </div>

          {discovery.error && discovery.error.kind === 'auth' && !list.error && <ErrorBanner error={discovery.error} onRetry={discovery.reload} />}
          {list.error && <ErrorBanner error={list.error} onRetry={() => { list.reload(); discovery.reload(); namespaces.reload(); }} />}

          {!list.data && !list.error && <div className="loading-rows">{Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton" />)}</div>}
          {list.data && items.length === 0 && (
            <Empty title={`Nenhum ${kind.label.toLowerCase()} aqui`}>
              {ns !== ALL && list.data.namespaced ? <>Namespace <code>{ns}</code>. Tente “todos” no seletor de namespace.</> : null}
            </Empty>
          )}
          {list.data && items.length > 0 && (
            <ResourceTable
              kind={kind}
              items={items}
              filter={filter}
              showNamespace={showNamespaceCol}
              selectedKey={target ? items.map(rowKey).find((k, i) => (items[i].metadata?.name ?? items[i].name) === target.name) : undefined}
              onOpen={openItem}
            />
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
          onAction={(action, t, obj) => setDialog({ action, target: t, obj })}
        />
      )}

      {showLog && <CommandLog onClose={() => setShowLog(false)} />}

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

      {adding && <AddClusterDialog existingContexts={names} onClose={() => setAdding(false)} onDone={clusterAdded} />}

      {palette && <CommandPalette items={paletteItems} onClose={() => setPalette(false)} />}

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
        title="Seu usuário não pode listar namespaces neste cluster; digite o nome."
        spellCheck={false}
      />
      <datalist id="known-ns">{options.map((o) => <option key={o} value={o} />)}</datalist>
    </>
  );
}
