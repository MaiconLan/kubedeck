import { invalid } from './errors.js';
import { checkName, kubectl, kubectlJson } from './kube.js';

/**
 * Gathers the facts needed to explain why a pod or workload is unhealthy.
 * The rules that turn facts into an explanation live in the UI (web/src/diagnosis.ts)
 * so the text can be translated; this module only collects data.
 */

const WORKLOAD_TYPES: Record<string, string> = {
  'deployments.apps': 'Deployment',
  'statefulsets.apps': 'StatefulSet',
  'daemonsets.apps': 'DaemonSet',
  'replicasets.apps': 'ReplicaSet',
  'jobs.batch': 'Job',
};

const MAX_PODS = 3;
const LOG_LINES = 20;

export interface PodFacts {
  pod: any;
  events: any[];
  /** Last lines of the previous run of each crashing container. */
  previousLogs: Record<string, string[]>;
  /** Objects the pod references that do not exist in its namespace. */
  missing: { secrets: string[]; configMaps: string[]; pvcs: string[] };
  pvcs: Array<{ name: string; phase: string }>;
}

export interface DiagnoseResult {
  kind: string;
  pod?: PodFacts;
  workload?: {
    object: any;
    /** Events of the workload and of the ReplicaSets it owns (FailedCreate lives there). */
    events: any[];
    pods: PodFacts[];
    podCount: number;
  };
}

async function safe<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch {
    return fallback;
  }
}

async function eventsFor(ctx: string, ns: string, kind: string, name: string): Promise<any[]> {
  return safe(async () => {
    const data = await kubectlJson(ctx, ['get', 'events', '-n', ns, '--field-selector', `involvedObject.kind=${kind},involvedObject.name=${name}`]);
    return slimEvents(data.items ?? []);
  }, []);
}

function slimEvents(items: any[]): any[] {
  const when = (e: any) => Date.parse(e.lastTimestamp || e.eventTime || e.metadata?.creationTimestamp || 0) || 0;
  return items
    .sort((a, b) => when(b) - when(a))
    .slice(0, 30)
    .map((e) => ({
      type: e.type,
      reason: e.reason,
      message: e.message,
      count: e.count ?? 1,
      lastTimestamp: e.lastTimestamp || e.eventTime || e.metadata?.creationTimestamp,
      object: `${e.involvedObject?.kind}/${e.involvedObject?.name}`,
    }));
}

/** Names of the Secrets, ConfigMaps and PVCs a pod spec points at. */
function references(spec: any) {
  const secrets = new Set<string>();
  const configMaps = new Set<string>();
  const pvcs = new Set<string>();
  for (const v of spec?.volumes ?? []) {
    if (v.secret?.secretName && !v.secret.optional) secrets.add(v.secret.secretName);
    if (v.configMap?.name && !v.configMap.optional) configMaps.add(v.configMap.name);
    if (v.persistentVolumeClaim?.claimName) pvcs.add(v.persistentVolumeClaim.claimName);
    for (const src of v.projected?.sources ?? []) {
      if (src.secret?.name && !src.secret.optional) secrets.add(src.secret.name);
      if (src.configMap?.name && !src.configMap.optional) configMaps.add(src.configMap.name);
    }
  }
  for (const c of [...(spec?.containers ?? []), ...(spec?.initContainers ?? [])]) {
    for (const e of c.envFrom ?? []) {
      if (e.secretRef?.name && !e.secretRef.optional) secrets.add(e.secretRef.name);
      if (e.configMapRef?.name && !e.configMapRef.optional) configMaps.add(e.configMapRef.name);
    }
    for (const e of c.env ?? []) {
      const s = e.valueFrom?.secretKeyRef;
      const m = e.valueFrom?.configMapKeyRef;
      if (s?.name && !s.optional) secrets.add(s.name);
      if (m?.name && !m.optional) configMaps.add(m.name);
    }
  }
  for (const r of spec?.imagePullSecrets ?? []) if (r.name) secrets.add(r.name);
  configMaps.delete('kube-root-ca.crt');
  return { secrets: [...secrets], configMaps: [...configMaps], pvcs: [...pvcs] };
}

function containerIsFailing(status: any): boolean {
  const waiting = status.state?.waiting?.reason;
  const term = status.state?.terminated;
  return waiting === 'CrashLoopBackOff' || (!!term && term.exitCode !== 0) || (status.restartCount ?? 0) >= 3;
}

async function podFacts(ctx: string, ns: string, pod: any, names: Set<string> | null): Promise<PodFacts> {
  const name = pod.metadata.name;
  const statuses: any[] = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];

  const [events, logs] = await Promise.all([
    eventsFor(ctx, ns, 'Pod', name),
    Promise.all(
      statuses.filter(containerIsFailing).slice(0, 2).map(async (s) => {
        const text = await safe(
          () => kubectl(ctx, ['logs', name, '-n', ns, '-c', s.name, '--previous', `--tail=${LOG_LINES}`], { timeoutMs: 10_000 }),
          '',
        );
        return [s.name, text.split(/\r?\n/).filter((l) => l.trim())] as const;
      }),
    ),
  ]);

  const refs = references(pod.spec);
  const missing = names
    ? {
        secrets: refs.secrets.filter((n) => !names.has(`secret/${n}`)),
        configMaps: refs.configMaps.filter((n) => !names.has(`configmap/${n}`)),
        pvcs: refs.pvcs.filter((n) => !names.has(`persistentvolumeclaim/${n}`)),
      }
    : { secrets: [], configMaps: [], pvcs: [] };

  const pvcs = refs.pvcs.length
    ? await safe(async () => {
        const data = await kubectlJson(ctx, ['get', 'persistentvolumeclaims', '-n', ns]);
        return (data.items ?? [])
          .filter((p: any) => refs.pvcs.includes(p.metadata?.name))
          .map((p: any) => ({ name: p.metadata.name, phase: p.status?.phase ?? '' }));
      }, [] as Array<{ name: string; phase: string }>)
    : [];

  return { pod: slimPod(pod), events, previousLogs: Object.fromEntries(logs.filter(([, l]) => l.length)), missing, pvcs };
}

