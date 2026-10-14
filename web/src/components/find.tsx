import { useEffect, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { t } from '../i18n';
import { Icon } from './ui';

interface Hit {
  line: number;
  start: number;
}

/** Every occurrence of `q` (already lower-cased) in `lines`, in reading order. */
function findHits(lines: string[], q: string): Hit[] {
  const hits: Hit[] = [];
  if (!q) return hits;
  lines.forEach((line, i) => {
    const lower = line.toLowerCase();
    let idx = lower.indexOf(q);
    while (idx >= 0) {
      hits.push({ line: i, start: idx });
      idx = lower.indexOf(q, idx + q.length);
    }
  });
  return hits;
}

/**
 * In-text search state (the CTRL+F experience): all occurrences, one of them active, and next/previous
 * navigation that scrolls the active one into view inside `scope`. `onJump` runs after each scroll.
 */
export function useFind(lines: string[], q: string, scope: RefObject<HTMLElement | null>, onJump?: () => void) {
  const [cursor, setCursor] = useState(0);
  const [jumps, setJumps] = useState(0);

  const hits = findHits(lines, q);
  const total = hits.length;
  const active = total ? Math.min(cursor, total - 1) : -1;

  const starts = new Map<number, number[]>();
  for (const h of hits) {
    const list = starts.get(h.line);
    if (list) list.push(h.start);
    else starts.set(h.line, [h.start]);
  }

  useEffect(() => {
    setCursor(0);
    setJumps((j) => j + 1);
  }, [q]);

  useEffect(() => {
    const el = scope.current?.querySelector('mark.active');
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    onJump?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumps]);

  const step = (dir: 1 | -1) => {
    if (!total) return;
    setCursor((active + dir + total) % total);
    setJumps((j) => j + 1);
  };

  return {
    q,
    total,
    /** 0-based position of the active occurrence, -1 when there is none. */
    active,
    /** Start offsets of the occurrences in line `i`. */
    startsIn: (i: number) => starts.get(i),
    /** Start offset of the active occurrence when it is in line `i`, else -1. */
    activeIn: (i: number) => (active >= 0 && hits[active].line === i ? hits[active].start : -1),
    next: () => step(1),
    prev: () => step(-1),
    /** Enter goes to the next occurrence, Shift+Enter to the previous one. */
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    },
  };
}

export type Find = ReturnType<typeof useFind>;

/** "3/12" plus previous/next buttons; meant to sit inside a `.search-box`. */
export function FindNav({ find }: { find: Find }) {
  if (!find.q) return null;
  return (
    <>
      <span className="search-count">{find.total ? `${find.active + 1}/${find.total}` : '0'}</span>
      <button className="find-step" disabled={!find.total} title={t('common.findPrev')} onClick={find.prev}>
        <Icon name="arrowUp" size={13} />
      </button>
      <button className="find-step" disabled={!find.total} title={t('common.findNext')} onClick={find.next}>
        <Icon name="arrowDown" size={13} />
      </button>
    </>
  );
}

/**
 * Wraps the occurrences that fall inside `text` in <mark>. `offset` is where `text` starts within its
 * line, so a line rendered as several pieces (syntax highlighting) still marks matches that span them.
 */
export function marked(text: string, offset: number, starts: number[] | undefined, len: number, activeStart: number): ReactNode {
  if (!starts) return text;
  const end = offset + text.length;
  const parts: ReactNode[] = [];
  let from = 0;
  for (const s of starts) {
    if (s >= end || s + len <= offset) continue;
    const a = Math.max(s, offset) - offset;
    const b = Math.min(s + len, end) - offset;
    parts.push(text.slice(from, a), <mark key={s} className={s === activeStart ? 'active' : undefined}>{text.slice(a, b)}</mark>);
    from = b;
  }
  if (!parts.length) return text;
  parts.push(text.slice(from));
  return parts;
}
