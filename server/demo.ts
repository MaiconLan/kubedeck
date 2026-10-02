/**
 * Demo mode (`kubedeck --demo`): answers the kubectl / helm / az commands KubeDeck
 * runs with a realistic, in-memory fake cluster. Nothing is executed and no cluster
 * is needed. Used for trying KubeDeck out, for development, and to record the
 * README media. All names and data are fictional.
 */
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { PassThrough } from 'node:stream';
import { AppError, classifyStderr } from './errors.js';

export function demoEnabled(): boolean {
  return process.env.KUBEDECK_DEMO === '1';
}

// ---- resource catalog ----------------------------------------------------------

interface Res {
  name: string;
  short: string;
  apiVersion: string;
  namespaced: boolean;
  kind: string;
}

const RESOURCES: Res[] = [
  { name: 'namespaces', short: 'ns', apiVersion: 'v1', namespaced: false, kind: 'Namespace' },
  { name: 'nodes', short: 'no', apiVersion: 'v1', namespaced: false, kind: 'Node' },
  { name: 'events', short: 'ev', apiVersion: 'v1', namespaced: true, kind: 'Event' },
  { name: 'pods', short: 'po', apiVersion: 'v1', namespaced: true, kind: 'Pod' },
  { name: 'services', short: 'svc', apiVersion: 'v1', namespaced: true, kind: 'Service' },
  { name: 'configmaps', short: 'cm', apiVersion: 'v1', namespaced: true, kind: 'ConfigMap' },
  { name: 'secrets', short: '', apiVersion: 'v1', namespaced: true, kind: 'Secret' },
  { name: 'serviceaccounts', short: 'sa', apiVersion: 'v1', namespaced: true, kind: 'ServiceAccount' },
  { name: 'persistentvolumeclaims', short: 'pvc', apiVersion: 'v1', namespaced: true, kind: 'PersistentVolumeClaim' },
  { name: 'persistentvolumes', short: 'pv', apiVersion: 'v1', namespaced: false, kind: 'PersistentVolume' },
  { name: 'deployments', short: 'deploy', apiVersion: 'apps/v1', namespaced: true, kind: 'Deployment' },
  { name: 'statefulsets', short: 'sts', apiVersion: 'apps/v1', namespaced: true, kind: 'StatefulSet' },
  { name: 'daemonsets', short: 'ds', apiVersion: 'apps/v1', namespaced: true, kind: 'DaemonSet' },
  { name: 'replicasets', short: 'rs', apiVersion: 'apps/v1', namespaced: true, kind: 'ReplicaSet' },
  { name: 'jobs', short: '', apiVersion: 'batch/v1', namespaced: true, kind: 'Job' },
  { name: 'cronjobs', short: 'cj', apiVersion: 'batch/v1', namespaced: true, kind: 'CronJob' },
  { name: 'ingresses', short: 'ing', apiVersion: 'networking.k8s.io/v1', namespaced: true, kind: 'Ingress' },
  { name: 'networkpolicies', short: 'netpol', apiVersion: 'networking.k8s.io/v1', namespaced: true, kind: 'NetworkPolicy' },
  { name: 'storageclasses', short: 'sc', apiVersion: 'storage.k8s.io/v1', namespaced: false, kind: 'StorageClass' },
  { name: 'ingressroutes', short: '', apiVersion: 'traefik.io/v1alpha1', namespaced: true, kind: 'IngressRoute' },
  { name: 'middlewares', short: '', apiVersion: 'traefik.io/v1alpha1', namespaced: true, kind: 'Middleware' },
  { name: 'kustomizations', short: 'ks', apiVersion: 'kustomize.toolkit.fluxcd.io/v1', namespaced: true, kind: 'Kustomization' },
  { name: 'helmreleases', short: 'hr', apiVersion: 'helm.toolkit.fluxcd.io/v2', namespaced: true, kind: 'HelmRelease' },
  { name: 'gitrepositories', short: 'gitrepo', apiVersion: 'source.toolkit.fluxcd.io/v1', namespaced: true, kind: 'GitRepository' },
  { name: 'helmrepositories', short: 'helmrepo', apiVersion: 'source.toolkit.fluxcd.io/v1', namespaced: true, kind: 'HelmRepository' },
  { name: 'resourcequotas', short: 'quota', apiVersion: 'v1', namespaced: true, kind: 'ResourceQuota' },
];

function resourceFor(type: string): Res | undefined {
  const plural = type.split('.')[0].toLowerCase();
  return RESOURCES.find((r) => r.name === plural || r.short === plural || r.kind.toLowerCase() === plural || `${r.kind.toLowerCase()}s` === plural);
}

// ---- helpers -------------------------------------------------------------------

const START = Date.now();
const ago = (seconds: number) => new Date(START - seconds * 1000).toISOString();
let uidCounter = 0;
const uid = () => `d3m0${(++uidCounter).toString(16).padStart(4, '0')}-0000-4000-8000-${(uidCounter * 7919).toString(16).padStart(12, '0')}`;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function suffix(seed: string, len = 5): string {
  const chars = 'bcdfghjklmnpqrstvwxz2456789';
  let h = hash(seed);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += chars[h % chars.length];
    h = Math.floor(h / chars.length) || hash(seed + i);
  }
  return out;
}

function meta(name: string, ns?: string, extra: Record<string, any> = {}) {
  return { name, ...(ns ? { namespace: ns } : {}), uid: uid(), creationTimestamp: ago(extra.age ?? 86400 * 6), ...extra.meta };
}

function err(stderr: string, command: string): never {
  throw classifyStderr(stderr, command);
}

// ---- the fake cluster ------------------------------------------------------------

interface Container {
  name: string;
  image: string;
  port?: number;
  cpu: string;
  memory: string;
  limitMemory?: string;
  env?: any[];
  envFrom?: any[];
  probe?: string;
}

interface WorkloadSpec {
  kind: 'Deployment' | 'StatefulSet' | 'DaemonSet';
  name: string;
  ns: string;
  replicas: number;
  app: string;
  containers: Container[];
  /** Fixed pod name suffixes so the README script can find them. */
  podSuffixes?: string[];
  volumes?: any[];
  age?: number;
}

interface World {
  objects: any[];
  /** Per-pod overrides that turn a healthy pod into a broken one. */
  faults: Map<string, (pod: any) => void>;
}

const worlds = new Map<string, World>();
const contexts = [
  { name: 'local-dev', cluster: 'k3d-local-dev', user: 'admin@k3d-local-dev', server: 'https://0.0.0.0:6443', namespace: '' },
  { name: 'staging', cluster: 'staging', user: 'staging-admin', server: 'https://staging.k8s.example.com', namespace: 'apps' },
  { name: 'prod-eu', cluster: 'prod-eu', user: 'prod-eu-user', server: 'https://prod-eu.k8s.example.com', namespace: 'apps' },
];

function world(ctx: string): World {
  let w = worlds.get(ctx);
  if (!w) {
    w = buildWorld(ctx);
    worlds.set(ctx, w);
  }
  return w;
}

const NODES = ['node-a1', 'node-b2', 'node-c3'];

