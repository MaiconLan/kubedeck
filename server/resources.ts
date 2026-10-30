import { demoEnabled } from './demo.js';
import { AppError, invalid } from './errors.js';
import { checkName, checkType, kubectl, kubectlGet, kubectlJson, nsArgs, run } from './kube.js';
import { attachUsage, podUsage } from './podmetrics.js';

// ---- contexts ---------------------------------------------------------------

export interface ContextInfo {
  name: string;
  cluster: string;
  user: string;
  namespace: string;
  server: string;
}

export async function listContexts(): Promise<{ current: string; contexts: ContextInfo[] }> {
  const cfg = JSON.parse(await run('kubectl', ['config', 'view', '-o', 'json'], { timeoutMs: 10_000 }));
  const clusters = new Map<string, string>(
    (cfg.clusters ?? []).map((c: any) => [c.name, c.cluster?.server ?? '']),
  );
  const contexts: ContextInfo[] = (cfg.contexts ?? []).map((c: any) => ({
    name: c.name,
    cluster: c.context?.cluster ?? '',
    user: c.context?.user ?? '',
    namespace: c.context?.namespace ?? '',
    server: clusters.get(c.context?.cluster) ?? '',
  }));
  return { current: cfg['current-context'] ?? '', contexts };
}

let knownContexts: { at: number; names: Set<string> } | null = null;

/** Context names are free-form, so we only accept ones present in the kubeconfig. */
export async function checkContext(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !value) throw invalid('contextMissing', 'No context given.');
  if (!knownContexts || Date.now() - knownContexts.at > 30_000 || !knownContexts.names.has(value)) {
    const { contexts } = await listContexts();
    knownContexts = { at: Date.now(), names: new Set(contexts.map((c) => c.name)) };
  }
  if (!knownContexts.names.has(value)) throw invalid('contextUnknown', `Context "${value}" does not exist in the kubeconfig.`, { name: value });
  return value;
}

// ---- namespaces -------------------------------------------------------------

export async function listNamespaces(ctx: string): Promise<{ forbidden: boolean; names: string[] }> {
  try {
    const items = await listItems(ctx, 'namespaces', undefined, {}, 20_000);
    return { forbidden: false, names: items.map((n: any) => String(n.metadata?.name ?? '')).filter(Boolean).sort() };
  } catch (err) {
    if (err instanceof AppError && err.kind === 'forbidden') return { forbidden: true, names: [] };
    throw err;
  }
}

// ---- discovery ----------------------------------------------------------------

export interface ApiResource {
  name: string;
  shortNames: string[];
  group: string;
  version: string;
  namespaced: boolean;
  kind: string;
  verbs: string[];
  /** Fully qualified type accepted by kubectl, e.g. "deployments.apps". */
  type: string;
}

const discoveryCache = new Map<string, { at: number; list: ApiResource[] }>();

export async function discover(ctx: string, fresh = false): Promise<ApiResource[]> {
  const hit = discoveryCache.get(ctx);
  if (hit && !fresh && Date.now() - hit.at < 5 * 60_000) return hit.list;

  // api-resources exits non-zero when one aggregated API (often metrics) is down,
  // while still printing everything else, so partial output is accepted. When the
  // cluster is unreachable it prints only the header: that must fail, or an empty
  // list gets cached and every screen looks unavailable.
  const text = await kubectl(ctx, ['api-resources', '-o', 'wide'], { allowPartial: (out) => /^pods\s/m.test(out), timeoutMs: 30_000 });
  const list = parseApiResources(text);
  discoveryCache.set(ctx, { at: Date.now(), list });
  return list;
}

function parseApiResources(text: string): ApiResource[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = lines.shift() ?? '';
  const cols = ['NAME', 'SHORTNAMES', 'APIVERSION', 'NAMESPACED', 'KIND', 'VERBS', 'CATEGORIES'];
  const starts = cols.map((c) => header.indexOf(c));
  const cell = (line: string, i: number) => {
    if (starts[i] < 0) return '';
    const next = starts.slice(i + 1).find((s) => s > 0);
    return line.slice(starts[i], next ?? undefined).trim();
  };

  return lines.map((line) => {
    const apiVersion = cell(line, 2);
    const [group, version] = apiVersion.includes('/') ? apiVersion.split('/') : ['', apiVersion];
    const name = cell(line, 0);
    return {
      name,
      shortNames: cell(line, 1).split(',').filter(Boolean),
      group,
      version,
      namespaced: cell(line, 3) === 'true',
      kind: cell(line, 4),
      verbs: cell(line, 5).replace(/[[\]]/g, '').split(/\s+/).filter(Boolean),
      type: group ? `${name}.${group}` : name,
    };
  });
}

