/**
 * Tabs and split panes. Pure functions over a serializable Layout so the
 * shell can persist it and every change is easy to reason about.
 */

export interface TargetRef {
  type: string;
  ns?: string;
  name: string;
}

/** What a tab shows: a screen/list (optionally with a resource open), or a single resource. */
export interface Route {
  ctx: string;
  ns: string;
  type: string;
  target?: TargetRef;
}

export interface Tab {
  id: string;
  route: Route;
  /** The tab is dedicated to `route.target` (full-page detail instead of list + drawer). */
  detail: boolean;
  back: Route[];
  forward: Route[];
}

export interface Pane {
  id: string;
  tabs: Tab[];
  active: string;
}

export interface Layout {
  panes: Pane[];
  focused: string;
}

export const MAX_PANES = 3;
const MAX_HISTORY = 50;

let counter = 0;
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

export function newTab(route: Route, detail = false): Tab {
  return { id: uid('t'), route, detail: detail && !!route.target, back: [], forward: [] };
}

export function singlePane(tab: Tab): Layout {
  const pane: Pane = { id: uid('p'), tabs: [tab], active: tab.id };
  return { panes: [pane], focused: pane.id };
}

export function focusedPane(layout: Layout): Pane {
  return layout.panes.find((p) => p.id === layout.focused) ?? layout.panes[0];
}

export function activeTab(layout: Layout): Tab {
  const pane = focusedPane(layout);
  return pane.tabs.find((t) => t.id === pane.active) ?? pane.tabs[0];
}

export function findTab(layout: Layout, tabId: string): Tab | undefined {
  for (const p of layout.panes) {
    const t = p.tabs.find((x) => x.id === tabId);
    if (t) return t;
  }
  return undefined;
}

function mapTab(layout: Layout, tabId: string, fn: (t: Tab) => Tab): Layout {
  return {
    ...layout,
    panes: layout.panes.map((p) => ({ ...p, tabs: p.tabs.map((t) => (t.id === tabId ? fn(t) : t)) })),
  };
}

function sameRoute(a: Route, b: Route): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Changes what a tab shows, recording the previous route for Back. */
export function navigate(layout: Layout, tabId: string, patch: Partial<Route>, opts: { detail?: boolean; replace?: boolean } = {}): Layout {
  return mapTab(layout, tabId, (t) => {
    const route: Route = { ...t.route, ...patch };
    if ('target' in patch && patch.target === undefined) delete route.target;
    // A resource tab stays a resource tab while it has a target (following related links keeps it in place).
    const detail = (opts.detail ?? t.detail) && !!route.target;
    if (sameRoute(route, t.route) && detail === t.detail) return t;
    if (opts.replace) return { ...t, route, detail };
    return { ...t, route, detail, back: [...t.back, t.route].slice(-MAX_HISTORY), forward: [] };
  });
}

export function goBack(layout: Layout, tabId: string): Layout {
  return mapTab(layout, tabId, (t) => {
    const prev = t.back[t.back.length - 1];
    if (!prev) return t;
    return { ...t, route: prev, detail: t.detail && !!prev.target, back: t.back.slice(0, -1), forward: [t.route, ...t.forward] };
  });
}

export function goForward(layout: Layout, tabId: string): Layout {
  return mapTab(layout, tabId, (t) => {
    const next = t.forward[0];
    if (!next) return t;
    return { ...t, route: next, detail: t.detail && !!next.target, back: [...t.back, t.route], forward: t.forward.slice(1) };
  });
}

export function activate(layout: Layout, paneId: string, tabId: string): Layout {
  return {
    focused: paneId,
    panes: layout.panes.map((p) => (p.id === paneId ? { ...p, active: tabId } : p)),
  };
}

/** Adds a tab next to the active one in the given pane (focused pane by default) and selects it. */
export function addTab(layout: Layout, tab: Tab, paneId = layout.focused): Layout {
  return {
    focused: paneId,
    panes: layout.panes.map((p) => {
      if (p.id !== paneId) return p;
      const at = p.tabs.findIndex((t) => t.id === p.active);
      const tabs = [...p.tabs];
      tabs.splice(at + 1, 0, tab);
      return { ...p, tabs, active: tab.id };
    }),
  };
}