function buildWorld(ctx: string): World {
  const w: World = { objects: [], faults: new Map() };
  const add = (o: any) => w.objects.push(o);
  const big = ctx === 'prod-eu';

  for (const ns of ['default', 'apps', 'monitoring', 'flux-system', 'kube-system', 'traefik']) {
    add({ apiVersion: 'v1', kind: 'Namespace', metadata: meta(ns, undefined, { age: 86400 * 40 }), status: { phase: 'Active' } });
  }

  NODES.forEach((n, i) => {
    add({
      apiVersion: 'v1', kind: 'Node',
      metadata: meta(n, undefined, {
        age: 86400 * 40,
        meta: { labels: { 'kubernetes.io/hostname': n, ...(i === 0 ? { 'node-role.kubernetes.io/control-plane': 'true' } : {}), 'topology.kubernetes.io/zone': `eu-west-1${'abc'[i]}` } },
      }),
      spec: i === 0 ? { taints: [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }] } : {},
      status: {
        capacity: { cpu: big ? '8' : '4', memory: big ? '32Gi' : '16Gi', pods: '110' },
        allocatable: { cpu: big ? '7800m' : '3800m', memory: big ? '30Gi' : '15Gi', pods: '110' },
        conditions: [
          { type: 'MemoryPressure', status: 'False', reason: 'KubeletHasSufficientMemory', lastTransitionTime: ago(86400 * 40) },
          { type: 'DiskPressure', status: 'False', reason: 'KubeletHasNoDiskPressure', lastTransitionTime: ago(86400 * 40) },
          { type: 'Ready', status: 'True', reason: 'KubeletReady', message: 'kubelet is posting ready status', lastTransitionTime: ago(86400 * 40) },
        ],
        addresses: [{ type: 'InternalIP', address: `10.0.1.${11 + i}` }, { type: 'Hostname', address: n }],
        nodeInfo: { kubeletVersion: 'v1.30.4', osImage: 'Ubuntu 22.04.4 LTS', containerRuntimeVersion: 'containerd://1.7.15', architecture: 'amd64' },
      },
    });
  });

  add({ apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: meta('standard', undefined, { meta: { annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } } }), provisioner: 'rancher.io/local-path', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer' });

  // Config and secrets (values are fictional).
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  add({ apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('api-config', 'apps'), data: { LOG_LEVEL: 'info', CACHE_TTL: '300', FEATURE_REPORTS: 'true' } });
  add({ apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('web-config', 'apps'), data: { 'nginx.conf': 'server {\n  listen 80;\n  location / { root /usr/share/nginx/html; }\n}\n' } });
  add({ apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('grafana-dashboards', 'monitoring'), data: { 'cluster.json': '{"title":"Cluster overview"}' } });
  add({ apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: meta('api-db', 'apps'), data: { DB_HOST: b64('postgres.apps.svc.cluster.local'), DB_USER: b64('app'), DB_PASSWORD: b64('demo-only-not-a-real-password') } });
  add({ apiVersion: 'v1', kind: 'Secret', type: 'kubernetes.io/tls', metadata: meta('web-tls', 'apps'), data: { 'tls.crt': b64('-----BEGIN CERTIFICATE-----\nMIIDemoCertificateForKubeDeckReadme\n-----END CERTIFICATE-----\n'), 'tls.key': b64('-----BEGIN PRIVATE KEY-----\nMIIEDemoKeyNotReal\n-----END PRIVATE KEY-----\n') } });
  add({ apiVersion: 'v1', kind: 'Secret', type: 'kubernetes.io/dockerconfigjson', metadata: meta('registry-cred', 'apps'), data: { '.dockerconfigjson': b64('{"auths":{"ghcr.io":{"auth":"ZGVtbzpkZW1v"}}}') } });
  for (const ns of ['default', 'apps', 'monitoring']) add({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta('default', ns, { age: 86400 * 40 }) });
  add({ apiVersion: 'v1', kind: 'ResourceQuota', metadata: meta('apps-quota', 'apps'), spec: { hard: { 'requests.cpu': '4', 'requests.memory': '8Gi' } }, status: { hard: { 'requests.cpu': '4' }, used: { 'requests.cpu': '3800m' } } });

  // PVCs and volumes.
  for (const [claim, ns, size] of [['data-postgres-0', 'apps', '20Gi'], ['data-redis-0', 'apps', '5Gi'], ['data-prometheus-0', 'monitoring', '50Gi']]) {
    const pv = `pvc-${suffix(claim, 8)}-${suffix(claim + 'x', 4)}`;
    add({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: meta(claim, ns), spec: { accessModes: ['ReadWriteOnce'], storageClassName: 'standard', volumeName: pv, resources: { requests: { storage: size } } }, status: { phase: 'Bound', capacity: { storage: size } } });
    add({ apiVersion: 'v1', kind: 'PersistentVolume', metadata: meta(pv), spec: { capacity: { storage: size }, accessModes: ['ReadWriteOnce'], storageClassName: 'standard', persistentVolumeReclaimPolicy: 'Delete', claimRef: { name: claim, namespace: ns } }, status: { phase: 'Bound' } });
  }

  const dbEnv = [
    { name: 'DB_HOST', valueFrom: { secretKeyRef: { name: 'api-db', key: 'DB_HOST' } } },
    { name: 'DB_PASSWORD', valueFrom: { secretKeyRef: { name: 'api-db', key: 'DB_PASSWORD' } } },
  ];
  const workloads: WorkloadSpec[] = [
    { kind: 'Deployment', name: 'api', ns: 'apps', replicas: 3, app: 'api', podSuffixes: ['x2kqp', 'm4zt8', 'q9wle'], containers: [{ name: 'api', image: 'ghcr.io/example/api:1.8.2', port: 8080, cpu: '250m', memory: '256Mi', limitMemory: '512Mi', env: dbEnv, envFrom: [{ configMapRef: { name: 'api-config' } }], probe: '/healthz' }] },
    { kind: 'Deployment', name: 'web', ns: 'apps', replicas: 2, app: 'web', podSuffixes: ['h7rwd', 'c2nfp'], containers: [{ name: 'web', image: 'ghcr.io/example/web:2.3.1', port: 80, cpu: '100m', memory: '64Mi', limitMemory: '128Mi', probe: '/' }], volumes: [{ name: 'config', configMap: { name: 'web-config' } }] },
    { kind: 'Deployment', name: 'worker', ns: 'apps', replicas: 3, app: 'worker', podSuffixes: [], containers: [{ name: 'worker', image: 'ghcr.io/example/worker:1.8.2', cpu: '500m', memory: '512Mi', env: dbEnv }] },
    { kind: 'Deployment', name: 'report-generator', ns: 'apps', replicas: 1, app: 'report-generator', podSuffixes: ['tb6sv'], containers: [{ name: 'reports', image: 'ghcr.io/example/reports:0.9.0', cpu: '1', memory: '24Gi' }] },
    { kind: 'StatefulSet', name: 'postgres', ns: 'apps', replicas: 1, app: 'postgres', containers: [{ name: 'postgres', image: 'postgres:16.4', port: 5432, cpu: '500m', memory: '1Gi', limitMemory: '2Gi' }], volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'data-postgres-0' } }] },
    { kind: 'StatefulSet', name: 'redis', ns: 'apps', replicas: 1, app: 'redis', containers: [{ name: 'redis', image: 'redis:7.4', port: 6379, cpu: '100m', memory: '128Mi', limitMemory: '256Mi' }], volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'data-redis-0' } }] },
    { kind: 'Deployment', name: 'grafana', ns: 'monitoring', replicas: 1, app: 'grafana', podSuffixes: ['k8w2j'], containers: [{ name: 'grafana', image: 'grafana/grafana:11.2.0', port: 3000, cpu: '100m', memory: '256Mi', limitMemory: '512Mi' }] },
    { kind: 'StatefulSet', name: 'prometheus', ns: 'monitoring', replicas: 1, app: 'prometheus', containers: [{ name: 'prometheus', image: 'prom/prometheus:v2.54.1', port: 9090, cpu: '500m', memory: '2Gi', limitMemory: '4Gi' }], volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'data-prometheus-0' } }] },
    { kind: 'Deployment', name: 'source-controller', ns: 'flux-system', replicas: 1, app: 'source-controller', podSuffixes: ['p4l7c'], containers: [{ name: 'manager', image: 'ghcr.io/fluxcd/source-controller:v1.4.1', cpu: '50m', memory: '64Mi', limitMemory: '1Gi' }] },
    { kind: 'Deployment', name: 'kustomize-controller', ns: 'flux-system', replicas: 1, app: 'kustomize-controller', podSuffixes: ['w9fmz'], containers: [{ name: 'manager', image: 'ghcr.io/fluxcd/kustomize-controller:v1.4.0', cpu: '100m', memory: '64Mi', limitMemory: '1Gi' }] },
    { kind: 'Deployment', name: 'helm-controller', ns: 'flux-system', replicas: 1, app: 'helm-controller', podSuffixes: ['d6xqn'], containers: [{ name: 'manager', image: 'ghcr.io/fluxcd/helm-controller:v1.1.0', cpu: '100m', memory: '64Mi', limitMemory: '1Gi' }] },
    { kind: 'Deployment', name: 'coredns', ns: 'kube-system', replicas: 2, app: 'kube-dns', podSuffixes: ['5vbn8', 'zr3tk'], containers: [{ name: 'coredns', image: 'registry.k8s.io/coredns/coredns:v1.11.3', port: 53, cpu: '100m', memory: '70Mi', limitMemory: '170Mi' }] },
    { kind: 'Deployment', name: 'metrics-server', ns: 'kube-system', replicas: 1, app: 'metrics-server', podSuffixes: ['j2hcs'], containers: [{ name: 'metrics-server', image: 'registry.k8s.io/metrics-server/metrics-server:v0.7.2', cpu: '100m', memory: '70Mi' }] },
    { kind: 'DaemonSet', name: 'traefik', ns: 'traefik', replicas: 2, app: 'traefik', containers: [{ name: 'traefik', image: 'traefik:v3.1.4', port: 8000, cpu: '100m', memory: '64Mi', limitMemory: '256Mi' }] },
  ];
  if (big) {
    workloads.push(
      { kind: 'Deployment', name: 'checkout', ns: 'apps', replicas: 4, app: 'checkout', podSuffixes: ['a8kd2', 'b3mfz', 'c7wqx', 'd2plr'], containers: [{ name: 'checkout', image: 'ghcr.io/example/checkout:3.2.0', port: 8080, cpu: '300m', memory: '384Mi', limitMemory: '768Mi' }] },
      { kind: 'Deployment', name: 'notifications', ns: 'apps', replicas: 2, app: 'notifications', podSuffixes: ['f5ngh', 'g9trw'], containers: [{ name: 'notifications', image: 'ghcr.io/example/notifications:1.1.4', port: 8080, cpu: '100m', memory: '128Mi', limitMemory: '256Mi' }] },
    );
  }
  for (const spec of workloads) addWorkload(w, spec);

  // Services, ingress and Traefik routes.
  const svc = (name: string, ns: string, app: string, port: number, target = port) =>
    add({ apiVersion: 'v1', kind: 'Service', metadata: meta(name, ns), spec: { type: 'ClusterIP', clusterIP: `10.43.${hash(name) % 200}.${hash(ns + name) % 250}`, selector: { app }, ports: [{ name: 'http', port, targetPort: target, protocol: 'TCP' }] } });
  svc('api', 'apps', 'api', 8080);
  svc('web', 'apps', 'web', 80);
  svc('postgres', 'apps', 'postgres', 5432);
  svc('redis', 'apps', 'redis', 6379);
  svc('grafana', 'monitoring', 'grafana', 3000);
  svc('prometheus', 'monitoring', 'prometheus', 9090);
  add({ apiVersion: 'v1', kind: 'Service', metadata: meta('traefik', 'traefik'), spec: { type: 'LoadBalancer', clusterIP: '10.43.12.40', selector: { app: 'traefik' }, ports: [{ name: 'web', port: 80, targetPort: 8000, nodePort: 31080, protocol: 'TCP' }, { name: 'websecure', port: 443, targetPort: 8443, nodePort: 31443, protocol: 'TCP' }] }, status: { loadBalancer: { ingress: [{ ip: '203.0.113.20' }] } } });
  add({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: meta('web', 'apps'), spec: { ingressClassName: 'traefik', tls: [{ hosts: ['app.example.com'], secretName: 'web-tls' }], rules: [{ host: 'app.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] }, status: { loadBalancer: { ingress: [{ ip: '203.0.113.20' }] } } });
  add({ apiVersion: 'traefik.io/v1alpha1', kind: 'IngressRoute', metadata: meta('api', 'apps'), spec: { entryPoints: ['websecure'], routes: [{ match: 'Host(`api.example.com`) && PathPrefix(`/v1`)', kind: 'Rule', services: [{ name: 'api', port: 8080 }], middlewares: [{ name: 'rate-limit' }] }], tls: { secretName: 'web-tls' } } });
  add({ apiVersion: 'traefik.io/v1alpha1', kind: 'Middleware', metadata: meta('rate-limit', 'apps'), spec: { rateLimit: { average: 100, burst: 50 } } });

  // Jobs.
  add({ apiVersion: 'batch/v1', kind: 'CronJob', metadata: meta('nightly-backup', 'apps'), spec: { schedule: '0 2 * * *', suspend: false, jobTemplate: { spec: { template: { spec: { containers: [{ name: 'backup', image: 'ghcr.io/example/backup:1.2.0' }] } } } } }, status: { lastScheduleTime: ago(3600 * 9) } });
  add({ apiVersion: 'batch/v1', kind: 'Job', metadata: meta('db-migrate-1.8.2', 'apps', { age: 86400 }), spec: { completions: 1, backoffLimit: 3, selector: { matchLabels: { 'job-name': 'db-migrate-1.8.2' } }, template: { spec: { containers: [{ name: 'migrate', image: 'ghcr.io/example/api:1.8.2' }] } } }, status: { succeeded: 1, startTime: ago(86400), completionTime: ago(86400 - 42), conditions: [{ type: 'Complete', status: 'True', lastTransitionTime: ago(86400 - 42) }] } });

  // Flux.
  add({ apiVersion: 'source.toolkit.fluxcd.io/v1', kind: 'GitRepository', metadata: meta('flux-system', 'flux-system', { age: 86400 * 40 }), spec: { url: 'https://github.com/example/gitops', ref: { branch: 'main' }, interval: '1m' }, status: { artifact: { revision: 'main@sha1:3f2c9a1e7b' }, conditions: [ready('True', 'Succeeded', "stored artifact for revision 'main@sha1:3f2c9a1e7b'")] } });
  add({ apiVersion: 'source.toolkit.fluxcd.io/v1', kind: 'HelmRepository', metadata: meta('grafana', 'flux-system'), spec: { url: 'https://grafana.github.io/helm-charts', interval: '1h' }, status: { conditions: [ready('True', 'Succeeded', 'stored artifact')] } });
  for (const [name, path, ok] of [['infrastructure', './infrastructure', true], ['apps', './apps/production', true], ['monitoring', './monitoring', false]] as const) {
    add({
      apiVersion: 'kustomize.toolkit.fluxcd.io/v1', kind: 'Kustomization', metadata: meta(name, 'flux-system', { age: 86400 * 30 }),
      spec: { interval: '10m', path, prune: true, sourceRef: { kind: 'GitRepository', name: 'flux-system' } },
      status: {
        lastAppliedRevision: 'main@sha1:3f2c9a1e7b', lastHandledReconcileAt: ago(600),
        conditions: [ok
          ? ready('True', 'ReconciliationSucceeded', "Applied revision: main@sha1:3f2c9a1e7b")
          : ready('False', 'BuildFailed', "kustomize build failed: accumulating resources: 'monitoring/alerts.yaml': missing metadata.name")],
      },
    });
  }
  add({ apiVersion: 'helm.toolkit.fluxcd.io/v2', kind: 'HelmRelease', metadata: meta('grafana', 'monitoring'), spec: { interval: '30m', chart: { spec: { chart: 'grafana', version: '8.5.1', sourceRef: { kind: 'HelmRepository', name: 'grafana', namespace: 'flux-system' } } } }, status: { lastAttemptedRevision: '8.5.1', conditions: [ready('True', 'UpgradeSucceeded', 'Helm upgrade succeeded for release monitoring/grafana.v4 with chart grafana@8.5.1')] } });

  addEvents(w, ctx);
  return w;
}

function ready(status: string, reason: string, message: string) {
  return { type: 'Ready', status, reason, message, lastTransitionTime: ago(1800) };
}

function addWorkload(w: World, s: WorkloadSpec) {
  const labels = { app: s.app };
  const podSpec = {
    serviceAccountName: 'default',
    containers: s.containers.map((c) => ({
      name: c.name,
      image: c.image,
      ...(c.port ? { ports: [{ containerPort: c.port, protocol: 'TCP', name: 'http' }] } : {}),
      resources: { requests: { cpu: c.cpu, memory: c.memory }, ...(c.limitMemory ? { limits: { memory: c.limitMemory } } : {}) },
      ...(c.env ? { env: c.env } : {}),
      ...(c.envFrom ? { envFrom: c.envFrom } : {}),
      ...(c.probe && c.port ? { readinessProbe: { httpGet: { path: c.probe, port: c.port }, periodSeconds: 10 } } : {}),
    })),
    ...(s.volumes ? { volumes: s.volumes } : {}),
    imagePullSecrets: s.containers.some((c) => c.image.startsWith('ghcr.io/example')) ? [{ name: 'registry-cred' }] : undefined,
  };
  const objMeta = meta(s.name, s.ns, { age: s.age ?? 86400 * 12, meta: { labels, annotations: { 'deployment.kubernetes.io/revision': '7' }, generation: 7 } });
  const obj: any = {
    apiVersion: 'apps/v1', kind: s.kind, metadata: objMeta,
    spec: { ...(s.kind !== 'DaemonSet' ? { replicas: s.replicas } : {}), selector: { matchLabels: labels }, template: { metadata: { labels }, spec: podSpec } },
    status: {},
  };
  w.objects.push(obj);

  let owner = { kind: s.kind, name: s.name, uid: objMeta.uid };
  let rsHash = '';
  if (s.kind === 'Deployment') {
    // Fixed hash for "api" so the README script can refer to its pods by name.
    rsHash = s.name === 'api' ? '7d9f8c6b5' : suffix(`${s.ns}/${s.name}/rs`, 9);
    const rs = {
      apiVersion: 'apps/v1', kind: 'ReplicaSet',
      metadata: meta(`${s.name}-${rsHash}`, s.ns, { age: 86400 * 3, meta: { labels: { ...labels, 'pod-template-hash': rsHash }, ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: s.name, uid: objMeta.uid, controller: true }] } }),
      spec: { replicas: s.replicas, selector: { matchLabels: labels }, template: obj.spec.template },
      status: {},
    };
    w.objects.push(rs);
    owner = { kind: 'ReplicaSet', name: rs.metadata.name, uid: rs.metadata.uid };
  }

  const count = s.kind === 'DaemonSet' ? NODES.length - 1 : s.replicas;
  for (let i = 0; i < count; i++) {
    const name =
      s.kind === 'StatefulSet' ? `${s.name}-${i}`
      : s.kind === 'DaemonSet' ? `${s.name}-${suffix(`${s.name}${i}`)}`
      : `${s.name}-${rsHash}-${s.podSuffixes?.[i] ?? suffix(`${s.name}${i}`)}`;
    if (s.name === 'worker') continue; // blocked by the namespace quota, see addEvents
    w.objects.push(makePod(name, s.ns, labels, podSpec, owner, i));
  }
  refreshStatus(w, obj);
}

function makePod(name: string, ns: string, labels: Record<string, string>, spec: any, owner: any, i: number, age = 86400 * 2 + i * 7200) {
  const node = NODES[1 + ((hash(name) + i) % (NODES.length - 1))];
  return {
    apiVersion: 'v1', kind: 'Pod',
    metadata: meta(name, ns, { age, meta: { labels: { ...labels }, ownerReferences: [{ apiVersion: 'apps/v1', ...owner, controller: true }] } }),
    spec: { ...JSON.parse(JSON.stringify(spec)), nodeName: node },
    status: {
      phase: 'Running',
      podIP: `10.42.${1 + (hash(node) % 3)}.${10 + (hash(name) % 200)}`,
      hostIP: `10.0.1.${11 + NODES.indexOf(node)}`,
      startTime: ago(age),
      conditions: [
        { type: 'PodScheduled', status: 'True', lastTransitionTime: ago(age) },
        { type: 'Initialized', status: 'True', lastTransitionTime: ago(age) },
        { type: 'ContainersReady', status: 'True', lastTransitionTime: ago(age - 20) },
        { type: 'Ready', status: 'True', lastTransitionTime: ago(age - 20) },
      ],
      containerStatuses: spec.containers.map((c: any) => ({
        name: c.name, image: c.image, ready: true, started: true, restartCount: 0,
        state: { running: { startedAt: ago(age - 15) } },
      })),
    },
  };
}

/** Recomputes the status of a workload from its pods. */
function refreshStatus(w: World, obj: any) {
  const pods = w.objects.filter((o) => o.kind === 'Pod' && o.metadata.namespace === obj.metadata.namespace && matches(o.metadata.labels, obj.spec.selector?.matchLabels ?? {}));
  const readyPods = pods.filter((p) => (p.status.containerStatuses ?? []).length > 0 && p.status.containerStatuses.every((c: any) => c.ready)).length;
  if (obj.kind === 'DaemonSet') {
    obj.status = { desiredNumberScheduled: NODES.length - 1, currentNumberScheduled: pods.length, numberReady: readyPods, numberAvailable: readyPods, updatedNumberScheduled: pods.length };
    return;
  }
  const want = obj.spec.replicas ?? 0;
  const prev = obj.status?.conditions ?? [];
  obj.status = {
    observedGeneration: obj.metadata.generation,
    replicas: pods.length, readyReplicas: readyPods, availableReplicas: readyPods, updatedReplicas: pods.length,
    conditions: prev.length ? prev : [
      { type: 'Available', status: readyPods >= want ? 'True' : 'False', reason: readyPods >= want ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable', lastTransitionTime: ago(3600) },
      { type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable', lastTransitionTime: ago(3600) },
    ],
  };
  for (const rs of w.objects.filter((o) => o.kind === 'ReplicaSet' && o.metadata.ownerReferences?.[0]?.uid === obj.metadata.uid)) {
    rs.spec.replicas = want;
    rs.status = { replicas: pods.length, readyReplicas: readyPods, availableReplicas: readyPods };
  }
}

function findObj(w: World, kind: string, name: string, ns?: string) {
  return w.objects.find((o) => o.kind === kind && o.metadata.name === name && (!ns || o.metadata.namespace === ns));
}

function event(w: World, ns: string, involved: { kind: string; name: string }, type: string, reason: string, message: string, count = 1, secondsAgo = 120) {
  w.objects.push({
    apiVersion: 'v1', kind: 'Event',
    metadata: meta(`${involved.name}.${suffix(reason + involved.name + message, 8)}`, ns, { age: secondsAgo }),
    involvedObject: { kind: involved.kind, name: involved.name, namespace: ns },
    type, reason, message, count, lastTimestamp: ago(secondsAgo), firstTimestamp: ago(secondsAgo + 3600),
    source: { component: reason === 'FailedScheduling' ? 'default-scheduler' : 'kubelet' },
  });
}

/** Breaks a few things on purpose so the dashboard and the diagnosis have something to show. */
function addEvents(w: World, ctx: string) {
  // api: one pod keeps running out of memory.
  const oom = findObj(w, 'Pod', 'api-7d9f8c6b5-m4zt8', 'apps');
  if (oom) {
    const cs = oom.status.containerStatuses[0];
    Object.assign(cs, {
      ready: false, restartCount: 14,
      state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s restarting failed container=api pod=api-7d9f8c6b5-m4zt8_apps' } },
      lastState: { terminated: { reason: 'OOMKilled', exitCode: 137, startedAt: ago(260), finishedAt: ago(200) } },
    });
    setReady(oom, false);
    event(w, 'apps', { kind: 'Pod', name: oom.metadata.name }, 'Warning', 'BackOff', 'Back-off restarting failed container api in pod api-7d9f8c6b5-m4zt8_apps', 63, 40);
    event(w, 'apps', { kind: 'Pod', name: oom.metadata.name }, 'Normal', 'Pulled', 'Container image "ghcr.io/example/api:1.8.2" already present on machine', 15, 260);
  }

  // web: a new version was rolled out with a tag that does not exist.
  const webDeploy = findObj(w, 'Deployment', 'web', 'apps');
  const webRs = w.objects.find((o) => o.kind === 'ReplicaSet' && o.metadata.name.startsWith('web-'));
  if (webDeploy && webRs) {
    const badImage = 'ghcr.io/example/web:2.4.0';
    const spec = JSON.parse(JSON.stringify(webDeploy.spec.template.spec));
    spec.containers[0].image = badImage;
    const newRs = { ...JSON.parse(JSON.stringify(webRs)), metadata: meta('web-5c8b7d9f4', 'apps', { age: 1500, meta: { labels: { app: 'web', 'pod-template-hash': '5c8b7d9f4' }, ownerReferences: webRs.metadata.ownerReferences } }) };
    w.objects.push(newRs);
    const pod = makePod('web-5c8b7d9f4-r8vkz', 'apps', { app: 'web' }, spec, { kind: 'ReplicaSet', name: newRs.metadata.name, uid: newRs.metadata.uid }, 0, 1500);
    Object.assign(pod.status.containerStatuses[0], { ready: false, image: badImage, state: { waiting: { reason: 'ImagePullBackOff', message: `Back-off pulling image "${badImage}"` } } });
    setReady(pod, false);
    w.objects.push(pod);
    event(w, 'apps', { kind: 'Pod', name: pod.metadata.name }, 'Warning', 'Failed', `Failed to pull image "${badImage}": rpc error: code = NotFound desc = failed to pull and unpack image "${badImage}": ${badImage}: not found`, 12, 90);
    event(w, 'apps', { kind: 'Pod', name: pod.metadata.name }, 'Warning', 'Failed', 'Error: ImagePullBackOff', 40, 30);
    refreshStatus(w, webDeploy);
    webDeploy.status.conditions = [
      { type: 'Available', status: 'True', reason: 'MinimumReplicasAvailable', lastTransitionTime: ago(86400) },
      { type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded', message: 'ReplicaSet "web-5c8b7d9f4" has timed out progressing.', lastTransitionTime: ago(900) },
    ];
  }

  // worker: no pods at all, the namespace quota is used up.
  const worker = findObj(w, 'Deployment', 'worker', 'apps');
  if (worker) {
    const msg = 'pods "worker-6d8f9c7b5-" is forbidden: exceeded quota: apps-quota, requested: requests.cpu=500m, used: requests.cpu=3800m, limited: requests.cpu=4';
    worker.status = {
      replicas: 0, readyReplicas: 0, availableReplicas: 0, updatedReplicas: 0,
      conditions: [
        { type: 'Available', status: 'False', reason: 'MinimumReplicasUnavailable', message: 'Deployment does not have minimum availability.', lastTransitionTime: ago(5400) },
        { type: 'ReplicaFailure', status: 'True', reason: 'FailedCreate', message: msg, lastTransitionTime: ago(5400) },
      ],
    };
    const rs = w.objects.find((o) => o.kind === 'ReplicaSet' && o.metadata.name.startsWith('worker-'));
    if (rs) event(w, 'apps', { kind: 'ReplicaSet', name: rs.metadata.name }, 'Warning', 'FailedCreate', `Error creating: ${msg}`, 31, 60);
  }

  // report-generator: asks for more memory than any node has free.
  const pending = w.objects.find((o) => o.kind === 'Pod' && o.metadata.name.startsWith('report-generator-'));
  if (pending) {
    const message = '0/3 nodes are available: 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, 2 Insufficient memory. preemption: 0/3 nodes are available: 1 Preemption is not helpful for scheduling, 2 No preemption victims found for incoming pod.';
    pending.spec.nodeName = undefined;
    pending.status = {
      phase: 'Pending',
      conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message, lastTransitionTime: ago(2400) }],
    };
    event(w, 'apps', { kind: 'Pod', name: pending.metadata.name }, 'Warning', 'FailedScheduling', message, 48, 75);
  }

  // Flux: one Kustomization fails to build.
  event(w, 'flux-system', { kind: 'Kustomization', name: 'monitoring' }, 'Warning', 'BuildFailed', "kustomize build failed: accumulating resources: 'monitoring/alerts.yaml': missing metadata.name", 6, 300);

  for (const o of w.objects.filter((x) => ['Deployment', 'StatefulSet', 'DaemonSet'].includes(x.kind) && x.metadata.name !== 'worker' && x.metadata.name !== 'web')) refreshStatus(w, o);
  void ctx;
}

function setReady(pod: any, value: boolean) {
  for (const c of pod.status.conditions ?? []) if (c.type === 'Ready' || c.type === 'ContainersReady') c.status = value ? 'True' : 'False';
}

// ---- generic query -----------------------------------------------------------------

function matches(labels: Record<string, string> = {}, selector: Record<string, string>): boolean {
  return Object.entries(selector).every(([k, v]) => labels?.[k] === v);
}

function parseSelector(s: string): Record<string, string> {
  return Object.fromEntries(s.split(',').filter(Boolean).map((p) => p.split('=') as [string, string]));
}

function fieldValue(o: any, path: string): any {
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), o);
}

interface Flags {
  pos: string[];
  f: Record<string, string | true>;
}

const VALUE_FLAGS = new Set(['-n', '--namespace', '-l', '-o', '-c', '-p', '--field-selector', '--context', '--kube-context', '--address', '--raw', '--subscription', '--resource-group', '--name', '--max', '--type']);

function parse(args: string[]): Flags {
  const pos: string[] = [];
  const f: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      f[a] = args[++i] ?? '';
    } else if (a.startsWith('--') && a.includes('=')) {
      const at = a.indexOf('=');
      f[a.slice(0, at)] = a.slice(at + 1);
    } else if (a.startsWith('-') && a.length > 1) {
      f[a] = true;
    } else {
      pos.push(a);
    }
  }
  return { pos, f };
}

