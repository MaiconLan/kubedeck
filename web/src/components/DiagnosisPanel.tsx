import { useMemo } from 'react';
import { api } from '../api';
import {
  DIAGNOSABLE, diagnoseResult, diagnosisAsText, needsDiagnosis, text, type DiagAction, type Diagnosis, type DiagnoseResult,
} from '../diagnosis';
import { podStatus, readyCount, restarts } from '../format';
import { useAsync } from '../hooks';
import { t, type MessageKey } from '../i18n';
import { CopyButton, Icon, Spinner } from './ui';

interface Props {
  ctx: string;
  obj: any;
  onAction: (action: DiagAction, container?: string) => void;
  onNavigate: (kindName: string, name: string, ns?: string) => void;
}

const ACTION_META: Record<DiagAction, { label: MessageKey; icon: string }> = {
  previousLogs: { label: 'diag.previousLogs', icon: 'terminal' },
  logs: { label: 'diag.viewLogs', icon: 'terminal' },
  yaml: { label: 'diag.viewYaml', icon: 'list' },
  events: { label: 'diag.viewEvents', icon: 'alert' },
};

const MAX_SHOWN = 4;

/** "Why isn't this running?": only rendered for unhealthy pods and workloads. */
export function DiagnosisPanel(props: Props) {
  const { obj } = props;
  const type = DIAGNOSABLE[obj?.kind];
  if (!type || !needsDiagnosis(obj)) return null;
  return <DiagnosisLoader {...props} type={type} />;
}

/** Changes whenever the object's health changes, so the diagnosis re-runs only then. */
function healthKey(obj: any): string {
  if (obj.kind === 'Pod') return `${podStatus(obj).text}|${readyCount(obj).join('/')}|${restarts(obj)}`;
  const st = obj.status ?? {};
  return `${st.readyReplicas ?? st.numberReady ?? 0}|${st.replicas ?? 0}|${st.failed ?? 0}|${JSON.stringify((st.conditions ?? []).map((c: any) => [c.type, c.status, c.reason]))}`;
}

function DiagnosisLoader({ ctx, obj, type, onAction, onNavigate }: Props & { type: string }) {
  const name = obj.metadata?.name;
  const ns = obj.metadata?.namespace;
  const key = healthKey(obj);
  const { data, error } = useAsync(
    () => api.diagnose(ctx, type, name, ns) as Promise<DiagnoseResult>,
    [ctx, type, name, ns, key],
  );
  const list = useMemo(() => (data ? diagnoseResult(data) : []), [data]);

  if (error) return <div className="diag-note muted small"><Icon name="alert" size={14} /> {t('diag.unavailable')}</div>;
  if (!data) return <div className="diag-note muted small"><Spinner small /> {t('diag.analyzing')}</div>;
  if (!list.length) return <div className="diag-note muted small"><Icon name="search" size={14} /> {t('diag.noneFound')}</div>;

  return (
    <div className="diag-list">
      {list.slice(0, MAX_SHOWN).map((d, i) => (
        <DiagnosisCard
          key={`${d.title.key}-${d.container ?? ''}-${d.pod?.name ?? ''}-${i}`}
          d={d}
          subject={`${obj.kind}/${name}${ns ? ` (${ns})` : ''}`}
          compact={i > 0}
          onAction={onAction}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
}

function DiagnosisCard({ d, subject, compact, onAction, onNavigate }: {
  d: Diagnosis;
  subject: string;
  compact: boolean;
  onAction: Props['onAction'];
  onNavigate: Props['onNavigate'];
}) {
  // Actions open tabs of the object being viewed; for a workload, "logs" means the pod's logs.
  const actions = d.pod ? d.actions.filter((a) => a === 'events' || a === 'yaml') : d.actions;
  return (
    <section className={`diag diag-${d.severity}${compact ? ' compact' : ''}`}>
      <header className="diag-head">
        <Icon name={d.severity === 'info' ? 'search' : 'alert'} size={18} />
        <div className="diag-head-text">
          <div className="diag-cat">{t('diag.heading')} · {t(`diag.cat.${d.category}`)}</div>
          <h4 className="diag-title">{text(d.title)}</h4>
          {d.detail && <div className="diag-detail">{text(d.detail)}</div>}
          {d.bullets && d.bullets.length > 0 && (
            <ul className="diag-bullets">{d.bullets.map((b, i) => <li key={i}>{text(b)}</li>)}</ul>
          )}
          {d.pod && (
            <div className="diag-pod">
              {t('diag.fromPod')}{' '}
              <button className="link" onClick={() => onNavigate('Pod', d.pod!.name, d.pod!.ns)}>{d.pod.name}</button>
              {(d.affected ?? 1) > 1 && <span className="muted"> · {t('diag.affected', { n: d.affected! })}</span>}
            </div>
          )}
        </div>
      </header>
      <div className="diag-body">
        <div>
          <div className="mono-label">{t('diag.evidence')}</div>
          <pre className="diag-evidence">{d.evidence.join('\n')}</pre>
        </div>
        <div>
          <div className="mono-label">{t('diag.whatToDo')}</div>
          <p className="diag-fix">{text(d.fix)}</p>
        </div>
        <div className="diag-actions">
          {actions.map((a) => (
            <button key={a} className="btn btn-sm" onClick={() => onAction(a, d.container)}>
              <Icon name={ACTION_META[a].icon} size={14} /> {t(ACTION_META[a].label)}
            </button>
          ))}
          <CopyButton text={diagnosisAsText(d, subject)} label={t('diag.copy')} className="btn-sm" />
        </div>
      </div>
    </section>
  );
}
