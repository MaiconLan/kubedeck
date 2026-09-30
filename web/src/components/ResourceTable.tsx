import { useMemo, useState } from 'react';
import type { Cell, Column, Kind } from '../catalog';
import { Badge } from './ui';

interface Props {
  kind: Kind;
  items: any[];
  filter: string;
  showNamespace: boolean;
  selectedKey?: string;
  onOpen: (item: any) => void;
}

export function rowKey(item: any): string {
  return item.metadata?.uid ?? `${item.namespace ?? ''}/${item.name ?? ''}`;
}

function cellText(c: Cell): string {
  return typeof c === 'object' ? c.text : String(c ?? '');
}

export function ResourceTable({ kind, items, filter, showNamespace, selectedKey, onOpen }: Props) {
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
            {columns.map((c) => (
              <th key={c.key} className={`${c.align === 'right' ? 'right' : ''}${c.grow ? ' grow' : ''}`} onClick={() => toggleSort(c)}>
                {c.label}
                {sort.key === c.key && <span className="sort">{sort.dir === 1 ? '▲' : '▼'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => {
            const key = rowKey(item);
            return (
              <tr key={key} className={key === selectedKey ? 'selected' : ''} onClick={() => onOpen(item)}>
                {columns.map((c) => <td key={c.key} className={cls(c)}>{renderCell(c.get(item))}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && items.length > 0 && <div className="table-empty">Nenhum item corresponde ao filtro.</div>}
    </div>
  );
}

function cls(c: Column): string {
  return [c.mono && 'mono', c.align === 'right' && 'right', c.grow && 'grow'].filter(Boolean).join(' ');
}

function renderCell(c: Cell) {
  if (typeof c !== 'object') return c;
  if (c.tone) return <Badge tone={c.tone} title={c.title}>{c.text}</Badge>;
  return <span title={c.title}>{c.text}</span>;
}