function query(w: World, type: string, ns: string | undefined, f: Record<string, string | true>): any[] {
  const res = resourceFor(type);
  if (!res) return [];
  let items = w.objects.filter((o) => o.kind === res.kind);
  if (res.namespaced && ns) items = items.filter((o) => o.metadata.namespace === ns);
  if (typeof f['-l'] === 'string') {
    const sel = parseSelector(f['-l']);
    items = items.filter((o) => matches(o.metadata.labels, sel));
  }
  if (typeof f['--field-selector'] === 'string') {
    const conds = f['--field-selector'].split(',').map((c) => c.split('='));
    items = items.filter((o) => conds.every(([k, v]) => String(fieldValue(o, k) ?? '') === v));
  }
  return items;
}

function withApi(o: any): any {
  const res = RESOURCES.find((r) => r.kind === o.kind);
  return { apiVersion: res?.apiVersion ?? 'v1', ...o };
}

// ---- output formats -------------------------------------------------------------

function toYaml(value: any, indent = 0): string {
  const pad = '  '.repeat(indent);
  const scalar = (v: any): string => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    const s = String(v);
    if (s.includes('\n')) return `|\n${s.replace(/\n$/, '').split('\n').map((l) => `${pad}  ${l}`).join('\n')}`;
    return /^[\w./@-][\w ./@:,=+()-]*$/.test(s) && !/^(true|false|null|yes|no|\d+(\.\d+)?)$/i.test(s) && !s.endsWith(':') ? s : JSON.stringify(s);
  };
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return value.map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length) {
        const body = toYaml(item, indent + 1).replace(/^\s+/, '');
        return `${pad}- ${body}`;
      }
      return `${pad}- ${scalar(item)}`;
    }).join('\n');
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (!entries.length) return '{}';
    return entries.map(([k, v]) => {
      const key = /^[\w./-]+$/.test(k) ? k : JSON.stringify(k);
      if (v && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.keys(v).length)) {
        return `${pad}${key}:\n${toYaml(v, Array.isArray(v) ? indent : indent + 1)}`;
      }
      if (v && typeof v === 'object') return `${pad}${key}: ${Array.isArray(v) ? '[]' : '{}'}`;
      return `${pad}${key}: ${scalar(v)}`;
    }).join('\n');
  }
  return pad + scalar(value);
}

