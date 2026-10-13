import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type Settings, type TrackedRef } from '../api';
import { KIND_BY_TYPE } from '../catalog';
import { podStatus } from '../format';
import { useAsync } from '../hooks';
import { t } from '../i18n';
import { DEFAULT_FIELDS, MAX_FIELDS, TRACK_FIELDS, entryOf, fieldsOf, sameTrack } from '../tracked';
import { ResourceTable, renderCell } from './ResourceTable';
import { Badge, Empty, ErrorBanner, Icon, Spinner } from './ui';

/** The pod shown in the drawer, with its own context. */
export interface TrackedSelection {
  ctx: string;
  ns: string;
  name: string;
}

interface Props {
  settings: Settings;
  save: (patch: Partial<Settings>) => void;
  refreshMs: number;
  selected: TrackedSelection | null;
  onOpen: (ctx: string, pod: any) => void;
}

type View = 'cards' | 'list';

interface GroupActions {
  view: View;
  refreshMs: number;
  selected: TrackedSelection | null;
  onOpen: (ctx: string, pod: any) => void;
  onUntrack: (ref: TrackedRef) => void;
  onSetFields: (ref: TrackedRef, fields: string[] | undefined) => void;
}

const byName = (a: string, b: string) => a.localeCompare(b);

export function Tracked({ settings, save, refreshMs, selected, onOpen }: Props) {
  const view: View = settings.trackedView ?? 'cards';
  const tracked = settings.tracked ?? [];

  const contexts = useMemo(() => {
    const byCtx = new Map<string, Map<string, TrackedRef[]>>();
    for (const ref of tracked) {
      const nsMap = byCtx.get(ref.ctx) ?? new Map<string, TrackedRef[]>();
      byCtx.set(ref.ctx, nsMap);
      nsMap.set(ref.ns, [...(nsMap.get(ref.ns) ?? []), ref]);
    }
    return [...byCtx.entries()].sort(([a], [b]) => byName(a, b)).map(([ctx, nsMap]) => ({
      ctx,
      namespaces: [...nsMap.entries()].sort(([a], [b]) => byName(a, b)).map(([ns, entries]) => ({
        ns,
        entries: [...entries].sort((a, b) => byName(`${a.kind}/${a.name}`, `${b.kind}/${b.name}`)),
      })),
    }));
  }, [tracked]);

  const actions: GroupActions = {
    view,
    refreshMs,
    selected,
    onOpen,
    onUntrack: (ref) => save({ tracked: tracked.filter((r) => !sameTrack(r, ref)) }),
    onSetFields: (ref, fields) => save({
      tracked: tracked.map((r) => {
        if (!sameTrack(r, ref)) return r;
        const { fields: _old, ...rest } = r;
        return fields ? { ...rest, fields } : rest;
      }),
    }),
  };

  return (
    <div className="tracked">
      <div className="tracked-bar">
        <span className="muted small">{t('tracked.summary')}</span>
        <span className="spacer" />
        <div className="seg-toggle" role="group">
          {(['cards', 'list'] as const).map((v) => (
            <button key={v} className={`btn btn-ghost btn-sm${view === v ? ' on' : ''}`} onClick={() => save({ trackedView: v })} aria-pressed={view === v}>
              <Icon name={v === 'cards' ? 'grid' : 'list'} size={14} />
              <span className="label">{t(v === 'cards' ? 'tracked.cards' : 'tracked.list')}</span>
            </button>
          ))}
        </div>
      </div>

      {tracked.length === 0 && <Empty title={t('tracked.emptyTitle')}>{t('tracked.emptyHint')}</Empty>}

      {contexts.map(({ ctx, namespaces }) => (
        <section key={ctx} className="tracked-ctx">
          <h2 className="tracked-ctx-head"><span className="tag">ctx</span>{ctx}</h2>
          {namespaces.map(({ ns, entries }) => (
            <Group key={ns} ctx={ctx} ns={ns} entries={entries} {...actions} />
          ))}
        </section>
      ))}
    </div>
  );
}

