import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { HELM_TYPE, type ActionName, type Cell, type Column, type Kind } from '../catalog';
import { condition, podStatus, ratio, readyCount } from '../format';
import { t } from '../i18n';
import { ACTION_META } from './DetailDrawer';
import { Badge, Icon } from './ui';

interface Props {
  kind: Kind;
  items: any[];
  filter: string;
  showNamespace: boolean;
  selectedKey?: string;
  /** `newTab`: Ctrl/Cmd+click or middle click. */
  onOpen: (item: any, newTab: boolean) => void;
  /** Runs an action from the right-click menu. */
  onAction?: (action: ActionName, item: any) => void;
  /** Renders a narrow first column (e.g. a star button). */
  leading?: (item: any) => ReactNode;
}

/** Actions that apply to this row right now (suspend/resume depend on its state). */
function actionsFor(kind: Kind, item: any): ActionName[] {
  const suspended = item.spec?.suspend === true;
  return (kind.actions ?? []).filter((a) => (a === 'suspend' ? !suspended : a === 'resume' ? suspended : true));
}

function ContextMenu({ kind, item, x, y, onPick, onClose }: {
  kind: Kind; item: any; x: number; y: number; onPick: (a: ActionName) => void; onClose: () => void;
}) {
  const actions = actionsFor(kind, item);
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('wheel', close, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('wheel', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - 200);
  const top = Math.min(y, window.innerHeight - (actions.length * 34 + 16));
  return (
    <div className="ctx-menu" role="menu" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      {actions.map((a) => {
        const meta = ACTION_META[a];
        const label = kind.type === HELM_TYPE && a === 'delete' ? t('action.uninstall') : t(meta.label);
        return (
          <button key={a} role="menuitem" className={`ctx-item${meta.danger ? ' danger' : ''}`} onClick={() => onPick(a)}>
            <Icon name={meta.icon} size={14} /> {label}
          </button>
        );
      })}
    </div>
  );
}

export function rowKey(item: any): string {
  return item.metadata?.uid ?? `${item.namespace ?? ''}/${item.name ?? ''}`;
}

function cellText(c: Cell): string {
  return typeof c === 'object' ? c.text : String(c ?? '');
}

/** Whole-row highlight: `err` for failing workloads, `done` for finished ones (Completed pods, completed Jobs). */
function rowTone(kind: Kind, item: any): 'err' | 'done' | undefined {
  switch (kind.type) {
    case 'pods': {
      const s = podStatus(item);
      if (s.tone === 'err') return 'err';
      if (s.tone === 'muted') return 'done';
      const [r, total] = readyCount(item);
      return s.text === 'Running' && total > 0 && r === 0 ? 'err' : undefined;
    }
    case 'deployments.apps':
    case 'statefulsets.apps':
      return ratio(item.status?.readyReplicas, item.spec?.replicas).tone === 'err' ? 'err' : undefined;
    case 'daemonsets.apps':
      return ratio(item.status?.numberReady, item.status?.desiredNumberScheduled).tone === 'err' ? 'err' : undefined;
    case 'replicasets.apps':
      return ratio(item.status?.readyReplicas, item.spec?.replicas).tone === 'err' ? 'err' : undefined;
    case 'jobs.batch':
      if (condition(item, 'Failed')?.status === 'True') return 'err';
      return condition(item, 'Complete')?.status === 'True' ? 'done' : undefined;
    default:
      return undefined;
  }
}

export function ResourceTable({ kind, items, filter, showNamespace, selectedKey, onOpen, onAction, leading }: Props) {
  const [menu, setMenu] = useState<{ item: any; x: number; y: number }>();
  const columns = useMemo(
    () => kind.columns.filter((c) => showNamespace || c.key !== 'ns'),
    [kind, showNamespace],
  );
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: '', dir: 1 });

  const rows = useMemo(() => {
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    let list = items;
    if (terms.length) {
      list = items.filter((item) => {
        const hay = columns.map((c) => cellText(c.get(item))).join(' ').toLowerCase()
          + ' ' + Object.entries(item.metadata?.labels ?? {}).map(([k, v]) => `${k}=${v}`).join(' ').toLowerCase();
        return terms.every((t) => hay.includes(t));
      });
    }
    const col = columns.find((c) => c.key === sort.key);
    if (col) {
      const value = col.sort ?? ((o: any) => cellText(col.get(o)));
      list = [...list].sort((a, b) => {
        const va = value(a);
        const vb = value(b);
        const r = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true });
        return r * sort.dir;
      });
    }
    return list;
  }, [items, filter, columns, sort]);

  const toggleSort = (c: Column) => {
    setSort((s) => (s.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 }));
  };

  return (
    <div className="table-wrap">
      <table className="grid">
        <thead>
          <tr>
            {leading && <th className="lead-cell" />}
            {columns.map((c) => (
              <th key={c.key} className={`${c.align === 'right' ? 'right' : ''}${c.grow ? ' grow' : ''}`} title={c.hint ? t(c.hint) : undefined} onClick={() => toggleSort(c)}>
                {t(c.label)}
                {sort.key === c.key && <span className="sort">{sort.dir === 1 ? '▲' : '▼'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => {
            const key = rowKey(item);
            const tone = rowTone(kind, item);
            return (
              <tr
                key={key}
                className={[key === selectedKey && 'selected', tone && `row-${tone}`].filter(Boolean).join(' ')}
                onClick={(e) => onOpen(item, e.ctrlKey || e.metaKey)}
                onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                onAuxClick={(e) => e.button === 1 && onOpen(item, true)}
                onContextMenu={(e) => {
                  if (!onAction || actionsFor(kind, item).length === 0) return;
                  e.preventDefault();
                  setMenu({ item, x: e.clientX, y: e.clientY });
                }}
              >
                {leading && <td className="lead-cell" onClick={(e) => e.stopPropagation()}>{leading(item)}</td>}
                {columns.map((c) => <td key={c.key} className={cls(c)}>{renderCell(c.get(item))}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && items.length > 0 && <div className="table-empty">{t('table.noMatch')}</div>}
      {menu && onAction && (
        <ContextMenu
          kind={kind} item={menu.item} x={menu.x} y={menu.y}
          onClose={() => setMenu(undefined)}
          onPick={(a) => { setMenu(undefined); onAction(a, menu.item); }}
        />
      )}
    </div>
  );
}

function cls(c: Column): string {
  return [c.mono && 'mono', c.align === 'right' && 'right', c.grow && 'grow'].filter(Boolean).join(' ');
}

export function renderCell(c: Cell) {
  if (typeof c !== 'object') return c;
  if (c.tone && c.plain) return <span className={`mono tone-${c.tone}`} title={c.title}>{c.text}</span>;
  if (c.tone) return <Badge tone={c.tone} title={c.title}>{c.text}</Badge>;
  if (c.bar) {
    return (
      <div className="usage-cell" title={c.title}>
        <span>{c.text}</span>
        <div className="meter-track">
          <div className={`meter-fill${c.bar.tone === 'ok' ? '' : ` ${c.bar.tone === 'warm' ? 'warm' : 'hot'}`}`} style={{ width: `${c.bar.used * 100}%` }} />
          {c.bar.mark !== undefined && <div className="meter-req" style={{ left: `${c.bar.mark * 100}%` }} />}
        </div>
      </div>
    );
  }
  return <span title={c.title}>{c.text}</span>;
}