function apiResourcesTable(): string {
  const rows = [['NAME', 'SHORTNAMES', 'APIVERSION', 'NAMESPACED', 'KIND', 'VERBS', 'CATEGORIES']];
  for (const r of RESOURCES) rows.push([r.name, r.short, r.apiVersion, String(r.namespaced), r.kind, '[create delete get list patch update watch]', '']);
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)) + 3);
  return rows.map((row) => row.map((c, i) => c.padEnd(widths[i])).join('').trimEnd()).join('\n') + '\n';
}

function describe(w: World, o: any): string {
  const md = o.metadata;
  const lines = [
    `Name:         ${md.name}`,
    ...(md.namespace ? [`Namespace:    ${md.namespace}`] : []),
    `Labels:       ${Object.entries(md.labels ?? {}).map(([k, v]) => `${k}=${v}`).join('\n              ') || '<none>'}`,
    `Annotations:  ${Object.entries(md.annotations ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n              ') || '<none>'}`,
    `CreationTimestamp:  ${md.creationTimestamp}`,
  ];
  if (o.kind === 'Pod') {
    lines.push(`Node:         ${o.spec.nodeName ?? '<none>'}`, `Status:       ${o.status.phase}`, `IP:           ${o.status.podIP ?? ''}`, 'Containers:');
    for (const c of o.spec.containers) {
      const st = (o.status.containerStatuses ?? []).find((s: any) => s.name === c.name) ?? {};
      const [state, info] = Object.entries(st.state ?? {})[0] ?? ['Waiting', {}];
      lines.push(`  ${c.name}:`, `    Image:          ${c.image}`, `    State:          ${state[0].toUpperCase()}${state.slice(1)}`);
      if ((info as any)?.reason) lines.push(`      Reason:       ${(info as any).reason}`);
      if (st.lastState?.terminated) lines.push('    Last State:     Terminated', `      Reason:       ${st.lastState.terminated.reason}`, `      Exit Code:    ${st.lastState.terminated.exitCode}`);
      lines.push(`    Ready:          ${st.ready ? 'True' : 'False'}`, `    Restart Count:  ${st.restartCount ?? 0}`);
      if (c.resources?.limits) lines.push('    Limits:', ...Object.entries(c.resources.limits).map(([k, v]) => `      ${k}:  ${v}`));
      if (c.resources?.requests) lines.push('    Requests:', ...Object.entries(c.resources.requests).map(([k, v]) => `      ${k}:  ${v}`));
    }
    lines.push('Conditions:', '  Type              Status', ...(o.status.conditions ?? []).map((c: any) => `  ${c.type.padEnd(18)}${c.status}`));
  } else if (o.spec?.replicas !== undefined) {
    lines.push(`Replicas:     ${o.spec.replicas} desired | ${o.status?.updatedReplicas ?? 0} updated | ${o.status?.replicas ?? 0} total | ${o.status?.availableReplicas ?? 0} available`);
    if (o.status?.conditions) lines.push('Conditions:', '  Type           Status  Reason', ...o.status.conditions.map((c: any) => `  ${c.type.padEnd(15)}${c.status.padEnd(8)}${c.reason ?? ''}`));
  }
  const evs = w.objects.filter((e) => e.kind === 'Event' && e.involvedObject.name === md.name && e.involvedObject.kind === o.kind);
  lines.push('Events:');
  if (!evs.length) lines.push('  <none>');
  else {
    lines.push('  Type     Reason        Age    From               Message', '  ----     ------        ----   ----               -------');
    for (const e of evs) lines.push(`  ${e.type.padEnd(9)}${e.reason.padEnd(14)}${'2m'.padEnd(7)}${(e.source?.component ?? 'kubelet').padEnd(19)}${e.message}`);
  }
  return lines.join('\n') + '\n';
}

