import { useState, type DragEvent } from 'react';
import { kindLabel } from '../catalog';
import { t } from '../i18n';
import type { Pane, Tab } from '../tabs';
import { kindForType } from './TabView';
import { Icon } from './ui';

interface Props {
  pane: Pane;
  focused: boolean;
  canSplit: boolean;
  canClosePane: boolean;
  protectedContexts: string[];
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: () => void;
  onSplit: () => void;
  onWindow: () => void;
  onClosePane: () => void;
  onDropTab: (tabId: string, index: number) => void;
}

const DRAG_TYPE = 'application/x-kubedeck-tab';

export function tabTitle(tab: Tab): { title: string; tooltip: string } {
  const { route } = tab;
  const kind = kindForType(route.type);
  if (tab.detail && route.target) {
    const targetKind = kindForType(route.target.type);
    return {
      title: route.target.name,
      tooltip: `${targetKind.kind}/${route.target.name}\n${route.ctx}${route.target.ns ? ` · ${route.target.ns}` : ''}`,
    };
  }
  const scope = route.ns === '*' ? '' : ` · ${route.ns}`;
  return {
    title: `${kindLabel(kind)}${scope}`,
    tooltip: `${kindLabel(kind)}\n${route.ctx}${route.ns === '*' ? '' : ` · ${route.ns}`}${route.target ? `\n› ${route.target.name}` : ''}`,
  };
}

export function TabBar(props: Props) {
  const { pane, focused, protectedContexts } = props;
  const [dropAt, setDropAt] = useState<number | null>(null);

  const onDragOver = (e: DragEvent, index: number) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropAt(index);
  };

  const onDrop = (e: DragEvent, index: number) => {
    const id = e.dataTransfer.getData(DRAG_TYPE);
    setDropAt(null);
    if (id) {
      e.preventDefault();
      props.onDropTab(id, index);
    }
  };

  return (
    <div
      className={`tabbar${focused ? ' focused' : ''}`}
      onDragOver={(e) => onDragOver(e, pane.tabs.length)}
      onDragLeave={() => setDropAt(null)}
      onDrop={(e) => onDrop(e, pane.tabs.length)}
    >
      <div className="tabs-strip" role="tablist">
        {pane.tabs.map((tab, i) => {
          const { title, tooltip } = tabTitle(tab);
          const kind = tab.detail && tab.route.target ? kindForType(tab.route.target.type) : null;
          const guarded = protectedContexts.includes(tab.route.ctx);
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.id === pane.active}
              className={`tab-chip${tab.id === pane.active ? ' active' : ''}${dropAt === i ? ' drop-before' : ''}`}
              title={tooltip}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, tab.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                e.stopPropagation();
                onDragOver(e, i);
              }}
              onDrop={(e) => {
                e.stopPropagation();
                onDrop(e, i);
              }}
              onClick={() => props.onActivate(tab.id)}
              onMouseDown={(e) => e.button === 1 && e.preventDefault()}
              onAuxClick={(e) => e.button === 1 && props.onClose(tab.id)}
            >
              {guarded && <span className="tab-guard" title={t('topbar.protectedOn')}><Icon name="lock" size={11} /></span>}
              {kind && <span className="tab-kind">{kind.kind}</span>}
              <span className="tab-title">{title}</span>
              <span className="tab-ctx">{tab.route.ctx}</span>
              <button
                className="tab-close"
                title={t('tabs.close')}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onClose(tab.id);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          );
        })}
        <button className="btn btn-ghost btn-sm tab-new" onClick={props.onNew} title={t('tabs.new')}><Icon name="plus" /></button>
      </div>
      <div className="tabbar-tools">
        <button className="btn btn-ghost btn-sm" onClick={props.onSplit} disabled={!props.canSplit} title={t('tabs.split')}>
          <Icon name="split" size={15} /><span className="label">{t('btn.split')}</span>
        </button>
        <button className="btn btn-ghost btn-sm" onClick={props.onWindow} title={t('tabs.openInWindow')}>
          <Icon name="window" size={15} /><span className="label">{t('btn.newWindow')}</span>
        </button>
        {props.canClosePane && (
          <button className="btn btn-ghost btn-sm" onClick={props.onClosePane} title={t('tabs.closePane')}><Icon name="close" /></button>
        )}
      </div>
    </div>
  );
}
