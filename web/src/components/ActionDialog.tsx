import { useEffect, useRef, useState } from 'react';
import { api, errorOf, type ApiError } from '../api';
import type { ActionName } from '../catalog';
import { t, type MessageKey } from '../i18n';
import type { Target } from './DetailDrawer';
import { ErrorBanner, Icon, Spinner } from './ui';

interface Props {
  ctx: string;
  action: ActionName;
  target: Target;
  obj: any;
  isProtected: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}

const DANGER: Partial<Record<ActionName, boolean>> = { delete: true, suspend: true };

function copyFor(action: ActionName) {
  const key = (part: string) => `actionDialog.${action}.${part}` as MessageKey;
  return { title: t(key('title')), verb: t(key('verb')), explain: t(key('explain')), danger: !!DANGER[action] };
}

export function ActionDialog({ ctx, action, target, obj, isProtected, onClose, onDone }: Props) {
  const copy = copyFor(action);
  const [replicas, setReplicas] = useState<number>(obj?.spec?.replicas ?? 1);
  const [typed, setTyped] = useState('');
  const [command, setCommand] = useState('');
  const [error, setError] = useState<ApiError>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const body = { ctx, ns: target.ns ?? '', type: target.kind.type, name: target.name, action, replicas };

  useEffect(() => {
    api.action({ ...body, dryRun: true })
      .then((r) => setCommand(r.command))
      .catch((e) => setError(errorOf(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replicas]);

  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const canRun = !busy && (!isProtected || typed === target.name) && (action !== 'scale' || Number.isInteger(replicas));

  const submit = async () => {
    if (!canRun) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.action({ ...body, confirmName: isProtected ? typed : undefined });
      onDone(r.output || t('actionDialog.done', { action: copy.title, name: target.name }));
    } catch (e) {
      setError(errorOf(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${copy.danger ? ' modal-danger' : ''}`} role="dialog" aria-modal="true">
        <header className="modal-head">
          <h3>{copy.title} <span className="muted">{target.kind.kind}/{target.name}</span></h3>
          <button className="btn btn-ghost" onClick={onClose}><Icon name="close" /></button>
        </header>
        <div className="modal-body">
          <div className="ctx-line">
            {t('actionDialog.context')} <strong>{ctx}</strong>
            {target.ns && <> · {t('actionDialog.namespace')} <strong>{target.ns}</strong></>}
            {isProtected && <span className="protected-tag"><Icon name="lock" size={12} /> {t('actionDialog.protected')}</span>}
          </div>
          <p>{copy.explain}</p>

          {action === 'scale' && (
            <label className="field">
              <span>{t('actionDialog.replicas', { n: obj?.spec?.replicas ?? '?' })}</span>
              <div className="stepper">
                <div className="stepper-group">
                  <button onClick={() => setReplicas(Math.max(0, replicas - 1))}>−</button>
                  <input
                    ref={isProtected ? undefined : input}
                    type="number" min={0} max={1000} value={replicas}
                    onChange={(e) => setReplicas(Math.max(0, Math.min(1000, Math.floor(Number(e.target.value) || 0))))}
                    onKeyDown={(e) => e.key === 'Enter' && submit()}
                  />
                  <button onClick={() => setReplicas(Math.min(1000, replicas + 1))}>+</button>
                </div>
                <ReplicaDelta from={obj?.spec?.replicas} to={replicas} />
              </div>
            </label>
          )}

          <div className="field">
            <span className="mono-label">{t('actionDialog.command')}</span>
            <pre className="cmd"><span className="prompt">$ </span>{command || '…'}</pre>
          </div>

          {isProtected && (
            <label className="field">
              <span>{t('actionDialog.typeToConfirm', { name: target.name })}</span>
              <input
                ref={input}
                className="confirm-input"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder={target.name}
                spellCheck={false}
              />
            </label>
          )}

          {error && <ErrorBanner error={error} compact />}
        </div>
        <footer className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button ref={isProtected || action === 'scale' ? undefined : (el) => el?.focus()}
            className={`btn ${copy.danger ? 'btn-danger' : 'btn-primary'}`} disabled={!canRun} onClick={submit}>
            {busy && <Spinner small />} {copy.verb}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** "+2" / "−1" next to the stepper, compared with the current replica count. */
function ReplicaDelta({ from, to }: { from?: number; to: number }) {
  if (typeof from !== 'number' || from === to) return null;
  const diff = to - from;
  return <span className={`stepper-delta ${diff > 0 ? 'tone-ok' : 'tone-warn'}`}>{diff > 0 ? `+${diff}` : `−${-diff}`}</span>;
}