// ---- metrics ------------------------------------------------------------------------

function podUsage(pod: any): { cpu: number; mem: number } {
  const h = hash(pod.metadata.name);
  const app = pod.metadata.labels?.app ?? '';
  const base: Record<string, [number, number]> = {
    api: [180, 300], web: [12, 40], postgres: [240, 820], redis: [30, 90], prometheus: [380, 1600], grafana: [40, 180],
    checkout: [210, 380], notifications: [20, 90], traefik: [25, 60], 'kube-dns': [6, 22],
  };
  const [cpu, mem] = base[app] ?? [8, 32];
  const jitter = 0.75 + ((h + Math.floor(Date.now() / 5000)) % 50) / 100;
  return { cpu: Math.round(cpu * jitter), mem: Math.round(mem * (0.9 + (h % 20) / 100)) };
}

function metrics(w: World, path: string): any {
  const running = w.objects.filter((o) => o.kind === 'Pod' && o.status?.phase === 'Running' && (o.status.containerStatuses ?? []).some((c: any) => c.state?.running));
  if (path.endsWith('/nodes')) {
    return {
      kind: 'NodeMetricsList',
      items: NODES.map((n, i) => {
        const pods = running.filter((p) => p.spec.nodeName === n);
        const cpu = pods.reduce((s, p) => s + podUsage(p).cpu, 0) + (i === 0 ? 420 : 160);
        const mem = pods.reduce((s, p) => s + podUsage(p).mem, 0) + (i === 0 ? 1900 : 900);
        return { metadata: { name: n }, usage: { cpu: `${cpu}m`, memory: `${mem}Mi` } };
      }),
    };
  }
  const ns = /namespaces\/([^/]+)\/pods/.exec(path)?.[1];
  return {
    kind: 'PodMetricsList',
    items: running.filter((p) => !ns || p.metadata.namespace === ns).map((p) => {
      const u = podUsage(p);
      return { metadata: { name: p.metadata.name, namespace: p.metadata.namespace }, containers: [{ name: p.spec.containers[0].name, usage: { cpu: `${u.cpu}m`, memory: `${u.mem}Mi` } }] };
    }),
  };
}

