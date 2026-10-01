import { podStatus, type Tone } from './format';
import { t } from './i18n';

/** Columns, left to right: how traffic and dependencies flow. */
export const COLUMNS = ['entry', 'service', 'workload', 'pod', 'config'] as const;
export type Column = (typeof COLUMNS)[number];

export interface GraphNode {
  id: string;
  column: Column;
  kind: string;
  name: string;
  ns?: string;
  tone: Tone;
  sub: string;
  /** False for synthetic nodes such as "+3 pods". */
  openable: boolean;
}

export interface Graph {
  nodes: Map<string, GraphNode>;
  edges: Array<[string, string]>;
}

export interface TopologyInput {
  services: any[];
  ingresses: any[];
  ingressRoutes: any[];
  deployments: any[];
  statefulSets: any[];
  daemonSets: any[];
  jobs: any[];
  replicaSets: any[];
  pods: any[];
}

const MAX_PODS_PER_WORKLOAD = 4;

const key = (kind: string, ns: string | undefined, name: string) => `${kind}:${ns ?? ''}/${name}`;

export function buildGraph(input: TopologyInput): Graph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Set<string>();
  const add = (n: GraphNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
    return n.id;
  };
  const link = (from: string, to: string) => edges.add(`${from}\n${to}`);

  // ---- workloads
  const rsOwner = new Map<string, string>();
  for (const rs of input.replicaSets) {
    const owner = rs.metadata?.ownerReferences?.find((o: any) => o.kind === 'Deployment');
    if (owner) rsOwner.set(key('ReplicaSet', rs.metadata.namespace, rs.metadata.name), key('Deployment', rs.metadata.namespace, owner.name));
  }

  const workloads = [...input.deployments, ...input.statefulSets, ...input.daemonSets, ...input.jobs];
  const workloadByKey = new Map<string, any>();
  for (const w of workloads) {
    const kind = w.kind ?? '';
    const id = key(kind, w.metadata.namespace, w.metadata.name);
    workloadByKey.set(id, w);
    add({ id, column: 'workload', kind, name: w.metadata.name, ns: w.metadata.namespace, ...workloadState(w), openable: true });
  }

  // ---- pods, grouped under their workload
  const podOwner = new Map<string, string>();
  const podsByOwner = new Map<string, any[]>();
  for (const p of input.pods) {
    const ns = p.metadata.namespace;
    const ref = p.metadata?.ownerReferences?.[0];
    let owner: string | undefined;
    if (ref?.kind === 'ReplicaSet') owner = rsOwner.get(key('ReplicaSet', ns, ref.name));
    else if (ref) owner = key(ref.kind, ns, ref.name);
    if (owner && !nodes.has(owner)) owner = undefined;
    const podKey = key('Pod', ns, p.metadata.name);
    podOwner.set(podKey, owner ?? podKey);
    const group = owner ?? podKey;
    podsByOwner.set(group, [...(podsByOwner.get(group) ?? []), p]);
  }

  for (const [owner, pods] of podsByOwner) {
    const sorted = [...pods].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
    const shown = sorted.slice(0, MAX_PODS_PER_WORKLOAD);
    for (const p of shown) {
      const s = podStatus(p);
      const id = add({ id: key('Pod', p.metadata.namespace, p.metadata.name), column: 'pod', kind: 'Pod', name: p.metadata.name, ns: p.metadata.namespace, tone: s.tone, sub: s.text, openable: true });
      if (owner !== id) link(owner, id);
    }
    const rest = sorted.length - shown.length;
    if (rest > 0) {
      const tones = sorted.slice(MAX_PODS_PER_WORKLOAD).map((p) => podStatus(p).tone);
      const id = add({
        id: `${owner}#more`, column: 'pod', kind: 'Pod', name: `+${rest}`, ns: sorted[0].metadata.namespace,
        tone: tones.includes('err') ? 'err' : tones.includes('warn') ? 'warn' : 'ok', sub: t('map.morePods'), openable: false,
      });
      link(owner, id);
    }
    // Pods without a workload still show their config dependencies.
    if (!workloadByKey.has(owner)) addConfig(sorted[0].spec, sorted[0].metadata.namespace, owner);
  }

  for (const [id, w] of workloadByKey) {
    addConfig(w.spec?.template?.spec ?? w.spec?.jobTemplate?.spec?.template?.spec, w.metadata.namespace, id);
  }

  function addConfig(spec: any, ns: string, from: string) {
    if (!spec) return;
    const refs = new Set<string>();
    const ref = (kind: string, name?: string) => {
      if (!name || name === 'kube-root-ca.crt') return;
      refs.add(`${kind}\n${name}`);
    };
    for (const v of spec.volumes ?? []) {
      ref('ConfigMap', v.configMap?.name);
      ref('Secret', v.secret?.secretName);
      ref('PersistentVolumeClaim', v.persistentVolumeClaim?.claimName);
      for (const src of v.projected?.sources ?? []) {
        ref('ConfigMap', src.configMap?.name);
        ref('Secret', src.secret?.name);
      }
    }
    for (const c of [...(spec.containers ?? []), ...(spec.initContainers ?? [])]) {
      for (const e of c.envFrom ?? []) {
        ref('ConfigMap', e.configMapRef?.name);
        ref('Secret', e.secretRef?.name);
      }
      for (const e of c.env ?? []) {
        ref('ConfigMap', e.valueFrom?.configMapKeyRef?.name);
        ref('Secret', e.valueFrom?.secretKeyRef?.name);
      }
    }
    for (const r of spec.imagePullSecrets ?? []) ref('Secret', r.name);
    for (const r of refs) {
      const [kind, name] = r.split('\n');
      const id = add({ id: key(kind, ns, name), column: 'config', kind, name, ns, tone: 'muted', sub: kind, openable: true });
      link(from, id);
    }
  }

  // ---- services → workloads (or bare pods)
  const serviceIds = new Map<string, string>();
  for (const svc of input.services) {
    const ns = svc.metadata.namespace;
    const id = key('Service', ns, svc.metadata.name);
    serviceIds.set(`${ns}/${svc.metadata.name}`, id);
    const selector: Record<string, string> = svc.spec?.selector ?? {};
    const targets = new Set<string>();
    if (Object.keys(selector).length) {
      for (const p of input.pods) {
        if (p.metadata.namespace !== ns) continue;
        const labels = p.metadata.labels ?? {};
        if (Object.entries(selector).every(([k, v]) => labels[k] === v)) {
          targets.add(podOwner.get(key('Pod', ns, p.metadata.name))!);
        }
      }
    }
    const noSelector = !Object.keys(selector).length;
    add({
      id, column: 'service', kind: 'Service', name: svc.metadata.name, ns,
      tone: noSelector ? 'muted' : targets.size ? 'ok' : 'warn',
      sub: noSelector ? svc.spec?.type ?? 'Service' : targets.size ? ports(svc) : t('map.noPods'),
      openable: true,
    });
    for (const target of targets) if (nodes.has(target)) link(id, target);
  }

  const serviceNode = (ns: string, name: string) => {
    const existing = serviceIds.get(`${ns}/${name}`);
    if (existing) return existing;
    return add({ id: key('Service', ns, name), column: 'service', kind: 'Service', name, ns, tone: 'err', sub: t('map.missing'), openable: false });
  };

  // ---- entry points
  for (const ing of input.ingresses) {
    const ns = ing.metadata.namespace;
    const hosts = (ing.spec?.rules ?? []).map((r: any) => r.host).filter(Boolean);
    const id = add({ id: key('Ingress', ns, ing.metadata.name), column: 'entry', kind: 'Ingress', name: ing.metadata.name, ns, tone: 'info', sub: hosts.join(', ') || '*', openable: true });
    const backends = new Set<string>();
    if (ing.spec?.defaultBackend?.service?.name) backends.add(ing.spec.defaultBackend.service.name);
    for (const r of ing.spec?.rules ?? []) {
      for (const p of r.http?.paths ?? []) if (p.backend?.service?.name) backends.add(p.backend.service.name);
    }
    for (const b of backends) link(id, serviceNode(ns, b));
  }

  for (const ir of input.ingressRoutes) {
    const ns = ir.metadata.namespace;
    const hosts = (ir.spec?.routes ?? [])
      .flatMap((r: any) => [...String(r.match ?? '').matchAll(/Host\(`([^`]+)`\)/g)].map((m) => m[1]));
    const id = add({ id: key('IngressRoute', ns, ir.metadata.name), column: 'entry', kind: 'IngressRoute', name: ir.metadata.name, ns, tone: 'info', sub: hosts.join(', ') || (ir.spec?.entryPoints ?? []).join(', '), openable: true });
    for (const r of ir.spec?.routes ?? []) {
      for (const s of r.services ?? []) {
        if (s.kind && s.kind !== 'Service') continue;
        link(id, serviceNode(s.namespace ?? ns, s.name));
      }
    }
  }

  return { nodes, edges: [...edges].map((e) => e.split('\n') as [string, string]) };
}

function workloadState(w: any): { tone: Tone; sub: string } {
  if (w.kind === 'Job') {
    if (w.status?.failed && !w.status?.succeeded) return { tone: 'err', sub: 'Failed' };
    return w.status?.succeeded ? { tone: 'muted', sub: 'Complete' } : { tone: 'info', sub: 'Running' };
  }
  const want = w.kind === 'DaemonSet' ? w.status?.desiredNumberScheduled ?? 0 : w.spec?.replicas ?? 0;
  const ready = w.kind === 'DaemonSet' ? w.status?.numberReady ?? 0 : w.status?.readyReplicas ?? 0;
  const tone: Tone = want === 0 ? 'muted' : ready >= want ? 'ok' : ready === 0 ? 'err' : 'warn';
  return { tone, sub: `${w.kind} · ${ready}/${want}` };
}

function ports(svc: any): string {
  return (svc.spec?.ports ?? []).map((p: any) => `${p.port}/${p.protocol ?? 'TCP'}`).join(', ') || svc.spec?.type || '';
}

/** Splits the graph into connected groups so each app gets its own band. */
export function components(graph: Graph): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const id of graph.nodes.keys()) parent.set(id, id);
  for (const [a, b] of graph.edges) {
    if (!parent.has(a) || !parent.has(b)) continue;
    parent.set(find(a), find(b));
  }
  const groups = new Map<string, string[]>();
  for (const id of graph.nodes.keys()) {
    const r = find(id);
    groups.set(r, [...(groups.get(r) ?? []), id]);
  }
  const weight = (ids: string[]) => COLUMNS.indexOf(graph.nodes.get(ids[0])!.column);
  return [...groups.values()]
    .map((ids) => ids.sort((a, b) => COLUMNS.indexOf(graph.nodes.get(a)!.column) - COLUMNS.indexOf(graph.nodes.get(b)!.column)))
    .sort((a, b) => weight(a) - weight(b) || b.length - a.length || graph.nodes.get(a[0])!.name.localeCompare(graph.nodes.get(b[0])!.name));
}

