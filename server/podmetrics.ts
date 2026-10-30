import { kubectlGet, checkName } from './kube.js';
import { parseCpu, parseMemory } from './quantity.js';

export const METRICS_API = '/apis/metrics.k8s.io/v1beta1';

export interface PodUsage {
  /** Cores. */
  cpu: number;
  /** Bytes. */
  memory: number;
  containers: Record<string, { cpu: number; memory: number }>;
}

export async function rawJson(ctx: string, path: string): Promise<any> {
  return kubectlGet(ctx, path);
}

/**
 * Current usage per pod from metrics-server, keyed `namespace/name`.
 * Best effort: without metrics-server (or without permission) the map is empty and the UI shows a dash.
 */
export async function podUsage(ctx: string, ns?: string, name?: string): Promise<Map<string, PodUsage>> {
  const all = !ns || ns === '*';
  const path = all
    ? `${METRICS_API}/pods`
    : `${METRICS_API}/namespaces/${checkName(ns, 'namespace')}/pods${name ? `/${checkName(name, 'name')}` : ''}`;
  const out = new Map<string, PodUsage>();
  try {
    const data = await rawJson(ctx, path);
    for (const m of data.items ?? [data]) {
      const usage: PodUsage = { cpu: 0, memory: 0, containers: {} };
      for (const c of m.containers ?? []) {
        const cpu = parseCpu(c.usage?.cpu);
        const memory = parseMemory(c.usage?.memory);
        usage.cpu += cpu;
        usage.memory += memory;
        usage.containers[c.name] = { cpu, memory };
      }
      out.set(`${m.metadata?.namespace}/${m.metadata?.name}`, usage);
    }
  } catch {
    // metrics unavailable
  }
  return out;
}

/** Sets `usage` on each pod that has a metrics sample. */
export function attachUsage(pods: any[], usage: Map<string, PodUsage>) {
  for (const pod of pods) {
    const u = usage.get(`${pod.metadata?.namespace}/${pod.metadata?.name}`);
    if (!u) continue;
    const containers: any[] = pod.spec?.containers ?? [];
    // 0 means "not set": a total only counts when every container defines it.
    const sum = (kind: 'requests' | 'limits', res: 'cpu' | 'memory') => {
      const parse = res === 'cpu' ? parseCpu : parseMemory;
      return containers.every((c) => c.resources?.[kind]?.[res])
        ? containers.reduce((s, c) => s + parse(c.resources[kind][res]), 0)
        : 0;
    };
    pod.usage = {
      ...u,
      requests: { cpu: sum('requests', 'cpu'), memory: sum('requests', 'memory') },
      limits: { cpu: sum('limits', 'cpu'), memory: sum('limits', 'memory') },
    };
  }
}