// ---- reading objects ----------------------------------------------------------

const SELECTOR_RE = /^[\w.\/=!,:() -]{1,500}$/;

function checkSelector(value: string, field: string): string {
  if (!SELECTOR_RE.test(value) || value.startsWith('-')) throw invalid('invalidField', `Invalid value for ${field}.`, { field });
  return value;
}

export interface ListFilter {
  /** Label selector, e.g. "app=api,tier!=db". */
  labels?: string;
  /** Field selector, e.g. "spec.nodeName=node-1". */
  fields?: string;
}

const FULL_VERBS = ['get', 'list'];
const rt = (name: string, group: string, version: string, kind: string, namespaced: boolean): ApiResource => ({
  name, group, version, kind, namespaced, shortNames: [], verbs: FULL_VERBS, type: group ? `${name}.${group}` : name,
});
/** Types the hot screens read, known without discovery (which is a slow `kubectl api-resources`). */
const BUILTIN: ApiResource[] = [
  rt('pods', '', 'v1', 'Pod', true),
  rt('nodes', '', 'v1', 'Node', false),
  rt('namespaces', '', 'v1', 'Namespace', false),
  rt('events', '', 'v1', 'Event', true),
  rt('deployments', 'apps', 'v1', 'Deployment', true),
  rt('statefulsets', 'apps', 'v1', 'StatefulSet', true),
  rt('daemonsets', 'apps', 'v1', 'DaemonSet', true),
];

async function findResource(ctx: string, type: string): Promise<ApiResource | undefined> {
  if (demoEnabled()) return undefined;
  const builtin = BUILTIN.find((r) => r.type === type);
  if (builtin) return builtin;
  const known = await discover(ctx).catch(() => [] as ApiResource[]);
  return known.find((r) => r.type === type) ?? known.find((r) => r.name === type);
}

const apiVersionOf = (res: ApiResource) => (res.group ? `${res.group}/${res.version}` : res.version);

/** API path of a list (no `name`) or one object. An empty or "*" namespace lists across namespaces. */
export function apiPath(res: ApiResource, o: { ns?: string; name?: string; labels?: string; fields?: string }): string {
  const base = res.group ? `/apis/${res.group}/${res.version}` : `/api/${res.version}`;
  const scope = res.namespaced && o.ns && o.ns !== '*' ? `/namespaces/${checkName(o.ns, 'namespace')}` : '';
  const query = new URLSearchParams();
  if (o.labels) query.set('labelSelector', o.labels);
  if (o.fields) query.set('fieldSelector', o.fields);
  const qs = query.size ? `?${query}` : '';
  return `${base}${scope}/${res.name}${o.name ? `/${checkName(o.name, 'name')}` : ''}${qs}`;
}

/**
 * Items of `type`, read through the API (kubectl proxy) when discovery knows the type, else with
 * `kubectl get`. A REST list leaves `kind`/`apiVersion` off its items, so they are filled in.
 * Every type of a comma-separated list is read separately and merged.
 */
export async function listItems(ctx: string, types: string, ns: string | undefined, filter: ListFilter = {}, timeoutMs = 30_000): Promise<any[]> {
  const labels = filter.labels ? checkSelector(filter.labels, 'selector') : undefined;
  const fields = filter.fields ? checkSelector(filter.fields, 'selector') : undefined;
  const one = async (type: string): Promise<any[]> => {
    checkType(type);
    const res = await findResource(ctx, type);
    if (!res || !res.verbs.includes('list')) {
      const namespaced = res ? res.namespaced : await isNamespaced(ctx, type);
      const args = ['get', type, ...(namespaced ? nsArgs(ns) : [])];
      if (labels) args.push('-l', labels);
      if (fields) args.push('--field-selector', fields);
      return (await kubectlJson(ctx, args, { timeoutMs })).items ?? [];
    }
    const data = await kubectlGet(ctx, apiPath(res, { ns, labels, fields }), { timeoutMs });
    return (data.items ?? []).map((item: any) => ({ apiVersion: apiVersionOf(res), kind: res.kind, ...item }));
  };
  const lists = await Promise.all(types.split(',').map(one));
  return lists.flat();
}

