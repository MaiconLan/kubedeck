import { AppError, invalid } from './errors.js';
import { checkName, checkType, kubectl, kubectlJson, nsArgs, run } from './kube.js';

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
    const out = await kubectl(ctx, ['get', 'namespaces', '-o', 'jsonpath={.items[*].metadata.name}']);
    return { forbidden: false, names: out.split(/\s+/).filter(Boolean).sort() };
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

export async function listObjects(ctx: string, type: string, ns: string | undefined, filter: ListFilter = {}) {
  checkType(type);
  const namespaced = await isNamespaced(ctx, type);
  const args = ['get', type, ...(namespaced ? nsArgs(ns) : [])];
  if (filter.labels) args.push('-l', checkSelector(filter.labels, 'selector'));
  if (filter.fields) args.push('--field-selector', checkSelector(filter.fields, 'selector'));
  const data = await kubectlJson(ctx, args, { timeoutMs: 30_000 });
  const items: any[] = data.items ?? [];
  for (const item of items) sanitize(item);
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

export async function getJson(ctx: string, type: string, name: string, ns?: string) {
  const obj = await kubectlJson(ctx, ['get', ...objectArgs(type, name, ns)]);
  sanitize(obj);
  return obj;
}

export function describe(ctx: string, type: string, name: string, ns?: string) {
  return kubectl(ctx, ['describe', ...objectArgs(type, name, ns)], { timeoutMs: 30_000 });
}

export async function eventsFor(ctx: string, kind: string, name: string, ns?: string) {
  checkName(kind, 'kind');
  checkName(name, 'name');
  const selector = `involvedObject.name=${name},involvedObject.kind=${kind}`;
  const data = await kubectlJson(ctx, [
    'get', 'events', ...(ns ? ['-n', checkName(ns, 'namespace')] : ['--all-namespaces']),
    '--field-selector', selector,
  ]);
  return (data.items ?? []).sort((a: any, b: any) => eventTime(b) - eventTime(a));
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
