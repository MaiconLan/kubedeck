import { useMemo, useState, type ReactNode } from 'react';
import type { ApiResource } from '../api';
import { genericKind, KINDS, kindLabel, SECTIONS, type Kind } from '../catalog';
import { t } from '../i18n';
import { BrandMark, Icon } from './ui';

interface Props {
  available: Set<string> | null;
  discovery: ApiResource[];
  current: string;
  onSelect: (kind: Kind) => void;
  /** Global controls pinned to the bottom. */
  footer?: ReactNode;
}

const BUILTIN_GROUPS = new Set([
  '', 'apps', 'batch', 'autoscaling', 'policy', 'networking.k8s.io', 'storage.k8s.io', 'rbac.authorization.k8s.io',
  'apiextensions.k8s.io', 'apiregistration.k8s.io', 'admissionregistration.k8s.io', 'coordination.k8s.io',
  'discovery.k8s.io', 'events.k8s.io', 'flowcontrol.apiserver.k8s.io', 'node.k8s.io', 'scheduling.k8s.io',
  'certificates.k8s.io', 'authentication.k8s.io', 'authorization.k8s.io', 'metrics.k8s.io', 'resource.k8s.io',
  'storagemigration.k8s.io', 'internal.apiserver.k8s.io',
]);

export function Sidebar({ available, discovery, current, onSelect, footer }: Props) {
  const [crdFilter, setCrdFilter] = useState('');
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const known = new Set(KINDS.map((k) => k.type));
  const crdGroups = useMemo(() => {
    const groups = new Map<string, ApiResource[]>();
    for (const r of discovery) {
      if (BUILTIN_GROUPS.has(r.group) || known.has(r.type) || !r.verbs.includes('list')) continue;
      if (crdFilter && !`${r.kind} ${r.group}`.toLowerCase().includes(crdFilter.toLowerCase())) continue;
      groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discovery, crdFilter]);

  return (
    <nav className="sidebar">
      <div className="brand">
        <BrandMark />
        <span>KubeDeck</span>
      </div>
      <div className="side-scroll">
        {SECTIONS.map((section) => {
          const kinds = KINDS.filter((k) => k.section === section && (!available || available.has(k.type)));
          if (!kinds.length) return null;
          return (
            <div key={section} className="side-section">
              <div className="side-title">{t(`section.${section}`)}</div>
              {kinds.map((k) => (
                <button key={k.type} className={`side-item${current === k.type ? ' active' : ''}`} onClick={() => onSelect(k)}>
                  <span>{kindLabel(k)}</span>
                  <span className="side-short">{k.short[0]}</span>
                </button>
              ))}
            </div>
          );
        })}

        {discovery.length > 0 && (
          <div className="side-section">
            <div className="side-title">{t('section.crds')}</div>
            <input className="side-filter" placeholder={t('sidebar.filterCrds')} value={crdFilter} onChange={(e) => setCrdFilter(e.target.value)} />
            {crdGroups.map(([group, list]) => {
              const open = openGroups[group] ?? (!!crdFilter || list.some((r) => r.type === current));
              return (
                <div key={group}>
                  <button className="side-group" onClick={() => setOpenGroups({ ...openGroups, [group]: !open })}>
                    <span className={`chev${open ? ' open' : ''}`}><Icon name="chevron" size={12} /></span>
                    <span className="side-group-name">{group}</span>
                    <span className="side-short">{list.length}</span>
                  </button>
                  {open && list.map((r) => (
                    <button key={r.type} className={`side-item nested${current === r.type ? ' active' : ''}`} onClick={() => onSelect(genericKind(r))}>
                      <span>{r.kind}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {footer && <div className="side-footer">{footer}</div>}
    </nav>
  );
}
