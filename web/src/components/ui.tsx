import { useState, type ReactNode } from 'react';
import type { ApiError } from '../api';
import type { Tone } from '../format';
import { copyText } from '../hooks';

export function Badge({ tone = 'muted', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      <span className="badge-dot" />
      {children}
    </span>
  );
}

export function Spinner({ small }: { small?: boolean }) {
  return <span className={small ? 'spinner spinner-sm' : 'spinner'} aria-label="carregando" />;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

const HINTS: Record<string, string> = {
  auth: 'Depois de fazer login no terminal, clique em Tentar de novo.',
  forbidden: 'Peça acesso ao time responsável pelo cluster, ou escolha outro namespace.',
  unreachable: 'Confira VPN, se o cluster local está ligado (k3d/k3s) e o endereço no kubeconfig.',
  'missing-binary': 'Instale a ferramenta e garanta que ela está no PATH do terminal onde o kubedeck foi iniciado.',
  token: 'Feche esta aba e abra de novo o endereço que aparece no terminal do kubedeck.',
};

export function ErrorBanner({ error, onRetry, compact }: { error: ApiError; onRetry?: () => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`error-banner error-${error.kind}${compact ? ' compact' : ''}`} role="alert">
      <div className="error-main">
        <Icon name={error.kind === 'auth' ? 'key' : 'alert'} />
        <div className="error-text">
          <strong>{error.message}</strong>
          {HINTS[error.kind] && <span className="error-hint">{HINTS[error.kind]}</span>}
        </div>
        <div className="error-actions">
          {(error.detail || error.command) && (
            <button className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)}>
              {open ? 'Ocultar detalhes' : 'Detalhes'}
            </button>
          )}
          {onRetry && (
            <button className="btn btn-sm" onClick={onRetry}>
              <Icon name="refresh" /> Tentar de novo
            </button>
          )}
        </div>
      </div>
      {open && (
        <pre className="error-detail">
          {error.command && `$ ${error.command}\n\n`}
          {error.detail}
        </pre>
      )}
    </div>
  );
}

export function CopyButton({ text, label = 'Copiar', className = '' }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`btn btn-ghost btn-sm ${className}`}
      onClick={async (e) => {
        e.stopPropagation();
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }
      }}
      title={label}
    >
      <Icon name={done ? 'check' : 'copy'} />
      {label && <span>{done ? 'Copiado' : label}</span>}
    </button>
  );
}

const PATHS: Record<string, string> = {
  alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  key: 'M15 7a2 2 0 1 1 0 .01M21 2l-9.6 9.6a5.5 5.5 0 1 1-2.8-2.8L18 0m-2 4 3 3',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  check: 'M20 6 9 17l-5-5',
  close: 'M18 6 6 18M6 6l12 12',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2-4.3-4.3',
  pause: 'M8 5v14M16 5v14',
  play: 'M7 4v16l13-8z',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  unlock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 7.8-1.2',
  terminal: 'M4 17l6-5-6-5m8 12h8',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2m0 18v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M1 12h2m18 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  restart: 'M1 4v6h6m16 10v-6h-6M20.5 9A9 9 0 0 0 5.6 5.6L1 10m22 4-4.6 4.4A9 9 0 0 1 3.5 15',
  scale: 'M4 14h6v6H4zM14 4h6v6h-6zM10 10l4-4m-4 14 10-10',
  trash: 'M3 6h18M8 6V4h8v2m1 0v14H7V6m3 4v6m4-6v6',
  sync: 'M4 4v5h5M20 20v-5h-5M5 15a7 7 0 0 0 12.6 2M19 9A7 7 0 0 0 6.4 7',
  suspend: 'M10 15V9m4 6V9M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  resume: 'M10 8l6 4-6 4zM12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zm11 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.9 4.2A10.9 10.9 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.2 3.2M6.6 6.6A18.3 18.3 0 0 0 1 12s4 8 11 8a10.8 10.8 0 0 0 5.4-1.4',
  download: 'M12 3v12m-5-5 5 5 5-5M4 21h16',
  wrap: 'M3 6h18M3 12h15a3 3 0 0 1 0 6h-4m2-2-2 2 2 2M3 18h7',
  chevron: 'M9 6l6 6-6 6',
  cube: 'M12 2 3 7v10l9 5 9-5V7zM3 7l9 5 9-5M12 12v10',
  arrowDown: 'M12 5v14m-6-6 6 6 6-6',
  plus: 'M12 5v14M5 12h14',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.cube} />
    </svg>
  );
}
