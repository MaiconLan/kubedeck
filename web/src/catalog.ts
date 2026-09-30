import {
  age, condition, images, podStatus, ratio, readyCount, readyState, restarts, shortImage, ts, type Tone,
} from './format';
import { t, type MessageKey } from './i18n';

export type Cell = string | number | { text: string; tone?: Tone; title?: string };

export interface Column {
  key: string;
  /** Message key of the column header. */
  label: MessageKey;
  get: (o: any) => Cell;
  sort?: (o: any) => string | number;
  mono?: boolean;
  grow?: boolean;
  align?: 'right';
}

export type ActionName = 'restart' | 'scale' | 'delete' | 'reconcile' | 'suspend' | 'resume';

export interface Kind {
  /** kubectl resource type, fully qualified for non-core groups. */
  type: string;
  label: string;
  kind: string;
  short: string[];
  section: SectionId;
  columns: Column[];
  actions?: ActionName[];
  logs?: boolean;
}

export const HELM_TYPE = 'helm-releases';

const name: Column = { key: 'name', label: 'col.name', get: (o) => o.metadata?.name ?? '', sort: (o) => o.metadata?.name ?? '', grow: true };
const namespace: Column = { key: 'ns', label: 'col.namespace', get: (o) => o.metadata?.namespace ?? '', sort: (o) => o.metadata?.namespace ?? '' };
const ageCol: Column = {
  key: 'age', label: 'col.age', align: 'right',
  get: (o) => ({ text: age(o.metadata?.creationTimestamp), title: o.metadata?.creationTimestamp }),
  sort: (o) => -ts(o.metadata?.creationTimestamp),
};
const imageCol: Column = {
  key: 'images', label: 'col.images', mono: true,
  get: (o) => {
    const spec = o.spec?.template?.spec ?? o.spec?.jobTemplate?.spec?.template?.spec;
    const all = images(spec);
    return { text: all.split(', ').map(shortImage).join(', '), title: all };
  },
};
const readyCol: Column = {
  key: 'ready', label: 'col.status',
  get: (o) => {
    const r = readyState(o);
    return { text: r.text, tone: r.tone, title: r.message };
  },
  sort: (o) => readyState(o).text,
};
const messageCol: Column = { key: 'msg', label: 'col.message', grow: true, get: (o) => readyState(o).message };
const revisionCol = (path: (o: any) => string | undefined): Column => ({
  key: 'rev', label: 'col.revision', mono: true,
  get: (o) => {
    const rev = path(o) ?? '';
    return { text: rev.length > 40 ? `${rev.slice(0, 40)}…` : rev, title: rev };
  },
});

const workloadActions: ActionName[] = ['restart', 'scale'];
const fluxActions: ActionName[] = ['reconcile', 'suspend', 'resume'];