/** Closes a tab; an emptied pane disappears, and the last tab is replaced by `fallback`. */
export function closeTab(layout: Layout, tabId: string, fallback: () => Tab): Layout {
  const panes: Pane[] = [];
  let focused = layout.focused;
  for (const p of layout.panes) {
    const idx = p.tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) {
      panes.push(p);
      continue;
    }
    const tabs = p.tabs.filter((t) => t.id !== tabId);
    if (!tabs.length) {
      if (focused === p.id) focused = '';
      continue;
    }
    const active = p.active === tabId ? tabs[Math.min(idx, tabs.length - 1)].id : p.active;
    panes.push({ ...p, tabs, active });
  }
  if (!panes.length) return singlePane(fallback());
  if (!panes.some((p) => p.id === focused)) focused = panes[Math.max(0, panes.length - 1)].id;
  return { panes, focused };
}

/** Opens a copy of the tab in a new pane to the right (or in the next pane when already at the limit). */
export function splitRight(layout: Layout, tabId: string): Layout {
  const source = findTab(layout, tabId);
  if (!source) return layout;
  const copy: Tab = { ...newTab(source.route, source.detail) };
  const at = layout.panes.findIndex((p) => p.tabs.some((t) => t.id === tabId));
  if (layout.panes.length >= MAX_PANES) {
    const target = layout.panes[Math.min(at + 1, layout.panes.length - 1)];
    return addTab(layout, copy, target.id === layout.panes[at].id ? layout.panes[0].id : target.id);
  }
  const pane: Pane = { id: uid('p'), tabs: [copy], active: copy.id };
  const panes = [...layout.panes];
  panes.splice(at + 1, 0, pane);
  return { panes, focused: pane.id };
}

/** Moves a tab to another pane (used by drag and drop between tab bars). */
export function moveTab(layout: Layout, tabId: string, toPane: string, index?: number): Layout {
  const tab = findTab(layout, tabId);
  if (!tab) return layout;
  const without = closeTab(layout, tabId, () => tab);
  if (!without.panes.some((p) => p.id === toPane)) return layout;
  return {
    focused: toPane,
    panes: without.panes.map((p) => {
      if (p.id !== toPane) return p;
      const tabs = p.tabs.filter((t) => t.id !== tabId);
      tabs.splice(index ?? tabs.length, 0, tab);
      return { ...p, tabs, active: tab.id };
    }),
  };
}

export function cycleTab(layout: Layout, step: 1 | -1): Layout {
  const pane = focusedPane(layout);
  const idx = pane.tabs.findIndex((t) => t.id === pane.active);
  const next = pane.tabs[(idx + step + pane.tabs.length) % pane.tabs.length];
  return activate(layout, pane.id, next.id);
}

export function selectIndex(layout: Layout, index: number): Layout {
  const pane = focusedPane(layout);
  const tab = index >= pane.tabs.length ? pane.tabs[pane.tabs.length - 1] : pane.tabs[index];
  return tab ? activate(layout, pane.id, tab.id) : layout;
}

/** Snapshot to persist: no history, only tabs whose context still exists. */
export function serialize(layout: Layout): unknown {
  return {
    focused: layout.focused,
    panes: layout.panes.map((p) => ({ id: p.id, active: p.active, tabs: p.tabs.map((t) => ({ id: t.id, route: t.route, detail: t.detail })) })),
  };
}

export function restore(raw: unknown, contexts: string[]): Layout | null {
  try {
    const data = raw as { focused: string; panes: Array<{ id: string; active: string; tabs: Array<{ id: string; route: Route; detail: boolean }> }> };
    const panes: Pane[] = data.panes
      .map((p): Pane => {
        const tabs: Tab[] = p.tabs
          .filter((t) => t.route && contexts.includes(t.route.ctx) && typeof t.route.type === 'string')
          .map((t) => ({ id: t.id, route: t.route, detail: !!t.detail && !!t.route.target, back: [], forward: [] }));
        return { id: p.id, tabs, active: tabs.some((t) => t.id === p.active) ? p.active : tabs[0]?.id ?? '' };
      })
      .filter((p) => p.tabs.length > 0)
      .slice(0, MAX_PANES);
    if (!panes.length) return null;
    return { panes, focused: panes.some((p) => p.id === data.focused) ? data.focused : panes[0].id };
  } catch {
    return null;
  }
}

/** A second window starts from one tab passed in the URL hash: #tab=<json>. */
export function routeFromHash(hash: string): { route: Route; detail: boolean } | null {
  const m = /[#&]tab=([^&]+)/.exec(hash);
  if (!m) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(m[1]));
    if (!parsed?.route?.ctx || !parsed.route.type) return null;
    return { route: parsed.route, detail: !!parsed.detail };
  } catch {
    return null;
  }
}

export function hashForTab(tab: Tab): string {
  return `#tab=${encodeURIComponent(JSON.stringify({ route: tab.route, detail: tab.detail }))}`;
}