// ---- logs ---------------------------------------------------------------------------

const LOGS: Record<string, string[]> = {
  api: [
    'level=info msg="request handled" method=GET path=/v1/orders status=200 duration=18ms',
    'level=info msg="request handled" method=POST path=/v1/orders status=201 duration=42ms',
    'level=debug msg="cache hit" key=orders:page:1 ttl=287s',
    'level=info msg="request handled" method=GET path=/v1/customers/1842 status=200 duration=9ms',
    'level=warn msg="slow query" table=orders duration=812ms rows=12044',
    'level=info msg="request handled" method=GET path=/healthz status=200 duration=1ms',
    'level=error msg="payment provider timeout" provider=example-pay attempt=2 duration=5001ms',
    'level=info msg="request handled" method=PUT path=/v1/orders/77120 status=200 duration=35ms',
    'level=debug msg="db pool stats" open=12 idle=7 in_use=5',
    'level=info msg="report job queued" id=rep-20931 user=1842',
  ],
  web: [
    '10.42.1.17 - - "GET / HTTP/1.1" 200 2134 "-" "Mozilla/5.0"',
    '10.42.2.33 - - "GET /assets/app.8f2c.js HTTP/1.1" 200 184211 "-" "Mozilla/5.0"',
    '10.42.1.17 - - "GET /api/session HTTP/1.1" 200 312 "-" "Mozilla/5.0"',
    '10.42.3.9 - - "GET /favicon.ico HTTP/1.1" 404 153 "-" "Mozilla/5.0"',
    '[warn] 31#31: *4021 upstream response is buffered to a temporary file',
  ],
  postgres: [
    'LOG:  checkpoint starting: time',
    'LOG:  checkpoint complete: wrote 1840 buffers (11.2%); write=12.4 s',
    'LOG:  automatic vacuum of table "app.public.orders": index scans: 1',
    'WARNING:  could not send data to client: Broken pipe',
  ],
  default: [
    'level=info msg="reconciling" controller=main',
    'level=info msg="reconciliation finished" duration=214ms',
    'level=debug msg="watch event" type=MODIFIED',
  ],
};

const OOM_PREVIOUS = [
  'level=info msg="starting api" version=1.8.2 port=8080',
  'level=info msg="connected to database" host=postgres.apps.svc.cluster.local',
  'level=info msg="report job started" id=rep-20931 user=1842',
  'level=info msg="loading report cache" rows=1840000',
  'level=warn msg="memory usage high" rss=471Mi limit=512Mi',
  'level=warn msg="memory usage high" rss=503Mi limit=512Mi',
];