/** One namespace of one context: a single pods request, so an unreachable cluster fails only here. */
function Group({ ctx, ns, entries, view, refreshMs, selected, onOpen, onUntrack, onSetFields }: GroupActions & { ctx: string; ns: string; entries: TrackedRef[] }) {
  const list = useAsync(() => api.list(ctx, 'pods', ns), [ctx, ns], refreshMs);

  const podsOf = useMemo(() => {
    const map = new Map<TrackedRef, any[]>(entries.map((e) => [e, []]));
    for (const pod of list.data?.items ?? []) {
      const entry = entryOf(entries, ctx, pod);
      if (entry) map.get(entry)!.push(pod);
    }
    for (const pods of map.values()) pods.sort((a, b) => byName(a.metadata?.name ?? '', b.metadata?.name ?? ''));
    return map;
  }, [list.data, entries, ctx]);

  const pods = entries.flatMap((e) => podsOf.get(e) ?? []);
  const missing = list.data ? entries.filter((e) => !podsOf.get(e)?.length) : [];
  const isSelected = (pod: any) => !!selected && selected.ctx === ctx && selected.ns === ns && selected.name === pod.metadata?.name;
  const selectedKey = pods.find(isSelected)?.metadata?.uid;

  const star = (entry: TrackedRef) => (
    <button className="btn btn-ghost btn-sm star-btn on" onClick={(e) => { e.stopPropagation(); onUntrack(entry); }}
      title={t('track.remove')} aria-label={t('track.remove')}>
      <Icon name="star" size={14} />
    </button>
  );

  return (
    <div className="tracked-ns">
      <div className="tracked-ns-head">
        <span className="tag">ns</span>
        <span className="tracked-ns-name">{ns}</span>
        {list.data && <span className="count">{pods.length}</span>}
        <span className="spacer" />
        <button className="btn btn-ghost btn-xs" onClick={list.reload} title={t('topbar.refreshNow')}>
          {list.loading ? <Spinner small /> : <Icon name="refresh" size={13} />}
        </button>
      </div>

      {list.error && <ErrorBanner error={list.error} onRetry={list.reload} compact />}
      {!list.data && !list.error && <div className="loading-rows"><div className="skeleton" /></div>}

      {list.data && view === 'list' && pods.length > 0 && (
        <ResourceTable
          kind={KIND_BY_TYPE.get('pods')!}
          items={pods}
          filter=""
          showNamespace={false}
          selectedKey={selectedKey}
          onOpen={(pod) => onOpen(ctx, pod)}
          leading={(pod) => { const entry = entryOf(entries, ctx, pod); return entry ? star(entry) : null; }}
        />
      )}
      {list.data && view === 'list' && missing.map((entry) => (
        <div key={`${entry.kind}/${entry.name}`} className="tracked-missing">
          {star(entry)}
          <span className="mono">{entry.kind}/{entry.name}</span>
          <span className="muted small">{t('tracked.noPods')}</span>
        </div>
      ))}

      {list.data && view === 'cards' && (
        <div className="dash-grid tracked-grid">
          {entries.flatMap((entry) => (podsOf.get(entry) ?? []).map((pod) => (
            <PodCard key={pod.metadata?.uid ?? pod.metadata?.name} pod={pod} entry={entry} selected={isSelected(pod)}
              star={star(entry)} onOpen={() => onOpen(ctx, pod)} onSetFields={(f) => onSetFields(entry, f)} />
          )))}
          {missing.map((entry) => (
            <div key={`${entry.kind}/${entry.name}`} className="card tracked-card tracked-gone">
              <div className="tc-head">
                <span className="tc-name" title={entry.name}>{entry.name}</span>
                {star(entry)}
              </div>
              <div className="tc-owner muted small">{entry.kind}/{entry.name}</div>
              <div className="muted small">{t('tracked.noPods')}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PodCard({ pod, entry, selected, star, onOpen, onSetFields }: {
  pod: any;
  entry: TrackedRef;
  selected: boolean;
  star: ReactNode;
  onOpen: () => void;
  onSetFields: (fields: string[] | undefined) => void;
}) {
  const [menu, setMenu] = useState(false);
  const status = podStatus(pod);
  const name = pod.metadata?.name ?? '';

  return (
    <div
      className={`card tracked-card tone-${status.tone}${selected ? ' on' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(); }}
    >
      <div className="tc-head">
        <span className="tc-name" title={name}>{name}</span>
        <Badge tone={status.tone}>{status.text}</Badge>
        <button className={`btn btn-ghost btn-sm${menu ? ' on' : ''}`} onClick={(e) => { e.stopPropagation(); setMenu((m) => !m); }}
          title={t('tracked.fields')} aria-label={t('tracked.fields')}>
          <Icon name="gear" size={14} />
        </button>
        {star}
      </div>
      <div className="tc-owner muted small" title={`${entry.kind}/${entry.name}`}>{entry.kind}/{entry.name}</div>
      <dl className="tc-fields">
        {fieldsOf(entry).map((f) => (
          <div key={f.id} className="tc-field">
            <dt>{t(f.label)}</dt>
            <dd>{renderCell(f.get(pod))}</dd>
          </div>
        ))}
      </dl>
      {menu && <FieldMenu entry={entry} onChange={onSetFields} onClose={() => setMenu(false)} />}
    </div>
  );
}

function FieldMenu({ entry, onChange, onClose }: { entry: TrackedRef; onChange: (fields: string[] | undefined) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const current = entry.fields ?? DEFAULT_FIELDS;

  useEffect(() => {
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc, true); };
  }, [onClose]);

  const toggle = (id: string) => {
    const next = current.includes(id) ? current.filter((f) => f !== id) : [...current, id];
    // Keep the catalog order so every card lists fields the same way.
    onChange(TRACK_FIELDS.map((f) => f.id).filter((f) => next.includes(f)));
  };

  return (
    <div ref={ref} className="tc-menu" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="tc-menu-title">{t('tracked.fields')}</div>
      <div className="muted small">{t('tracked.fieldsHint', { name: `${entry.kind}/${entry.name}`, max: MAX_FIELDS })}</div>
      {TRACK_FIELDS.map((f) => {
        const on = current.includes(f.id);
        return (
          <label key={f.id} className="tc-menu-item">
            <input type="checkbox" checked={on} disabled={!on && current.length >= MAX_FIELDS} onChange={() => toggle(f.id)} />
            {t(f.label)}
          </label>
        );
      })}
      {entry.fields && <button className="btn btn-ghost btn-xs" onClick={() => onChange(undefined)}>{t('tracked.fieldsReset')}</button>}
    </div>
  );
}