/** Only what the rules read; secret values are never part of a pod spec, but env values are dropped anyway. */
function slimPod(p: any) {
  const container = (c: any) => ({
    name: c.name,
    image: c.image,
    resources: c.resources,
    readinessProbe: c.readinessProbe,
    livenessProbe: c.livenessProbe,
    startupProbe: c.startupProbe,
    env: (c.env ?? []).map((e: any) => ({ name: e.name, valueFrom: e.valueFrom })),
    envFrom: c.envFrom,
  });
  return {
    metadata: {
      name: p.metadata?.name,
      namespace: p.metadata?.namespace,
      creationTimestamp: p.metadata?.creationTimestamp,
      deletionTimestamp: p.metadata?.deletionTimestamp,
      finalizers: p.metadata?.finalizers,
      ownerReferences: p.metadata?.ownerReferences,
    },
    spec: {
      nodeName: p.spec?.nodeName,
      containers: (p.spec?.containers ?? []).map(container),
      initContainers: (p.spec?.initContainers ?? []).map(container),
      volumes: p.spec?.volumes,
      imagePullSecrets: p.spec?.imagePullSecrets,
    },
    status: p.status,
  };
}

/** Names (kind/name) of Secrets, ConfigMaps and PVCs in the namespace; null when not allowed to list them. */
async function namesIn(ctx: string, ns: string): Promise<Set<string> | null> {
  return safe(async () => {
    const out = await kubectl(ctx, ['get', 'secrets,configmaps,persistentvolumeclaims', '-n', ns, '-o', 'name']);
    // "-o name" prints "secret/x", "configmap/x", "persistentvolumeclaim/x".
    return new Set(out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  }, null);
}

function podRank(p: any): number {
  const statuses: any[] = [...(p.status?.initContainerStatuses ?? []), ...(p.status?.containerStatuses ?? [])];
  if (statuses.some((s) => s.state?.waiting?.reason && s.state.waiting.reason !== 'ContainerCreating')) return 0;
  if (statuses.some((s) => s.state?.terminated && s.state.terminated.exitCode !== 0)) return 1;
  if (p.status?.phase === 'Pending') return 2;
  if (statuses.some((s) => !s.ready)) return 3;
  if (statuses.some((s) => (s.restartCount ?? 0) >= 5)) return 4;
  return 9;
}

export async function diagnose(ctx: string, type: string, name: string, ns: string): Promise<DiagnoseResult> {
  checkName(name, 'name');
  checkName(ns, 'namespace');

  if (type === 'pods') {
    const [pod, names] = await Promise.all([kubectlJson(ctx, ['get', 'pod', name, '-n', ns]), namesIn(ctx, ns)]);
    return { kind: 'Pod', pod: await podFacts(ctx, ns, pod, names) };
  }

  const kind = WORKLOAD_TYPES[type];
  if (!kind) throw invalid('diagnoseNotSupported', `Diagnosis is not available for ${type}.`, { type });

  const object = await kubectlJson(ctx, ['get', type, name, '-n', ns]);
  const labels: Record<string, string> = object.spec?.selector?.matchLabels ?? {};
  const selector = Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',');

  const [ownEvents, rsEvents, podList, names] = await Promise.all([
    eventsFor(ctx, ns, kind, name),
    kind === 'Deployment' ? replicaSetEvents(ctx, ns, object) : Promise.resolve([]),
    selector ? safe(async () => (await kubectlJson(ctx, ['get', 'pods', '-n', ns, '-l', selector])).items ?? [], [] as any[]) : Promise.resolve([] as any[]),
    namesIn(ctx, ns),
  ]);

  const unhealthy = podList.filter((p: any) => podRank(p) < 9).sort((a: any, b: any) => podRank(a) - podRank(b)).slice(0, MAX_PODS);
  const pods = await Promise.all(unhealthy.map((p: any) => podFacts(ctx, ns, p, names)));

  return {
    kind,
    workload: {
      object: { kind, metadata: { name, namespace: ns }, spec: { replicas: object.spec?.replicas, selector: object.spec?.selector, backoffLimit: object.spec?.backoffLimit }, status: object.status },
      events: [...ownEvents, ...rsEvents],
      pods,
      podCount: podList.length,
    },
  };
}

/** FailedCreate (quota, admission webhooks, missing service account) is reported on the ReplicaSet, not the Deployment. */
async function replicaSetEvents(ctx: string, ns: string, deployment: any): Promise<any[]> {
  return safe(async () => {
    const data = await kubectlJson(ctx, ['get', 'replicasets.apps', '-n', ns]);
    const owned = (data.items ?? [])
      .filter((rs: any) => rs.metadata?.ownerReferences?.some((o: any) => o.kind === 'Deployment' && o.uid === deployment.metadata?.uid))
      .sort((a: any, b: any) => Date.parse(b.metadata.creationTimestamp) - Date.parse(a.metadata.creationTimestamp))
      .slice(0, 2);
    const lists = await Promise.all(owned.map((rs: any) => eventsFor(ctx, ns, 'ReplicaSet', rs.metadata.name)));
    return lists.flat();
  }, []);
}

