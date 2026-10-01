import { useEffect, useState } from 'react';
import { api, errorOf, type AksCluster, type ApiError, type AzureSubscription, type StepResult } from '../api';
import { t, tryT } from '../i18n';
import { ErrorBanner, Icon, Spinner } from './ui';

interface Props {
  existingContexts: string[];
  onClose: () => void;
  onDone: (context: string, protect: boolean) => void;
}

export function AddClusterDialog({ existingContexts, onClose, onDone }: Props) {
  const [subscription, setSubscription] = useState('');
  const [resourceGroup, setResourceGroup] = useState('');
  const [cluster, setCluster] = useState('');
  const [contextName, setContextName] = useState('');
  const [namespace, setNamespace] = useState('');
  const [kubelogin, setKubelogin] = useState(true);
  const [protect, setProtect] = useState(true);

  const [subs, setSubs] = useState<AzureSubscription[]>([]);
  const [subsError, setSubsError] = useState<ApiError>();
  const [subsLoading, setSubsLoading] = useState(true);
  const [clusters, setClusters] = useState<AksCluster[] | null>(null);
  const [clustersError, setClustersError] = useState<ApiError>();
  const [clustersLoading, setClustersLoading] = useState(false);

  const [preview, setPreview] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [result, setResult] = useState<{ context: string; steps: StepResult[] } | null>(null);

  const loadSubs = () => {
    setSubsLoading(true);
    setSubsError(undefined);
    api.azureSubscriptions()
      .then((list) => {
        setSubs(list);
        setSubscription((s) => s || list.find((x) => x.isDefault)?.name || '');
      })
      .catch((e) => setSubsError(errorOf(e)))
      .finally(() => setSubsLoading(false));
  };
  useEffect(loadSubs, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !running && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, running]);

  const body = {
    subscription: subscription.trim(),
    resourceGroup: resourceGroup.trim(),
    cluster: cluster.trim(),
    contextName: contextName.trim() || undefined,
    namespace: namespace.trim() || undefined,
    kubelogin,
  };
  const complete = !!(body.subscription && body.resourceGroup && body.cluster);
  const finalContext = body.contextName ?? body.cluster;
  const overwrites = !!finalContext && existingContexts.includes(finalContext);

  // The preview comes from the server (dry run), so it is exactly what will run.
  useEffect(() => {
    if (!complete) {
      setPreview([]);
      return;
    }
    const id = window.setTimeout(() => {
      api.addAks({ ...body, dryRun: true })
        .then((r) => { setPreview(r.steps.map((s) => s.command)); setError(undefined); })
        .catch((e) => { setPreview([]); setError(errorOf(e)); });
    }, 250);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body.subscription, body.resourceGroup, body.cluster, body.contextName, body.namespace, kubelogin]);

  const findClusters = () => {
    if (!body.subscription) return;
    setClustersLoading(true);
    setClustersError(undefined);
    setClusters(null);
    api.azureClusters(body.subscription)
      .then(setClusters)
      .catch((e) => setClustersError(errorOf(e)))
      .finally(() => setClustersLoading(false));
  };

  const submit = async () => {
    if (!complete || running) return;
    setRunning(true);
    setError(undefined);
    try {
      setResult(await api.addAks(body));
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setRunning(false);
    }
  };

  const optional = <em className="muted">({t('common.optional')})</em>;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="modal modal-wide" role="dialog" aria-modal="true">
        <header className="modal-head">
          <h3>{t('aks.title')}</h3>
          <button className="btn btn-ghost" onClick={onClose} disabled={running}><Icon name="close" /></button>
        </header>

        {result ? (
          <>
            <div className="modal-body">
              <p>{t('aks.added', { name: result.context })}</p>
              <StepList steps={result.steps} />
            </div>
            <footer className="modal-foot">
              <button className="btn btn-ghost" onClick={onClose}>{t('common.close')}</button>
              <button className="btn btn-primary" onClick={() => onDone(result.context, protect)}>{t('aks.open')}</button>
            </footer>
          </>
        ) : (
          <>
            <div className="modal-body">
              <p>{t('aks.intro')}</p>

              {subsError && <ErrorBanner error={subsError} compact onRetry={loadSubs} />}

              <label className="field">
                <span>{t('aks.account')} {subsLoading && <Spinner small />}</span>
                <div className="row">
                  <input
                    list="az-subs"
                    value={subscription}
                    onChange={(e) => { setSubscription(e.target.value); setClusters(null); }}
                    placeholder="my-subscription"
                    spellCheck={false}
                    autoFocus
                  />
                  <button className="btn" onClick={findClusters} disabled={!body.subscription || clustersLoading}>
                    {clustersLoading ? <Spinner small /> : <Icon name="search" />} {t('aks.findClusters')}
                  </button>
                </div>
                <datalist id="az-subs">
                  {subs.map((s) => <option key={s.id} value={s.name}>{s.id}</option>)}
                </datalist>
              </label>

              {clustersError && <ErrorBanner error={clustersError} compact onRetry={findClusters} />}
              {clusters && (
                <div className="aks-list">
                  {clusters.length === 0 && <div className="muted small pad">{t('aks.noClusters')}</div>}
                  {clusters.map((c) => (
                    <button
                      key={`${c.resourceGroup}/${c.name}`}
                      className={`aks-item${c.name === body.cluster && c.resourceGroup === body.resourceGroup ? ' active' : ''}`}
                      onClick={() => { setCluster(c.name); setResourceGroup(c.resourceGroup); }}
                    >
                      <strong>{c.name}</strong>
                      <span className="muted small">{c.resourceGroup} · {c.location} · v{c.kubernetesVersion}</span>
                      {c.powerState && c.powerState !== 'Running' && <span className="badge badge-warn">{c.powerState}</span>}
                      {existingContexts.includes(c.name) && <span className="badge badge-muted">{t('aks.inKubeconfig')}</span>}
                    </button>
                  ))}
                </div>
              )}

              <div className="grid-2">
                <label className="field">
                  <span>{t('aks.resourceGroup')}</span>
                  <input value={resourceGroup} onChange={(e) => setResourceGroup(e.target.value)} placeholder="my-resource-group" spellCheck={false} />
                </label>
                <label className="field">
                  <span>{t('aks.clusterName')}</span>
                  <input value={cluster} onChange={(e) => setCluster(e.target.value)} placeholder="my-aks-cluster" spellCheck={false} />
                </label>
                <label className="field">
                  <span>{t('aks.contextName')} {optional}</span>
                  <input
                    value={contextName}
                    onChange={(e) => setContextName(e.target.value)}
                    placeholder={body.cluster || t('aks.contextPlaceholder')}
                    spellCheck={false}
                  />
                </label>
                <label className="field">
                  <span>{t('aks.defaultNamespace')} {optional}</span>
                  <input value={namespace} onChange={(e) => setNamespace(e.target.value)} placeholder="default" spellCheck={false} />
                </label>
              </div>

              <label className="check">
                <input type="checkbox" checked={kubelogin} onChange={(e) => setKubelogin(e.target.checked)} />
                <span>{t('aks.kubelogin')}</span>
              </label>
              <label className="check">
                <input type="checkbox" checked={protect} onChange={(e) => setProtect(e.target.checked)} />
                <span>{t('aks.protect')}</span>
              </label>

              {overwrites && <div className="callout callout-warn">{t('aks.overwrites', { name: finalContext })}</div>}

              {preview.length > 0 && (
                <div className="field">
                  <span>{t('aks.commands')}</span>
                  <pre className="cmd">{preview.join('\n')}</pre>
                  <span className="muted small">{t('aks.currentContextNote')}</span>
                </div>
              )}

              {error && <ErrorBanner error={error} compact />}
            </div>
            <footer className="modal-foot">
              {running && <span className="muted small">{t('aks.slow')}</span>}
              <button className="btn btn-ghost" onClick={onClose} disabled={running}>{t('common.cancel')}</button>
              <button className="btn btn-primary" disabled={!complete || running} onClick={submit}>
                {running && <Spinner small />} {t('aks.add')}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function StepList({ steps }: { steps: StepResult[] }) {
  return (
    <div className="steps">
      {steps.map((s) => {
        const note = s.note ? tryT(`note.${s.note}`) : undefined;
        return (
          <div key={s.command} className={`step${s.ok ? ' ok' : ' warn'}`}>
            <Icon name={s.ok ? 'check' : 'alert'} />
            <div>
              <div>{tryT(`step.${s.step}`) ?? s.step}</div>
              <code className="small">{s.command}</code>
              {note && <div className="small warn-text">{note}</div>}
              {s.output && <pre className="step-output">{s.output}</pre>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
