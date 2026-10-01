import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n';

export interface PaletteItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  keywords: string[];
  run: () => void;
}

export function CommandPalette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => input.current?.focus(), []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^:/, '');
    if (!q) return items.slice(0, 60);
    const scored = items
      .map((item) => ({ item, score: score(item, q) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, 60).map((r) => r.item);
  }, [items, query]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector('.pal-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const choose = (item?: PaletteItem) => {
    if (!item) return;
    onClose();
    item.run();
  };

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true">
        <div className="pal-input">
          <span className="pal-key">:</span>
          <input
            ref={input}
            value={query}
            placeholder={t('palette.placeholder')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(results.length - 1, i + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
              else if (e.key === 'Enter') choose(results[index]);
            }}
          />
          <span className="pal-shortcuts">po · deploy · hr · ks · ctx · ns</span>
        </div>
        <div className="pal-list" ref={list}>
          {results.length === 0 && <div className="pal-empty">{t('palette.empty')}</div>}
          {results.map((item, i) => (
            <button
              key={item.id}
              className={`pal-item${i === index ? ' active' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(item)}
            >
              <span className="pal-group">{item.group}</span>
              <span className="pal-label">{item.label}</span>
              {item.hint && <span className="pal-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
        <div className="pal-foot">
          <span><kbd>↑↓</kbd>{t('palette.navigate')}</span>
          <span><kbd>enter</kbd>{t('palette.open')}</span>
          <span><kbd>esc</kbd>{t('palette.close')}</span>
        </div>
      </div>
    </div>
  );
}

function score(item: PaletteItem, q: string): number {
  const [head, ...rest] = q.split(/\s+/);
  const tail = rest.join(' ');
  // "ctx foo" / "ns foo" style prefixes narrow to that group.
  if (tail && item.keywords[0] === head) {
    return item.label.toLowerCase().includes(tail) ? 100 : 0;
  }
  let best = 0;
  for (const kw of item.keywords) {
    if (kw === q) best = Math.max(best, 90);
    else if (kw.startsWith(q)) best = Math.max(best, 60);
    else if (kw.includes(q)) best = Math.max(best, 30);
  }
  const label = item.label.toLowerCase();
  if (label.startsWith(q)) best = Math.max(best, 50);
  else if (label.includes(q)) best = Math.max(best, 20);
  return best;
}
