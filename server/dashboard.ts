import { AppError } from './errors.js';
import { demoEnabled } from './demo.js';
import { checkName, kubectl, kubectlGet } from './kube.js';
import { parseCpu, parseMemory } from './quantity.js';
import { METRICS_API, rawJson } from './podmetrics.js';
import { discover, listItems } from './resources.js';

/** Each dashboard section loads independently, so one forbidden call doesn't blank the page. */
type Part<T> = { ok: true; data: T } | { ok: false; error: unknown };

async function part<T>(work: () => Promise<T>): Promise<Part<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof AppError ? err.toJSON() : { kind: 'command', code: 'raw', message: String((err as Error)?.message ?? err) },
    };
  }
}


function resources(containers: any[] | undefined) {
  let cpu = 0;
  let memory = 0;
  let cpuLimit = 0;
  let memoryLimit = 0;
  for (const c of containers ?? []) {
    cpu += parseCpu(c.resources?.requests?.cpu);
    memory += parseMemory(c.resources?.requests?.memory);
    cpuLimit += parseCpu(c.resources?.limits?.cpu);
    memoryLimit += parseMemory(c.resources?.limits?.memory);
  }
  return { cpu, memory, cpuLimit, memoryLimit };
}

/** Pod with only what the dashboard needs; the UI derives status from it. */
function slimPod(p: any) {
  const strip = (s: any) => ({ name: s.name, ready: s.ready, restartCount: s.restartCount, state: s.state, lastState: s.lastState });
  return {
    metadata: {
      name: p.metadata?.name,
      namespace: p.metadata?.namespace,
      uid: p.metadata?.uid,
      creationTimestamp: p.metadata?.creationTimestamp,
      deletionTimestamp: p.metadata?.deletionTimestamp,
      ownerReferences: p.metadata?.ownerReferences?.map((o: any) => ({ kind: o.kind, name: o.name })),
    },
    spec: {
      nodeName: p.spec?.nodeName,
      containers: (p.spec?.containers ?? []).map((c: any) => ({ name: c.name, image: c.image, resources: c.resources })),
    },
    status: {
      phase: p.status?.phase,
      reason: p.status?.reason,
      message: p.status?.message,
      conditions: p.status?.conditions,
      containerStatuses: (p.status?.containerStatuses ?? []).map(strip),
      initContainerStatuses: (p.status?.initContainerStatuses ?? []).map(strip),
    },
    requests: resources(p.spec?.containers),
  };
}

function slimNode(n: any) {
  return {
    name: n.metadata?.name,
    labels: n.metadata?.labels ?? {},
    unschedulable: !!n.spec?.unschedulable,
    conditions: n.status?.conditions ?? [],
    kubeletVersion: n.status?.nodeInfo?.kubeletVersion,
    capacity: { cpu: parseCpu(n.status?.capacity?.cpu), memory: parseMemory(n.status?.capacity?.memory), pods: Number(n.status?.capacity?.pods) || 0 },
    allocatable: { cpu: parseCpu(n.status?.allocatable?.cpu), memory: parseMemory(n.status?.allocatable?.memory), pods: Number(n.status?.allocatable?.pods) || 0 },
  };
}

function slimObject(o: any) {
  return {
    kind: o.kind,
    metadata: { name: o.metadata?.name, namespace: o.metadata?.namespace, uid: o.metadata?.uid, creationTimestamp: o.metadata?.creationTimestamp },
    spec: { replicas: o.spec?.replicas, suspend: o.spec?.suspend },
    status: o.status ?? {},
  };
}

export async function dashboard(ctx: string, ns: string | undefined) {
  const all = !ns || ns === '*';
  const metricsPods = all ? `${METRICS_API}/pods` : `${METRICS_API}/namespaces/${checkName(ns, 'namespace')}/pods`;

  const [version, nodes, nodeMetrics, pods, podMetrics, workloads, flux, warnings] = await Promise.all([
    part(async () =>
      demoEnabled()
        ? String(JSON.parse(await kubectl(ctx, ['version', '-o', 'json'])).serverVersion?.gitVersion ?? '')
        : String((await kubectlGet(ctx, '/version')).gitVersion ?? ''),
    ),
    part(async () => (await listItems(ctx, 'nodes', undefined)).map(slimNode)),
    part(async () =>
      ((await rawJson(ctx, `${METRICS_API}/nodes`)).items ?? []).map((m: any) => ({
        name: m.metadata?.name,
        cpu: parseCpu(m.usage?.cpu),
        memory: parseMemory(m.usage?.memory),
      })),
    ),
    part(async () => (await listItems(ctx, 'pods', ns)).map(slimPod)),
    part(async () =>
      ((await rawJson(ctx, metricsPods)).items ?? []).map((m: any) => {
        let cpu = 0;
        let memory = 0;
        for (const c of m.containers ?? []) {
          cpu += parseCpu(c.usage?.cpu);
          memory += parseMemory(c.usage?.memory);
        }
        return { name: m.metadata?.name, namespace: m.metadata?.namespace, cpu, memory };
      }),
    ),
    part(async () => (await listItems(ctx, 'deployments.apps,statefulsets.apps,daemonsets.apps', ns)).map(slimObject)),
    (async () => {
      const discovery = await discover(ctx).catch(() => []);
      const fluxTypes = ['kustomizations.kustomize.toolkit.fluxcd.io', 'helmreleases.helm.toolkit.fluxcd.io']
        .filter((t) => discovery.some((r) => r.type === t));
      return fluxTypes.length ? part(async () => (await listItems(ctx, fluxTypes.join(','), ns)).map(slimObject)) : null;
    })(),
    part(async () => {
      const items: any[] = await listItems(ctx, 'events', ns, { fields: 'type=Warning' });
      const when = (e: any) => Date.parse(e.lastTimestamp || e.eventTime || e.metadata?.creationTimestamp || 0) || 0;
      return items
        .sort((a, b) => when(b) - when(a))
        .slice(0, 15)
        .map((e) => ({
          uid: e.metadata?.uid,
          namespace: e.metadata?.namespace,
          reason: e.reason,
          message: e.message,
          count: e.count ?? 1,
          lastTimestamp: e.lastTimestamp || e.eventTime || e.metadata?.creationTimestamp,
          involvedObject: { kind: e.involvedObject?.kind, name: e.involvedObject?.name, namespace: e.involvedObject?.namespace },
        }));
    }),
  ]);

  return { version, nodes, nodeMetrics, pods, podMetrics, workloads, flux, warnings, allNamespaces: all };
}