export const KINDS: Kind[] = [
  // ---- Cluster
  {
    type: 'nodes', label: 'Nodes', kind: 'Node', short: ['no', 'node'], section: 'cluster',
    columns: [
      name,
      {
        key: 'status', label: 'col.status',
        get: (o) => {
          const ready = condition(o, 'Ready')?.status === 'True';
          const text = (ready ? 'Ready' : 'NotReady') + (o.spec?.unschedulable ? ',SchedulingDisabled' : '');
          return { text, tone: ready ? (o.spec?.unschedulable ? 'warn' : 'ok') : 'err' };
        },
      },
      {
        key: 'roles', label: 'col.roles',
        get: (o) => Object.keys(o.metadata?.labels ?? {})
          .filter((l) => l.startsWith('node-role.kubernetes.io/'))
          .map((l) => l.split('/')[1]).join(',') || '—',
      },
      { key: 'version', label: 'col.version', get: (o) => o.status?.nodeInfo?.kubeletVersion ?? '', mono: true },
      { key: 'ip', label: 'col.internalIp', mono: true, get: (o) => (o.status?.addresses ?? []).find((a: any) => a.type === 'InternalIP')?.address ?? '' },
      { key: 'cap', label: 'col.cpuMemory', get: (o) => `${o.status?.capacity?.cpu ?? '?'} / ${o.status?.capacity?.memory ?? '?'}` },
      ageCol,
    ],
  },
  {
    type: 'namespaces', label: 'Namespaces', kind: 'Namespace', short: ['ns'], section: 'cluster',
    columns: [
      name,
      { key: 'status', label: 'col.status', get: (o) => ({ text: o.status?.phase ?? '', tone: o.status?.phase === 'Active' ? 'ok' : 'warn' }) },
      ageCol,
    ],
  },
  {
    type: 'events', label: 'Events', kind: 'Event', short: ['ev'], section: 'cluster',
    columns: [
      {
        key: 'last', label: 'col.lastSeen', align: 'right',
        get: (o) => age(o.lastTimestamp || o.eventTime || o.metadata?.creationTimestamp),
        sort: (o) => -ts(o.lastTimestamp || o.eventTime || o.metadata?.creationTimestamp),
      },
      { key: 'type', label: 'col.type', get: (o) => ({ text: o.type ?? '', tone: o.type === 'Warning' ? 'warn' : 'muted' }) },
      { key: 'reason', label: 'col.reason', get: (o) => o.reason ?? '' },
      { key: 'object', label: 'col.object', mono: true, get: (o) => `${o.involvedObject?.kind?.toLowerCase()}/${o.involvedObject?.name}` },
      { key: 'msg', label: 'col.message', grow: true, get: (o) => o.message ?? '' },
      namespace,
      { key: 'count', label: 'col.count', align: 'right', get: (o) => o.count ?? 1, sort: (o) => o.count ?? 1 },
    ],
  },

  // ---- Workloads
  {
    type: 'pods', label: 'Pods', kind: 'Pod', short: ['po', 'pod'], section: 'workloads', logs: true, actions: ['delete'],
    columns: [
      name,
      namespace,
      {
        key: 'ready', label: 'col.ready',
        get: (o) => { const [r, t] = readyCount(o); return ratio(r, t); },
        sort: (o) => readyCount(o)[0] - readyCount(o)[1],
      },
      { key: 'status', label: 'col.status', get: (o) => podStatus(o), sort: (o) => podStatus(o).text },
      {
        key: 'restarts', label: 'col.restarts', align: 'right',
        get: (o) => { const n = restarts(o); return { text: String(n), tone: n > 5 ? 'err' : n > 0 ? 'warn' : 'muted' }; },
        sort: (o) => -restarts(o),
      },
      { key: 'ip', label: 'col.ip', mono: true, get: (o) => o.status?.podIP ?? '' },
      { key: 'node', label: 'col.node', get: (o) => o.spec?.nodeName ?? '' },
      ageCol,
    ],
  },
  {
    type: 'deployments.apps', label: 'Deployments', kind: 'Deployment', short: ['deploy', 'deployment', 'dp'], section: 'workloads',
    logs: true, actions: workloadActions,
    columns: [
      name,
      namespace,
      { key: 'ready', label: 'col.ready', get: (o) => ratio(o.status?.readyReplicas, o.spec?.replicas), sort: (o) => (o.status?.readyReplicas ?? 0) - (o.spec?.replicas ?? 0) },
      { key: 'updated', label: 'col.upToDate', align: 'right', get: (o) => o.status?.updatedReplicas ?? 0 },
      { key: 'available', label: 'col.available', align: 'right', get: (o) => o.status?.availableReplicas ?? 0 },
      imageCol,
      ageCol,
    ],
  },
  {
    type: 'statefulsets.apps', label: 'StatefulSets', kind: 'StatefulSet', short: ['sts'], section: 'workloads',
    logs: true, actions: workloadActions,
    columns: [name, namespace, { key: 'ready', label: 'col.ready', get: (o) => ratio(o.status?.readyReplicas, o.spec?.replicas) }, imageCol, ageCol],
  },
  {
    type: 'daemonsets.apps', label: 'DaemonSets', kind: 'DaemonSet', short: ['ds'], section: 'workloads',
    logs: true, actions: ['restart'],
    columns: [
      name, namespace,
      { key: 'desired', label: 'col.desired', align: 'right', get: (o) => o.status?.desiredNumberScheduled ?? 0 },
      { key: 'ready', label: 'col.ready', get: (o) => ratio(o.status?.numberReady, o.status?.desiredNumberScheduled) },
      imageCol, ageCol,
    ],
  },
  {
    type: 'replicasets.apps', label: 'ReplicaSets', kind: 'ReplicaSet', short: ['rs'], section: 'workloads',
    columns: [
      name, namespace,
      { key: 'ready', label: 'col.ready', get: (o) => ratio(o.status?.readyReplicas, o.spec?.replicas) },
      { key: 'owner', label: 'col.owner', get: (o) => o.metadata?.ownerReferences?.[0]?.name ?? '' },
      ageCol,
    ],
  },
  {
    type: 'jobs.batch', label: 'Jobs', kind: 'Job', short: ['job'], section: 'workloads', logs: true,
    columns: [
      name, namespace,
      {
        key: 'status', label: 'col.status',
        get: (o) => {
          if (condition(o, 'Failed')?.status === 'True') return { text: 'Failed', tone: 'err' };
          if (condition(o, 'Complete')?.status === 'True') return { text: 'Complete', tone: 'ok' };
          return { text: o.status?.active ? 'Running' : 'Pending', tone: 'info' };
        },
      },
      { key: 'completions', label: 'col.completions', get: (o) => `${o.status?.succeeded ?? 0}/${o.spec?.completions ?? 1}` },
      {
        key: 'duration', label: 'col.duration',
        get: (o) => {
          const start = ts(o.status?.startTime);
          const end = ts(o.status?.completionTime) || Date.now();
          return start ? `${Math.round((end - start) / 1000)}s` : '';
        },
      },
      ageCol,
    ],
  },
  {
    type: 'cronjobs.batch', label: 'CronJobs', kind: 'CronJob', short: ['cj'], section: 'workloads',
    columns: [
      name, namespace,
      { key: 'schedule', label: 'col.schedule', mono: true, get: (o) => o.spec?.schedule ?? '' },
      { key: 'suspend', label: 'col.suspended', get: (o) => (o.spec?.suspend ? { text: t('common.yes'), tone: 'warn' } : t('common.no')) },
      { key: 'active', label: 'col.active', align: 'right', get: (o) => (o.status?.active ?? []).length },
      { key: 'last', label: 'col.lastRun', get: (o) => age(o.status?.lastScheduleTime), sort: (o) => -ts(o.status?.lastScheduleTime) },
      ageCol,
    ],
  },

  // ---- Network
  {
    type: 'services', label: 'Services', kind: 'Service', short: ['svc', 'service'], section: 'network',
    columns: [
      name, namespace,
      { key: 'type', label: 'col.type', get: (o) => o.spec?.type ?? '' },
      { key: 'ip', label: 'col.clusterIp', mono: true, get: (o) => o.spec?.clusterIP ?? '' },
      {
        key: 'external', label: 'col.externalIp', mono: true,
        get: (o) => (o.status?.loadBalancer?.ingress ?? []).map((i: any) => i.ip || i.hostname).join(',') || (o.spec?.externalIPs ?? []).join(','),
      },
      {
        key: 'ports', label: 'col.ports', mono: true,
        get: (o) => (o.spec?.ports ?? []).map((p: any) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol}`).join(', '),
      },
      ageCol,
    ],
  },
  {
    type: 'ingresses.networking.k8s.io', label: 'Ingresses', kind: 'Ingress', short: ['ing', 'ingress'], section: 'network',
    columns: [
      name, namespace,
      { key: 'class', label: 'col.class', get: (o) => o.spec?.ingressClassName ?? '' },
      { key: 'hosts', label: 'col.hosts', mono: true, grow: true, get: (o) => (o.spec?.rules ?? []).map((r: any) => r.host ?? '*').join(', ') },
      { key: 'address', label: 'col.address', mono: true, get: (o) => (o.status?.loadBalancer?.ingress ?? []).map((i: any) => i.ip || i.hostname).join(',') },
      ageCol,
    ],
  },
  {
    type: 'ingressroutes.traefik.io', label: 'IngressRoutes', kind: 'IngressRoute', short: ['ir'], section: 'network',
    columns: [
      name, namespace,
      { key: 'entry', label: 'col.entryPoints', get: (o) => (o.spec?.entryPoints ?? []).join(', ') },
      { key: 'match', label: 'col.rules', mono: true, grow: true, get: (o) => (o.spec?.routes ?? []).map((r: any) => r.match).join(' | ') },
      ageCol,
    ],
  },
  {
    type: 'middlewares.traefik.io', label: 'Middlewares', kind: 'Middleware', short: ['mw'], section: 'network',
    columns: [name, namespace, { key: 'type', label: 'col.type', get: (o) => Object.keys(o.spec ?? {}).join(', ') }, ageCol],
  },
  {
    type: 'networkpolicies.networking.k8s.io', label: 'NetworkPolicies', kind: 'NetworkPolicy', short: ['netpol'], section: 'network',
    columns: [name, namespace, { key: 'sel', label: 'col.pods', mono: true, get: (o) => JSON.stringify(o.spec?.podSelector?.matchLabels ?? {}) }, ageCol],
  },

  // ---- Config
  {
    type: 'configmaps', label: 'ConfigMaps', kind: 'ConfigMap', short: ['cm', 'configmap'], section: 'config',
    columns: [name, namespace, { key: 'keys', label: 'col.keys', align: 'right', get: (o) => Object.keys(o.data ?? {}).length + Object.keys(o.binaryData ?? {}).length }, ageCol],
  },
  {
    type: 'secrets', label: 'Secrets', kind: 'Secret', short: ['secret', 'sec'], section: 'config',
    columns: [
      name, namespace,
      { key: 'type', label: 'col.type', get: (o) => o.type ?? '' },
      { key: 'keys', label: 'col.keys', align: 'right', get: (o) => (o.dataKeys ?? []).length },
      ageCol,
    ],
  },
  {
    type: 'serviceaccounts', label: 'ServiceAccounts', kind: 'ServiceAccount', short: ['sa'], section: 'config',
    columns: [name, namespace, ageCol],
  },

  // ---- Storage
  {
    type: 'persistentvolumeclaims', label: 'PVCs', kind: 'PersistentVolumeClaim', short: ['pvc'], section: 'storage',
    columns: [
      name, namespace,
      { key: 'status', label: 'col.status', get: (o) => ({ text: o.status?.phase ?? '', tone: o.status?.phase === 'Bound' ? 'ok' : 'warn' }) },
      { key: 'volume', label: 'col.volume', mono: true, get: (o) => o.spec?.volumeName ?? '' },
      { key: 'cap', label: 'col.capacity', get: (o) => o.status?.capacity?.storage ?? o.spec?.resources?.requests?.storage ?? '' },
      { key: 'sc', label: 'col.storageClass', get: (o) => o.spec?.storageClassName ?? '' },
      ageCol,
    ],
  },
  {
    type: 'persistentvolumes', label: 'PVs', kind: 'PersistentVolume', short: ['pv'], section: 'storage',
    columns: [
      name,
      { key: 'cap', label: 'col.capacity', get: (o) => o.spec?.capacity?.storage ?? '' },
      { key: 'status', label: 'col.status', get: (o) => ({ text: o.status?.phase ?? '', tone: o.status?.phase === 'Bound' ? 'ok' : 'warn' }) },
      { key: 'claim', label: 'col.claim', mono: true, get: (o) => (o.spec?.claimRef ? `${o.spec.claimRef.namespace}/${o.spec.claimRef.name}` : '') },
      { key: 'sc', label: 'col.storageClass', get: (o) => o.spec?.storageClassName ?? '' },
      ageCol,
    ],
  },
  {
    type: 'storageclasses.storage.k8s.io', label: 'StorageClasses', kind: 'StorageClass', short: ['sc'], section: 'storage',
    columns: [name, { key: 'prov', label: 'col.provisioner', get: (o) => o.provisioner ?? '' }, { key: 'reclaim', label: 'col.reclaim', get: (o) => o.reclaimPolicy ?? '' }, ageCol],
  },

  // ---- Flux
  {
    type: 'kustomizations.kustomize.toolkit.fluxcd.io', label: 'Kustomizations', kind: 'Kustomization', short: ['ks', 'kustomization'],
    section: 'flux', actions: fluxActions,
    columns: [
      name, namespace, readyCol,
      { key: 'src', label: 'col.source', get: (o) => `${o.spec?.sourceRef?.kind ?? ''}/${o.spec?.sourceRef?.name ?? ''}` },
      { key: 'path', label: 'col.path', mono: true, get: (o) => o.spec?.path ?? '' },
      revisionCol((o) => o.status?.lastAppliedRevision),
      messageCol, ageCol,
    ],
  },
  {
    type: 'helmreleases.helm.toolkit.fluxcd.io', label: 'HelmReleases', kind: 'HelmRelease', short: ['hr', 'helmrelease'],
    section: 'flux', actions: fluxActions,
    columns: [
      name, namespace, readyCol,
      {
        key: 'chart', label: 'col.chart', mono: true,
        get: (o) => {
          const c = o.spec?.chart?.spec;
          if (c) return `${c.chart}${c.version ? `@${c.version}` : ''}`;
          return o.spec?.chartRef ? `${o.spec.chartRef.kind}/${o.spec.chartRef.name}` : '';
        },
      },
      revisionCol((o) => o.status?.lastAttemptedRevision ?? o.status?.history?.[0]?.chartVersion),
      messageCol, ageCol,
    ],
  },
  {
    type: 'gitrepositories.source.toolkit.fluxcd.io', label: 'GitRepositories', kind: 'GitRepository', short: ['gitrepo', 'gr'],
    section: 'flux', actions: fluxActions,
    columns: [
      name, namespace, readyCol,
      { key: 'url', label: 'col.url', mono: true, get: (o) => o.spec?.url ?? '' },
      { key: 'ref', label: 'col.ref', mono: true, get: (o) => o.spec?.ref?.branch ?? o.spec?.ref?.tag ?? o.spec?.ref?.semver ?? '' },
      revisionCol((o) => o.status?.artifact?.revision),
      ageCol,
    ],
  },
  {
    type: 'helmrepositories.source.toolkit.fluxcd.io', label: 'HelmRepositories', kind: 'HelmRepository', short: ['helmrepo'],
    section: 'flux', actions: fluxActions,
    columns: [name, namespace, readyCol, { key: 'url', label: 'col.url', mono: true, grow: true, get: (o) => o.spec?.url ?? '' }, ageCol],
  },
  {
    type: 'ocirepositories.source.toolkit.fluxcd.io', label: 'OCIRepositories', kind: 'OCIRepository', short: ['ocirepo'],
    section: 'flux', actions: fluxActions,
    columns: [name, namespace, readyCol, { key: 'url', label: 'col.url', mono: true, grow: true, get: (o) => o.spec?.url ?? '' }, revisionCol((o) => o.status?.artifact?.revision), ageCol],
  },
  {
    type: 'helmcharts.source.toolkit.fluxcd.io', label: 'HelmCharts', kind: 'HelmChart', short: ['hc'],
    section: 'flux', actions: fluxActions,
    columns: [name, namespace, readyCol, { key: 'chart', label: 'col.chart', mono: true, get: (o) => `${o.spec?.chart}@${o.spec?.version ?? '*'}` }, revisionCol((o) => o.status?.artifact?.revision), ageCol],
  },

  // ---- Helm (pseudo kind, backed by `helm list`)
  {
    type: HELM_TYPE, label: 'Releases', kind: 'HelmRelease', short: ['helm', 'releases'], section: 'helm',
    columns: [
      { key: 'name', label: 'col.name', grow: true, get: (o) => o.name, sort: (o) => o.name },
      { key: 'ns', label: 'col.namespace', get: (o) => o.namespace, sort: (o) => o.namespace },
      { key: 'rev', label: 'col.revision', align: 'right', get: (o) => o.revision },
      {
        key: 'status', label: 'col.status',
        get: (o) => ({ text: o.status, tone: o.status === 'deployed' ? 'ok' : o.status === 'failed' ? 'err' : 'warn' }),
      },
      { key: 'chart', label: 'col.chart', mono: true, get: (o) => o.chart },
      { key: 'app', label: 'col.app', mono: true, get: (o) => o.app_version },
      {
        key: 'updated', label: 'col.updated', align: 'right',
        get: (o) => { const d = helmDate(o.updated); return { text: age(d), title: o.updated }; },
        sort: (o) => -ts(helmDate(o.updated)),
      },
    ],
  },
];

/** helm prints "2024-05-01 10:00:00.123 +0000 UTC"; make it Date-parsable. */
function helmDate(value: string): string {
  const m = /^(\S+) (\S+?)(\.\d+)? ([+-]\d{2})(\d{2})/.exec(value ?? '');
  return m ? `${m[1]}T${m[2]}${m[4]}:${m[5]}` : value;
}

export type SectionId = 'cluster' | 'workloads' | 'network' | 'config' | 'storage' | 'flux' | 'helm' | 'crds';

export const SECTIONS: SectionId[] = ['cluster', 'workloads', 'network', 'config', 'storage', 'flux', 'helm'];

export const KIND_BY_TYPE = new Map(KINDS.map((k) => [k.type, k]));

/** Map a Kind name (from ownerReferences, events) to our catalog entry. */
export function kindByName(kind: string): Kind | undefined {
  return KINDS.find((k) => k.kind === kind && k.type !== HELM_TYPE);
}

export function genericKind(res: { type: string; kind: string; name: string; shortNames: string[]; namespaced: boolean }): Kind {
  return {
    type: res.type,
    label: res.kind,
    kind: res.kind,
    short: res.shortNames,
    section: 'crds',
    columns: [
      name,
      ...(res.namespaced ? [namespace] : []),
      readyCol,
      messageCol,
      ageCol,
    ],
  };
}