export async function listObjects(ctx: string, type: string, ns: string | undefined, filter: ListFilter = {}) {
  checkType(type);
  const res = await findResource(ctx, type);
  const namespaced = res ? res.namespaced : await isNamespaced(ctx, type);
  const items = await listItems(ctx, type, ns, filter);
  for (const item of items) sanitize(item);
  if (type === 'pods') attachUsage(items, await podUsage(ctx, ns));
  return { namespaced, items };
}

async function isNamespaced(ctx: string, type: string): Promise<boolean> {
  const list = await discover(ctx).catch(() => [] as ApiResource[]);
  const found = list.find((r) => r.type === type || r.name === type);
  return found ? found.namespaced : true;
}

/** Strips noise, and never sends secret values in list responses. */
function sanitize(item: any) {
  if (item?.metadata) delete item.metadata.managedFields;
  if (item?.kind === 'Secret' && item.data) {
    item.dataKeys = Object.keys(item.data);
    delete item.data;
  }
  if (item?.metadata?.annotations) {
    delete item.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
  }
}

function objectArgs(type: string, name: string, ns: string | undefined): string[] {
  checkType(type);
  checkName(name, 'name');
  return ns ? [type, name, '-n', checkName(ns, 'namespace')] : [type, name];
}

export function getYaml(ctx: string, type: string, name: string, ns?: string) {
  return kubectl(ctx, ['get', ...objectArgs(type, name, ns), '-o', 'yaml']);
}

/** One object, read through the API (kubectl proxy) when discovery knows the type, else with `kubectl get`. */
async function getItem(ctx: string, type: string, name: string, ns?: string): Promise<any> {
  const args = objectArgs(type, name, ns);
  const res = await findResource(ctx, type);
  if (!res || !res.verbs.includes('get') || (res.namespaced && !ns)) return kubectlJson(ctx, ['get', ...args]);
  const obj = await kubectlGet(ctx, apiPath(res, { ns, name }));
  return { apiVersion: apiVersionOf(res), kind: res.kind, ...obj };
}

export async function getJson(ctx: string, type: string, name: string, ns?: string) {
  const obj = await getItem(ctx, type, name, ns);
  sanitize(obj);
  if (type === 'pods' && ns) attachUsage([obj], await podUsage(ctx, ns, name));
  return obj;
}

export function describe(ctx: string, type: string, name: string, ns?: string) {
  return kubectl(ctx, ['describe', ...objectArgs(type, name, ns)], { timeoutMs: 30_000 });
}

export async function eventsFor(ctx: string, kind: string, name: string, ns?: string) {
  checkName(kind, 'kind');
  checkName(name, 'name');
  const selector = `involvedObject.name=${name},involvedObject.kind=${kind}`;
  const items = await listItems(ctx, 'events', ns, { fields: selector }, 20_000);
  return items.sort((a: any, b: any) => eventTime(b) - eventTime(a));
}

function eventTime(e: any): number {
  return Date.parse(e.lastTimestamp || e.eventTime || e.metadata?.creationTimestamp || 0) || 0;
}

export interface DecodedValue {
  key: string;
  value: string;
  binary: boolean;
  bytes: number;
}

export async function decodeSecret(ctx: string, name: string, ns: string): Promise<{ type: string; values: DecodedValue[] }> {
  const obj = await kubectlJson(ctx, ['get', ...objectArgs('secrets', name, ns)]);
  const values = Object.entries<string>(obj.data ?? {}).map(([key, b64]) => {
    const buf = Buffer.from(b64, 'base64');
    const text = buf.toString('utf8');
    const binary = !Buffer.from(text, 'utf8').equals(buf) || /[\x00-\x08\x0e-\x1f]/.test(text);
    return { key, value: binary ? b64 : text, binary, bytes: buf.length };
  });
  return { type: obj.type ?? '', values: values.sort((a, b) => a.key.localeCompare(b.key)) };
}
