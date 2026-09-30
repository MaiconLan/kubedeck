import { useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';
import { CopyButton, ErrorBanner, Icon } from './ui';

export function CommandLog({ onClose }: { onClose: () => void }) {
  const [writesOnly, setWritesOnly] = useState(true);
  const { data, error, reload } = useAsync(() => api.commands(), [], 2000);
  const rows = (data ?? []).filter((c) => !writesOnly || c.write);

  return (
    <aside className="cmdlog">
      <header className="cmdlog-head">
        <h3><Icon name="terminal" /> Comandos executados</h3>
        <button className={`chip${writesOnly ? ' chip-on' : ''}`} onClick={() => setWritesOnly(!writesOnly)}>
          Só alterações
        </button>
        <span className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={onClose}><Icon name="close" /></button>
      </header>
      {error && <ErrorBanner error={error} compact onRetry={reload} />}
      <div className="cmdlog-body">
        {rows.length === 0 && <div className="muted pad">Nenhum comando {writesOnly ? 'de alteração ' : ''}ainda.</div>}
        {rows.map((c) => (
          <div key={c.id} className={`cmdlog-row${c.ok ? '' : ' failed'}${c.write ? ' write' : ''}`}>
            <div className="cmdlog-meta">
              <span>{new Date(c.at).toLocaleTimeString('pt-BR')}</span>
              <span>{c.ms} ms</span>
              {!c.ok && <span className="err-text">falhou</span>}
              <span className="spacer" />
              <CopyButton text={c.command} label="" />
            </div>
            <code>{c.command}</code>
          </div>
        ))}
      </div>
    </aside>
  );
}