function logLine(pod: any, n: number, timestamps: boolean, prefix: boolean, container: string): string {
  const app = pod.metadata.labels?.app ?? 'default';
  const pool = LOGS[app] ?? LOGS.default;
  const text = pool[(hash(pod.metadata.name) + n) % pool.length];
  const ts = timestamps ? `${new Date(Date.now() - Math.max(0, 40 - n) * 1500).toISOString()} ` : '';
  return `${prefix ? `[pod/${pod.metadata.name}/${container}] ` : ''}${ts}${text}`;
}

function logTargets(w: World, f: Flags): Array<{ pod: any; container: string }> {
  const ns = typeof f.f['-n'] === 'string' ? f.f['-n'] : undefined;
  let pods: any[];
  if (typeof f.f['-l'] === 'string') pods = query(w, 'pods', ns, { '-l': f.f['-l'] });
  else pods = w.objects.filter((o) => o.kind === 'Pod' && o.metadata.name === f.pos[1] && o.metadata.namespace === ns);
  return pods.flatMap((p) => {
    const names = typeof f.f['-c'] === 'string' ? [f.f['-c']] : p.spec.containers.map((c: any) => c.name);
    return names.map((container: string) => ({ pod: p, container }));
  });
}

// ---- fake child processes -----------------------------------------------------------

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  private timers: NodeJS.Timeout[] = [];
  onKill?: () => void;

  every(ms: number, fn: () => void) {
    this.timers.push(setInterval(fn, ms));
  }

  finish(code: number) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    for (const t of this.timers) clearInterval(t);
    this.onKill?.();
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', code));
  }

  kill() {
    this.finish(0);
    return true;
  }
}

export function demoSpawn(args: string[]): ChildProcess {
  const child = new FakeChild();
  const { f, pos } = parse(args);
  const w = world(String(f['--context'] ?? 'local-dev'));

  if (pos[0] === 'logs') {
    const targets = logTargets(w, { f, pos });
    const tail = Number(f['--tail'] ?? 500);
    const timestamps = !!f['--timestamps'];
    const prefix = !!f['--prefix'];
    setImmediate(() => {
      if (!targets.length) {
        child.stderr.write(`error: pods "${pos[1] ?? ''}" not found\n`);
        child.finish(1);
        return;
      }
      const initial = Math.min(tail < 0 ? 40 : tail, 40);
      for (let n = 0; n < initial; n++) {
        for (const { pod, container } of targets) child.stdout.write(logLine(pod, n, timestamps, prefix, container) + '\n');
      }
      if (!f['-f']) {
        child.finish(0);
        return;
      }
      let n = initial;
      child.every(700, () => {
        const { pod, container } = targets[n % targets.length];
        n++;
        const line = logLine(pod, n, false, prefix, container);
        child.stdout.write((timestamps ? line.replace(/^(\[[^\]]+\] )?/, `$1${new Date().toISOString()} `) : line) + '\n');
      });
    });
  } else if (pos[0] === 'port-forward') {
    const [local, remote] = (pos[2] ?? '0:0').split(':').map(Number);
    let server: Server | null = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`KubeDeck demo: forwarded to ${pos[1]} port ${remote}\n`);
    });
    server.on('error', () => child.finish(1));
    server.listen(local, '127.0.0.1', () => child.stdout.write(`Forwarding from 127.0.0.1:${local} -> ${remote}\n`));
    child.onKill = () => {
      server?.close();
      server = null;
    };
  } else {
    setImmediate(() => child.finish(0));
  }
  return child as unknown as ChildProcess;
}

// ---- command dispatch ---------------------------------------------------------------

const addedContexts: typeof contexts = [];

export async function demoRun(bin: string, args: string[], command: string): Promise<string> {
  await new Promise((r) => setTimeout(r, 60 + Math.random() * 120)); // feel like a real API call
  if (bin === 'helm') return helmCmd(args, command);
  if (bin === 'az') return azCmd(args);
  if (bin === 'kubelogin') return '';
  return kubectlCmd(args, command);
}

function kubectlCmd(args: string[], command: string): string {
  const { f, pos } = parse(args);
  const ctx = String(f['--context'] ?? 'local-dev');
  const w = world(ctx);
  const ns = typeof f['-n'] === 'string' ? f['-n'] : undefined;
  const out = String(f['-o'] ?? '');

  switch (pos[0]) {
    case 'config': {
      if (pos[1] === 'view') {
        const all = [...contexts, ...addedContexts];
        return JSON.stringify({
          'current-context': 'local-dev',
          contexts: all.map((c) => ({ name: c.name, context: { cluster: c.cluster, user: c.user, ...(c.namespace ? { namespace: c.namespace } : {}) } })),
          clusters: all.map((c) => ({ name: c.cluster, cluster: { server: c.server } })),
        });
      }
      return `Context "${pos[2] ?? ''}" modified.\n`;
    }
    case 'api-resources':
      return apiResourcesTable();
    case 'version':
      return JSON.stringify({ clientVersion: { gitVersion: 'v1.30.4' }, serverVersion: { gitVersion: ctx === 'prod-eu' ? 'v1.30.4' : 'v1.30.4+k3s1' } });
    case 'get': {
      if (typeof f['--raw'] === 'string') return JSON.stringify(metrics(w, f['--raw']));
      const types = (pos[1] ?? '').split(',');
      const name = pos[2];
      if (name) {
        const res = resourceFor(types[0]);
        const o = res && w.objects.find((x) => x.kind === res.kind && x.metadata.name === name && (!res.namespaced || !ns || x.metadata.namespace === ns));
        if (!o) err(`Error from server (NotFound): ${res?.name ?? types[0]} "${name}" not found`, command);
        if (out === 'yaml') return toYaml(withApi(o)) + '\n';
        return JSON.stringify(withApi(o));
      }
      const items = types.flatMap((t) => query(w, t, f['--all-namespaces'] ? undefined : ns, f));
      if (out.startsWith('jsonpath')) return items.map((o) => o.metadata.name).join(' ');
      if (out === 'name') return items.map((o) => `${o.kind.toLowerCase()}/${o.metadata.name}`).join('\n') + '\n';
      return JSON.stringify({ apiVersion: 'v1', kind: 'List', items: items.map(withApi) });
    }
    case 'describe': {
      const res = resourceFor(pos[1] ?? '');
      const o = res && w.objects.find((x) => x.kind === res.kind && x.metadata.name === pos[2] && (!ns || x.metadata.namespace === ns));
      if (!o) err(`Error from server (NotFound): ${pos[1]} "${pos[2]}" not found`, command);
      return describe(w, o);
    }
    case 'logs': {
      const targets = logTargets(w, { f, pos });
      if (!targets.length) err(`Error from server (NotFound): pods "${pos[1]}" not found`, command);
      const { pod, container } = targets[0];
      if (f['--previous']) {
        if (pod.metadata.name === 'api-7d9f8c6b5-m4zt8') return OOM_PREVIOUS.join('\n') + '\n';
        err(`Error from server (BadRequest): previous terminated container "${container}" in pod "${pod.metadata.name}" not found`, command);
      }
      const tail = Math.min(Number(f['--tail'] ?? 20), 40);
      return Array.from({ length: tail }, (_, n) => logLine(pod, n, false, false, container)).join('\n') + '\n';
    }
    case 'rollout':
    case 'scale':
    case 'delete':
    case 'annotate':
    case 'patch':
      return mutate(w, pos, f, command);
    default:
      throw new AppError('command', 'raw', `demo mode does not support "kubectl ${pos[0] ?? ''}"`, { command });
  }
}

