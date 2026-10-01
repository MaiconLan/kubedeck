import { api } from '../api';
import { kindByName } from '../catalog';
import { podStatus, readyCount, restarts, selectorString } from '../format';
import { useAsync } from '../hooks';
import { t } from '../i18n';
import { Badge, Spinner } from './ui';

interface Props {
  ctx: string;
  obj: any;
  onNavigate: (kindName: string, name: string, ns?: string) => void;
}

interface Link {
  kind: string;
  name: string;
  ns?: string;
}

/** Links from this object to the objects it points at or that point at it. */
export function Related({ ctx, obj, onNavigate }: Props) {
  const ns: string | undefined = obj.metadata?.namespace;
  const links = staticLinks(obj);
  const podQuery = podFilter(obj);

  if (!links.length && !podQuery) return null;

  return (
    <section>
      <h4>{t('rel.title')}</h4>
      {links.length > 0 && (
        <div className="rel-links">
          {links.map((l) => {
            const known = !!kindByName(l.kind);
            return (
              <button
                key={`${l.kind}/${l.ns}/${l.name}`}
                className="rel-chip"
                disabled={!known}
                onClick={() => onNavigate(l.kind, l.name, l.ns ?? ns)}
              >
                <span className="muted">{l.kind}</span> {l.name}
              </button>
            );
          })}
        </div>
      )}
      {podQuery && <RelatedPods ctx={ctx} query={podQuery} onNavigate={onNavigate} />}
    </section>
  );
}

function RelatedPods({ ctx, query, onNavigate }: { ctx: string; query: PodQuery; onNavigate: Props['onNavigate'] }) {
  const { data, error } = useAsync(
    () => api.list(ctx, 'pods', query.ns, { labels: query.labels, fields: query.fields }),
    [ctx, query.ns, query.labels, query.fields],
    10_000,
  );
  if (error) return <div className="muted small">{t('rel.podsUnavailable')}</div>;
  if (!data) return <Spinner small />;
  const pods = [...data.items].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  return (
    <div className="rel-pods">
      <div className="muted small">{t('rel.pods', { n: pods.length })}</div>
      {pods.slice(0, 50).map((p) => {
        const s = podStatus(p);
        const [r, total] = readyCount(p);
        return (
          <button key={p.metadata.uid} className="rel-pod" onClick={() => onNavigate('Pod', p.metadata.name, p.metadata.namespace)}>
            <Badge tone={s.tone}>{s.text}</Badge>
            <span className="rel-pod-name">{p.metadata.name}</span>
            <span className="muted small">{r}/{total} · {t('col.restarts')}: {restarts(p)}{query.ns === '*' ? ` · ${p.metadata.namespace}` : ''}</span>
          </button>
        );
      })}
    </div>
  );
}

interface PodQuery {
  ns: string;
  labels?: string;
  fields?: string;
}

function podFilter(obj: any): PodQuery | null {
  const ns = obj.metadata?.namespace;
  switch (obj.kind) {
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
    case 'ReplicaSet':
    case 'Job': {
      const labels = selectorString(obj.spec?.selector?.matchLabels);
      return labels ? { ns, labels } : null;
    }
    case 'Service': {
      const labels = selectorString(obj.spec?.selector);
      return labels ? { ns, labels } : null;
    }
    case 'Node':
      return { ns: '*', fields: `spec.nodeName=${obj.metadata.name}` };
    default:
      return null;
  }
}

function staticLinks(obj: any): Link[] {
  const links: Link[] = [];
  const seen = new Set<string>();
  const push = (kind: string, name?: string, ns?: string) => {
    if (!name || name === 'kube-root-ca.crt') return;
    const k = `${kind}/${ns ?? ''}/${name}`;
    if (seen.has(k)) return;
    seen.add(k);
    links.push({ kind, name, ns });
  };

  const podSpec = obj.kind === 'Pod' ? obj.spec : obj.spec?.template?.spec ?? obj.spec?.jobTemplate?.spec?.template?.spec;
  if (obj.kind === 'Pod' && obj.spec?.nodeName) push('Node', obj.spec.nodeName);
  if (podSpec) {
    if (podSpec.serviceAccountName && podSpec.serviceAccountName !== 'default') push('ServiceAccount', podSpec.serviceAccountName);
    for (const v of podSpec.volumes ?? []) {
      push('ConfigMap', v.configMap?.name);
      push('Secret', v.secret?.secretName);
      push('PersistentVolumeClaim', v.persistentVolumeClaim?.claimName);
      for (const src of v.projected?.sources ?? []) {
        push('ConfigMap', src.configMap?.name);
        push('Secret', src.secret?.name);
      }
    }
    for (const c of [...(podSpec.containers ?? []), ...(podSpec.initContainers ?? [])]) {
      for (const e of c.envFrom ?? []) {
        push('ConfigMap', e.configMapRef?.name);
        push('Secret', e.secretRef?.name);
      }
      for (const e of c.env ?? []) {
        push('ConfigMap', e.valueFrom?.configMapKeyRef?.name);
        push('Secret', e.valueFrom?.secretKeyRef?.name);
      }
    }
    for (const s of podSpec.imagePullSecrets ?? []) push('Secret', s.name);
  }

  if (obj.kind === 'Ingress') {
    push('Service', obj.spec?.defaultBackend?.service?.name);
    for (const r of obj.spec?.rules ?? []) for (const p of r.http?.paths ?? []) push('Service', p.backend?.service?.name);
    for (const tls of obj.spec?.tls ?? []) push('Secret', tls.secretName);
  }
  if (obj.kind === 'IngressRoute') {
    for (const r of obj.spec?.routes ?? []) {
      for (const s of r.services ?? []) if (!s.kind || s.kind === 'Service') push('Service', s.name, s.namespace);
      for (const m of r.middlewares ?? []) push('Middleware', m.name, m.namespace);
    }
    push('Secret', obj.spec?.tls?.secretName);
  }
  if (obj.kind === 'PersistentVolumeClaim') push('PersistentVolume', obj.spec?.volumeName);
  if (obj.kind === 'PersistentVolume' && obj.spec?.claimRef) push('PersistentVolumeClaim', obj.spec.claimRef.name, obj.spec.claimRef.namespace);
  if (obj.kind === 'HelmRelease') {
    const src = obj.spec?.chart?.spec?.sourceRef;
    if (src) push(src.kind, src.name, src.namespace);
    if (obj.spec?.chartRef) push(obj.spec.chartRef.kind, obj.spec.chartRef.name, obj.spec.chartRef.namespace);
  }
  if (obj.kind === 'Kustomization' && obj.spec?.sourceRef) push(obj.spec.sourceRef.kind, obj.spec.sourceRef.name, obj.spec.sourceRef.namespace);
  return links;
}
