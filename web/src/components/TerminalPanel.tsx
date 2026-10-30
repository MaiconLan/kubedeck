import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { ALL } from './TabView';
import { Terminal } from './Terminal';
import type { TermSession } from '../terminals';
import { Icon } from './ui';

interface Props {
  open: boolean;
  sessions: TermSession[];
  active: string;
  /** Context and namespace of the focused tab: the local shell's kubectl/helm use them. */
  ctx: string;
  ns: string;
  protectedContexts: string[];
  onActivate: (id: string) => void;
  onNew: () => void;
  onCloseSession: (id: string) => void;
  onClose: () => void;
}

const HEIGHT_KEY = 'kubedeck.terminalHeight';

function savedHeight(): number {
  try {
    const n = Number(localStorage.getItem(HEIGHT_KEY));
    if (n >= 160) return n;
  } catch { /* storage may be blocked */ }
  return Math.round(window.innerHeight * 0.4);
}

export function TerminalPanel({ open, sessions, active, ctx, ns, protectedContexts, onActivate, onNew, onCloseSession, onClose }: Props) {
  const [height, setHeight] = useState(savedHeight);
  const drag = useRef<{ y: number; h: number }>();

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!drag.current) return;
      const h = Math.max(160, Math.min(window.innerHeight - 120, drag.current.h + drag.current.y - e.clientY));
      setHeight(h);
    };
    const up = () => {
      if (!drag.current) return;
      drag.current = undefined;
      document.body.classList.remove('resizing-v');
      setHeight((h) => {
        try { localStorage.setItem(HEIGHT_KEY, String(h)); } catch { /* best effort */ }
        return h;
      });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, []);

  const current = sessions.find((s) => s.id === active) ?? sessions[0];
  const scopeCtx = current?.kind === 'pod' ? current.ctx : ctx;
  const guarded = protectedContexts.includes(scopeCtx);

  return (
    // Hidden, not unmounted: closing the panel keeps the shells running.
    <aside className="termpanel" style={{ height, display: open ? undefined : 'none' }} aria-label={t('term.title')}>
      <div
        className="termpanel-grip"
        onMouseDown={(e) => {
          e.preventDefault();
          drag.current = { y: e.clientY, h: height };
          document.body.classList.add('resizing-v');
        }}
      />
      <header className="termpanel-head">
        <h3><span className="term-glyph">&gt;_</span> {t('term.title')}</h3>
        <nav className="termpanel-tabs">
          {sessions.map((s) => (
            <div key={s.id} className={`termpanel-tab${s.id === current?.id ? ' active' : ''}`}>
              <button onClick={() => onActivate(s.id)} title={s.kind === 'pod' ? `pod/${s.pod.name}\n${s.ctx} · ${s.pod.ns}` : t('term.shell')}>
                <Icon name={s.kind === 'pod' ? 'cube' : 'terminal'} size={12} />
                <span>{s.kind === 'pod' ? s.pod.name : t('term.shell')}</span>
              </button>
              <button className="termpanel-x" onClick={() => onCloseSession(s.id)} title={t('term.closeSession')} aria-label={t('term.closeSession')}>
                <Icon name="close" size={11} />
              </button>
            </div>
          ))}
          <button className="btn btn-ghost btn-xs" onClick={onNew} title={t('term.newShell')} aria-label={t('term.newShell')}>
            <Icon name="plus" size={13} />
          </button>
        </nav>
        <span className="spacer" />
        {current && (
          <span className={`term-scope${guarded ? ' protected' : ''}`} title={current.kind === 'pod' ? t('term.scopePodHint') : t('term.scopeHint')}>
            {guarded && <Icon name="lock" size={12} />}
            {current.kind === 'pod'
              ? <>pod/{current.pod.name} · <strong>{current.ctx}</strong></>
              : <>kubectl → <strong>{ctx}</strong> · {ns === ALL ? t('content.allNamespaces') : ns}</>}
          </span>
        )}
        <button className="btn btn-ghost btn-sm" onClick={onClose} title={t('term.hide')}><Icon name="close" /></button>
      </header>
      <div className="termpanel-body">
        {sessions.map((s) => (
          <div key={s.id} className="termpanel-session" style={{ display: s.id === current?.id ? undefined : 'none' }}>
            <Terminal
              ctx={s.kind === 'pod' ? s.ctx : ctx}
              ns={s.kind === 'pod' ? s.pod.ns : ns}
              pod={s.kind === 'pod' ? s.pod : undefined}
              visible={open && s.id === current?.id}
              focused={open && s.id === current?.id}
            />
          </div>
        ))}
      </div>
    </aside>
  );
}
