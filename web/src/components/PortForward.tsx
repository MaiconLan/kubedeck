import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage, errorOf, type ApiError, type PortForward } from '../api';
import { age } from '../format';
import { t } from '../i18n';
import type { Target } from './DetailDrawer';
import { Badge, CopyButton, ErrorBanner, Icon, Spinner } from './ui';

interface PortOption {
  port: number;
  label: string;
}

/** Ports the target exposes, so the user can pick instead of typing. */
function portsOf(obj: any): PortOption[] {
  if (obj?.kind === 'Service') {
    return (obj.spec?.ports ?? []).map((p: any) => ({
      port: p.port,
      label: [p.name, `${p.port} → ${p.targetPort ?? p.port}`, p.protocol].filter(Boolean).join(' · '),
    }));
  }
  const spec = obj?.kind === 'Pod' ? obj.spec : obj?.spec?.template?.spec;
  return (spec?.containers ?? []).flatMap((c: any) =>
    (c.ports ?? []).map((p: any) => ({ port: p.containerPort, label: [c.name, p.name, `${p.containerPort}/${p.protocol ?? 'TCP'}`].filter(Boolean).join(' · ') })),
  );
}

interface DialogProps {
  ctx: string;
  target: Target;
  obj: any;
  onClose: () => void;
  onStarted: (fwd: PortForward) => void;
}

export function ForwardDialog({ ctx, target, obj, onClose, onStarted }: DialogProps) {
  const options = useMemo(() => portsOf(obj), [obj]);
  const [remote, setRemote] = useState<number>(options[0]?.port ?? 80);
  const [local, setLocal] = useState<string>(() => defaultLocal(options[0]?.port ?? 80));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError>();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const pickRemote = (port: number) => {
    setRemote(port);
    setLocal(defaultLocal(port));
  };

  const valid = Number.isInteger(remote) && remote > 0 && remote <= 65535 && (local === '' || /^\d{1,5}$/.test(local));

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      onStarted(await api.startForward({
        ctx, ns: target.ns ?? '', type: target.kind.type, name: target.name, remotePort: remote, localPort: Number(local || 0),
      }));
    } catch (e) {
      setError(errorOf(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <header className="modal-head">
          <h3>{t('pf.title')} <span className="muted">{target.kind.kind}/{target.name}</span></h3>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}><Icon name="close" /></button>
        </header>
        <div className="modal-body">
          <p>{t('pf.intro')}</p>
          {options.length > 0 && (
            <div className="field">
              <span>{t('pf.exposedPorts')}</span>
              <div className="port-options">
                {options.map((o) => (
                  <button key={`${o.label}`} className={`chip${remote === o.port ? ' chip-on' : ''}`} onClick={() => pickRemote(o.port)}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="grid-2">
            <label className="field">
              <span>{t('pf.remotePort')}</span>
              <input type="number" min={1} max={65535} value={remote} onChange={(e) => setRemote(Math.floor(Number(e.target.value) || 0))} />
            </label>
            <label className="field">
              <span>{t('pf.localPort')} <em className="muted">({t('pf.autoHint')})</em></span>
              <input
                value={local}
                onChange={(e) => setLocal(e.target.value.replace(/\D/g, '').slice(0, 5))}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder={t('pf.auto')}
                autoFocus
              />
            </label>
          </div>
          {error && <ErrorBanner error={error} compact />}
        </div>
        <footer className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!valid || busy} onClick={submit}>
            {busy && <Spinner small />} {t('pf.start')}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Same number locally when it is unprivileged; otherwise let the server pick a free one. */
function defaultLocal(remote: number): string {
  return remote >= 1024 ? String(remote) : '';
}

interface PanelProps {
  forwards: PortForward[];
  onChanged: () => void;
  onClose: () => void;
}

export function ForwardsPanel({ forwards, onChanged, onClose }: PanelProps) {
  const [busy, setBusy] = useState<string | null>(null);

  const stop = async (id: string) => {
    setBusy(id);
    try {
      await api.stopForward(id);
    } catch {
      /* already gone */
    }
    setBusy(null);
    onChanged();
  };

  return (
    <aside className="cmdlog">
      <header className="cmdlog-head">
        <h3><Icon name="plug" /> {t('pf.panelTitle')}</h3>
        <span className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={onClose}><Icon name="close" /></button>
      </header>
      <div className="cmdlog-body">
        {forwards.length === 0 && <div className="muted pad">{t('pf.none')}</div>}
        {forwards.map((f) => {
          const url = `http://localhost:${f.localPort}`;
          return (
            <div key={f.id} className="pf-row">
              <Badge tone={f.status === 'active' ? 'ok' : f.status === 'error' ? 'err' : 'warn'}>{t(`pf.status.${f.status}`)}</Badge>
              <a className="pf-link" href={url} target="_blank" rel="noreferrer">localhost:{f.localPort}</a>
              <span className="pf-arrow muted">→</span>
              <span className="pf-target">
                {f.type.split('.')[0]}/{f.name}:{f.remotePort}
                <span className="muted small"> · {f.ns} · {f.ctx} · {age(f.startedAt)}</span>
              </span>
              {f.error && <span className="err-text small pf-error" title={f.error.detail}>{errorMessage(f.error)}</span>}
              <span className="spacer" />
              <CopyButton text={url} label="" />
              <button className="btn btn-ghost btn-sm" onClick={() => stop(f.id)} disabled={busy === f.id} title={t('pf.stop')}>
                {busy === f.id ? <Spinner small /> : <Icon name="close" />}
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
