import { useEffect } from 'react';
import { KIND_BY_TYPE, kindLabel } from '../catalog';
import { t } from '../i18n';
import { GO_KEYS } from '../route';
import { Icon } from './ui';

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => (e.key === 'Escape' || e.key === '?') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const general: Array<[string, string]> = [
    [': / Ctrl+K', t('keys.palette')],
    ['/', t('keys.filter')],
    ['Esc', t('keys.close')],
    ['Alt+← / Alt+→', t('keys.history')],
    ['?', t('keys.help')],
    ['g f', t('keys.forwards')],
    ['g l', t('keys.commands')],
  ];

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide" role="dialog" aria-modal="true">
        <header className="modal-head">
          <h3><Icon name="keyboard" /> {t('keys.title')}</h3>
          <button className="btn btn-ghost" onClick={onClose}><Icon name="close" /></button>
        </header>
        <div className="modal-body keys">
          <div>
            <h4>{t('keys.general')}</h4>
            {general.map(([k, label]) => <Row key={k} keys={k} label={label} />)}
          </div>
          <div>
            <h4>{t('keys.goTo')}</h4>
            {GO_KEYS.map(({ key, type }) => {
              const kind = KIND_BY_TYPE.get(type);
              return kind ? <Row key={key} keys={`g ${key}`} label={kindLabel(kind)} /> : null;
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ keys, label }: { keys: string; label: string }) {
  return (
    <div className="key-row">
      <span className="key-combo">{keys.split(' ').map((k, i) => <kbd key={i}>{k}</kbd>)}</span>
      <span>{label}</span>
    </div>
  );
}