function mutate(w: World, pos: string[], f: Record<string, string | true>, command: string): string {
  const targetArg = pos[0] === 'rollout' ? pos[2] : pos[1];
  const [type, name] = (targetArg ?? '').split('/');
  const res = resourceFor(type ?? '');
  const ns = typeof f['-n'] === 'string' ? f['-n'] : undefined;
  const o = res && w.objects.find((x) => x.kind === res.kind && x.metadata.name === name && (!ns || x.metadata.namespace === ns));
  if (!o || !res) err(`Error from server (NotFound): ${type} "${name}" not found`, command);
  const label = `${res.name.replace(/s$/, '')}${res.apiVersion.includes('/') ? `.${res.apiVersion.split('/')[0]}` : ''}/${name}`;

  if (pos[0] === 'delete' && o.kind === 'Pod') {
    w.objects.splice(w.objects.indexOf(o), 1);
    const owner = o.metadata.ownerReferences?.[0];
    const base = o.metadata.name.replace(/-[^-]+$/, '');
    if (owner) {
      const healthy = makePod(`${base}-${suffix(o.metadata.name + Date.now())}`, o.metadata.namespace, o.metadata.labels, { ...o.spec, nodeName: undefined }, owner, 0, 2);
      w.objects.push(healthy);
    }
    for (const wl of w.objects.filter((x) => ['Deployment', 'StatefulSet', 'DaemonSet'].includes(x.kind) && x.metadata.namespace === o.metadata.namespace && matches(o.metadata.labels, x.spec.selector?.matchLabels ?? {}))) refreshStatus(w, wl);
    return `pod "${name}" deleted\n`;
  }

  if (pos[0] === 'scale' && typeof f['--replicas'] === 'string') {
    const want = Number(f['--replicas']);
    const pods = w.objects.filter((p) => p.kind === 'Pod' && p.metadata.namespace === o.metadata.namespace && matches(p.metadata.labels, o.spec.selector.matchLabels));
    o.spec.replicas = want;
    const ownerRef = pods[0]?.metadata.ownerReferences?.[0] ?? { kind: o.kind, name: o.metadata.name, uid: o.metadata.uid };
    for (let i = pods.length; i < want; i++) {
      const pname = o.kind === 'StatefulSet' ? `${name}-${i}` : `${pods[0]?.metadata.name.replace(/-[^-]+$/, '') ?? name}-${suffix(name + i + Date.now())}`;
      w.objects.push(makePod(pname, o.metadata.namespace, o.spec.selector.matchLabels, o.spec.template.spec, ownerRef, i, 3));
    }
    for (const p of pods.slice(want)) w.objects.splice(w.objects.indexOf(p), 1);
    o.status.conditions = undefined;
    refreshStatus(w, o);
    return `${label} scaled\n`;
  }

  if (pos[0] === 'rollout') {
    const pods = w.objects.filter((p) => p.kind === 'Pod' && p.metadata.namespace === o.metadata.namespace && matches(p.metadata.labels, o.spec.selector.matchLabels));
    for (const p of pods) {
      w.objects.splice(w.objects.indexOf(p), 1);
      const base = o.kind === 'StatefulSet' ? p.metadata.name : p.metadata.name.replace(/-[^-]+$/, '');
      w.objects.push(makePod(o.kind === 'StatefulSet' ? base : `${base}-${suffix(p.metadata.name + Date.now())}`, p.metadata.namespace, p.metadata.labels, { ...o.spec.template.spec }, p.metadata.ownerReferences[0], 0, 4));
    }
    o.status.conditions = undefined;
    refreshStatus(w, o);
    return `${label} restarted\n`;
  }

  if (pos[0] === 'annotate') {
    o.status = { ...(o.status ?? {}), lastHandledReconcileAt: new Date().toISOString() };
    return `${label} annotated\n`;
  }

  if (pos[0] === 'patch' && typeof f['-p'] === 'string') {
    const patch = JSON.parse(f['-p']);
    o.spec = { ...o.spec, ...(patch.spec ?? {}) };
    return `${label} patched\n`;
  }
  return `${label} unchanged\n`;
}

// ---- helm and az ----------------------------------------------------------------------

const RELEASES = [
  { name: 'grafana', namespace: 'monitoring', revision: '4', status: 'deployed', chart: 'grafana-8.5.1', app_version: '11.2.0', updated: 86400 * 2 },
  { name: 'redis', namespace: 'apps', revision: '2', status: 'deployed', chart: 'redis-20.1.0', app_version: '7.4.0', updated: 86400 * 9 },
  { name: 'traefik', namespace: 'traefik', revision: '11', status: 'deployed', chart: 'traefik-32.1.0', app_version: 'v3.1.4', updated: 86400 * 5 },
  { name: 'metrics-server', namespace: 'kube-system', revision: '1', status: 'deployed', chart: 'metrics-server-3.12.1', app_version: '0.7.2', updated: 86400 * 40 },
];

function helmDate(secondsAgo: number): string {
  return new Date(START - secondsAgo * 1000).toISOString().replace('T', ' ').replace('Z', ' +0000 UTC');
}

function helmCmd(args: string[], command: string): string {
  const { f, pos } = parse(args);
  const ns = typeof f['-n'] === 'string' ? f['-n'] : undefined;
  if (pos[0] === 'list') {
    return JSON.stringify(RELEASES.filter((r) => !ns || r.namespace === ns).map((r) => ({ ...r, updated: helmDate(r.updated) })));
  }
  const name = pos[0] === 'get' ? pos[2] : pos[1];
  const r = RELEASES.find((x) => x.name === name);
  if (!r) err(`Error: release: not found`, command);
  const what = pos[0] === 'get' ? pos[1] : pos[0];
  switch (what) {
    case 'status':
      return `NAME: ${r.name}\nLAST DEPLOYED: ${helmDate(r.updated)}\nNAMESPACE: ${r.namespace}\nSTATUS: ${r.status}\nREVISION: ${r.revision}\nTEST SUITE: None\n`;
    case 'history':
      return JSON.stringify(Array.from({ length: Number(r.revision) }, (_, i) => ({
        revision: i + 1, updated: new Date(START - (r.updated + (Number(r.revision) - 1 - i) * 86400 * 3) * 1000).toISOString(),
        status: i + 1 === Number(r.revision) ? 'deployed' : 'superseded', chart: r.chart, app_version: r.app_version,
        description: i === 0 ? 'Install complete' : 'Upgrade complete',
      })));
    case 'values':
      return f['--all']
        ? `replicaCount: 1\nimage:\n  repository: ${r.name}\n  tag: ${r.app_version}\nresources:\n  limits:\n    memory: 512Mi\nservice:\n  type: ClusterIP\n  port: 80\npersistence:\n  enabled: false\n`
        : `resources:\n  limits:\n    memory: 512Mi\n`;
    case 'manifest':
      return `---\n# Source: ${r.chart}/templates/service.yaml\napiVersion: v1\nkind: Service\nmetadata:\n  name: ${r.name}\n  namespace: ${r.namespace}\nspec:\n  type: ClusterIP\n  ports:\n    - port: 80\n`;
    case 'notes':
      return `1. Get the application URL by running:\n   kubectl -n ${r.namespace} port-forward svc/${r.name} 8080:80\n`;
    default:
      return '';
  }
}

function azCmd(args: string[]): string {
  const { f, pos } = parse(args);
  if (pos[0] === 'account' && pos[1] === 'list') {
    return JSON.stringify([
      { id: '00000000-0000-4000-8000-000000000001', name: 'my-subscription', tenantId: '00000000-0000-4000-8000-0000000000aa', isDefault: true, state: 'Enabled' },
      { id: '00000000-0000-4000-8000-000000000002', name: 'my-other-subscription', tenantId: '00000000-0000-4000-8000-0000000000aa', isDefault: false, state: 'Enabled' },
    ]);
  }
  if (pos[0] === 'aks' && pos[1] === 'list') {
    return JSON.stringify([
      { name: 'my-aks-cluster', resourceGroup: 'my-resource-group', location: 'westeurope', currentKubernetesVersion: '1.30.4', powerState: { code: 'Running' }, aadProfile: {} },
      { name: 'my-aks-sandbox', resourceGroup: 'my-sandbox-rg', location: 'westeurope', currentKubernetesVersion: '1.29.7', powerState: { code: 'Stopped' } },
    ]);
  }
  if (pos[0] === 'aks' && pos[1] === 'get-credentials') {
    const name = String(f['--context'] ?? f['--name'] ?? 'my-aks-cluster');
    if (![...contexts, ...addedContexts].some((c) => c.name === name)) {
      addedContexts.push({ name, cluster: name, user: `clusterUser_${name}`, server: `https://${name}.hcp.westeurope.azmk8s.io`, namespace: '' });
    }
    return `Merged "${name}" as current context in ~/.kube/config\n`;
  }
  return '';
}
