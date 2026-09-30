import { useEffect, useRef, useState } from 'react';
import { api, errorOf, type ApiError } from '../api';
import type { ActionName } from '../catalog';
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

const COPY: Record<ActionName, { title: string; verb: string; explain: string; danger?: boolean }> = {
  restart: { title: 'Reiniciar', verb: 'Reiniciar', explain: 'Cria novos pods aos poucos (rollout) e remove os antigos. Sem downtime se houver mais de uma réplica.' },
  scale: { title: 'Escalar', verb: 'Aplicar', explain: 'Muda o número de réplicas. Se houver HPA ou Flux gerenciando este recurso, o valor pode ser revertido.' },
  delete: { title: 'Apagar pod', verb: 'Apagar', explain: 'O pod é removido. Se ele pertence a um Deployment/StatefulSet, um novo será criado no lugar.', danger: true },
  reconcile: { title: 'Reconciliar', verb: 'Reconciliar', explain: 'Pede ao Flux para sincronizar agora, sem esperar o próximo intervalo.' },
  suspend: { title: 'Suspender', verb: 'Suspender', explain: 'O Flux para de aplicar mudanças neste recurso até ele ser retomado.', danger: true },
  resume: { title: 'Retomar', verb: 'Retomar', explain: 'O Flux volta a reconciliar este recurso normalmente.' },
};

export function ActionDialog({ ctx, action, target, obj, isProtected, onClose, onDone }: Props) {
  const copy = COPY[action];
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
      onDone(r.output || `${copy.title}: ${target.name}`);
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
            Contexto <strong>{ctx}</strong>
            {target.ns && <> · namespace <strong>{target.ns}</strong></>}
            {isProtected && <span className="protected-tag"><Icon name="lock" size={12} /> protegido</span>}
          </div>
          <p>{copy.explain}</p>

          {action === 'scale' && (
            <label className="field">
              <span>Réplicas (atual: {obj?.spec?.replicas ?? '?'})</span>
              <div className="stepper">
                <button className="btn btn-sm" onClick={() => setReplicas(Math.max(0, replicas - 1))}>−</button>
                <input
                  ref={isProtected ? undefined : input}
                  type="number" min={0} max={1000} value={replicas}
                  onChange={(e) => setReplicas(Math.max(0, Math.min(1000, Math.floor(Number(e.target.value) || 0))))}
                  onKeyDown={(e) => e.key === 'Enter' && submit()}
                />
                <button className="btn btn-sm" onClick={() => setReplicas(Math.min(1000, replicas + 1))}>+</button>
              </div>
            </label>
          )}

          <div className="field">
            <span>Comando que será executado</span>
            <pre className="cmd">{command || '…'}</pre>
          </div>

          {isProtected && (
            <label className="field">
              <span>Este contexto está protegido. Digite <code>{target.name}</code> para confirmar.</span>
              <input
                ref={input}
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
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button ref={isProtected || action === 'scale' ? undefined : (el) => el?.focus()}
            className={`btn ${copy.danger ? 'btn-danger' : 'btn-primary'}`} disabled={!canRun} onClick={submit}>
            {busy && <Spinner small />} {copy.verb}
          </button>
        </footer>
      </div>
    </div>
  );
}
