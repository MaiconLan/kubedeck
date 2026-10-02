import type { ActionName } from './catalog';
import { t, tryT, type Language } from './i18n';

export interface ApiError {
  kind: string;
  /** Message id for translation; "raw" means `message` is tool output to show as-is. */
  code?: string;
  /** English fallback. */
  message: string;
  params?: Record<string, string | number>;
  detail?: string;
  command?: string;
  step?: string;
}

/** Translated, user-facing text for an API error. */
export function errorMessage(err: ApiError): string {
  const params = { ...(err.params ?? {}) };
  if (typeof params.field === 'string') params.field = tryT(`field.${params.field}`) ?? params.field;
  const text = err.code && err.code !== 'raw' ? tryT(`error.${err.code}`, params) ?? err.message : err.message;
  const step = err.step ? tryT(`step.${err.step}`) : undefined;
  return step ? `${step}: ${text}` : text;
}

export class RequestError extends Error {
  constructor(readonly info: ApiError) {
    super(info.message);
  }
}

const TOKEN_KEY = 'kubedeck.token';

function readToken(): string {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('t');
  if (fromUrl) {
    try { sessionStorage.setItem(TOKEN_KEY, fromUrl); } catch { /* storage may be blocked */ }
    url.searchParams.delete('t');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    return fromUrl;
  }
  try { return sessionStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}

const token = readToken();

/** Session token, for opening another window of this same server. */
export function sessionToken(): string {
  return token;
}

/** True inside the Electron desktop app. */
export const isDesktop = /\bElectron\//.test(navigator.userAgent);

// Several tabs often share a context: share their discovery/namespace calls.
const shared = new Map<string, { at: number; promise: Promise<unknown> }>();

function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = shared.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise as Promise<T>;
  const promise = load();
  shared.set(key, { at: Date.now(), promise });
  promise.catch(() => shared.delete(key));
  return promise;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || v === false) continue;
    p.set(k, v === true ? '1' : String(v));
  }
  return p.toString();
}

async function request<T>(method: string, path: string, params: Record<string, any> = {}, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${path}?${qs(params)}`, {
      method,
      headers: { 'x-kubedeck-token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new RequestError({ kind: 'offline', code: 'offline', message: t('error.offline') });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new RequestError(data ?? { kind: 'command', code: 'http', params: { status: res.status }, message: `HTTP error ${res.status}` });
  return data as T;
}

export const api = {
  contexts: () => request<{ current: string; contexts: ContextInfo[] }>('GET', '/api/contexts'),
  settings: () => request<Settings>('GET', '/api/settings'),
  saveSettings: (patch: Partial<Settings>) => request<Settings>('PUT', '/api/settings', {}, patch),
  commands: () => request<CommandEntry[]>('GET', '/api/commands'),
  namespaces: (ctx: string) =>
    cached(`ns:${ctx}`, 30_000, () => request<{ forbidden: boolean; names: string[] }>('GET', '/api/namespaces', { ctx })),
  discovery: (ctx: string, fresh = false) =>
    fresh
      ? request<ApiResource[]>('GET', '/api/discovery', { ctx, fresh })
      : cached(`disc:${ctx}`, 120_000, () => request<ApiResource[]>('GET', '/api/discovery', { ctx })),
  list: (ctx: string, type: string, ns: string, filter: { labels?: string; fields?: string } = {}) =>
    request<{ namespaced: boolean; items: any[] }>('GET', '/api/list', { ctx, type, ns, ...filter }),
  dashboard: (ctx: string, ns: string) => request<DashboardData>('GET', '/api/dashboard', { ctx, ns }),
  /** Facts for the rule-based diagnosis (see diagnosis.ts). */
  diagnose: (ctx: string, type: string, name: string, ns: string) => request<unknown>('GET', '/api/diagnose', { ctx, type, name, ns }),
  forwards: () => request<PortForward[]>('GET', '/api/forwards'),
  startForward: (body: { ctx: string; ns: string; type: string; name: string; remotePort: number; localPort?: number }) =>
    request<PortForward>('POST', '/api/forwards', {}, body),
  stopForward: (id: string) => request<{ ok: boolean }>('DELETE', '/api/forwards', { id }),
  object: (ctx: string, type: string, name: string, ns?: string) => request<any>('GET', '/api/object', { ctx, type, name, ns }),
  yaml: (ctx: string, type: string, name: string, ns?: string) =>
    request<{ text: string }>('GET', '/api/object', { ctx, type, name, ns, format: 'yaml' }),
  describe: (ctx: string, type: string, name: string, ns?: string) =>
    request<{ text: string }>('GET', '/api/describe', { ctx, type, name, ns }),
  events: (ctx: string, kind: string, name: string, ns?: string) => request<any[]>('GET', '/api/events', { ctx, kind, name, ns }),
  secret: (ctx: string, name: string, ns: string) =>
    request<{ type: string; values: Array<{ key: string; value: string; binary: boolean; bytes: number }> }>('GET', '/api/secret', { ctx, name, ns }),
  helmReleases: (ctx: string, ns: string) => request<any[]>('GET', '/api/helm/releases', { ctx, ns }),
  helmDetail: (ctx: string, ns: string, name: string, view: string) =>
    request<{ text: string }>('GET', '/api/helm/detail', { ctx, ns, name, view }),
  action: (body: ActionBody) => request<{ command: string; output: string; protected: boolean }>('POST', '/api/action', {}, body),
  azureSubscriptions: () => request<AzureSubscription[]>('GET', '/api/azure/subscriptions'),
  azureClusters: (subscription: string) => request<AksCluster[]>('GET', '/api/azure/clusters', { subscription }),
  addAks: (body: AddAksBody) => request<{ context: string; steps: StepResult[] }>('POST', '/api/azure/add', {}, body),
  logsUrl: (params: Record<string, any>) => `/api/logs?${qs({ ...params, t: token })}`,
};

export interface ActionBody {
  ctx: string;
  ns: string;
  type: string;
  name: string;
  action: ActionName;
  replicas?: number;
  confirmName?: string;
  dryRun?: boolean;
}

export type Part<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface Usage {
  cpu: number;
  memory: number;
}

export interface DashboardNode {
  name: string;
  labels: Record<string, string>;
  unschedulable: boolean;
  conditions: any[];
  kubeletVersion: string;
  capacity: Usage & { pods: number };
  allocatable: Usage & { pods: number };
}

export interface DashboardData {
  version: Part<string>;
  nodes: Part<DashboardNode[]>;
  nodeMetrics: Part<Array<Usage & { name: string }>>;
  /** Slim pods: metadata/spec/status subsets plus summed container requests. */
  pods: Part<any[]>;
  podMetrics: Part<Array<Usage & { name: string; namespace: string }>>;
  workloads: Part<any[]>;
  flux: Part<any[]> | null;
  warnings: Part<any[]>;
  allNamespaces: boolean;
}

export interface PortForward {
  id: string;
  ctx: string;
  ns: string;
  type: string;
  name: string;
  remotePort: number;
  localPort: number;
  status: 'starting' | 'active' | 'error' | 'stopped';
  error?: ApiError;
  startedAt: string;
  command: string;
}

export interface AzureSubscription {
  id: string;
  name: string;
  tenantId: string;
  isDefault: boolean;
  state: string;
}

export interface AksCluster {
  name: string;
  resourceGroup: string;
  location: string;
  kubernetesVersion: string;
  powerState: string;
  aad: boolean;
}

export interface AddAksBody {
  subscription: string;
  resourceGroup: string;
  cluster: string;
  contextName?: string;
  namespace?: string;
  kubelogin?: boolean;
  dryRun?: boolean;
}

export interface StepResult {
  step: string;
  note?: string;
  command: string;
  ok: boolean;
  skipped?: boolean;
  output: string;
}

export interface ContextInfo {
  name: string;
  cluster: string;
  user: string;
  namespace: string;
  server: string;
}

export interface Settings {
  protectedContexts: string[];
  refreshSeconds: number;
  theme: 'dark' | 'light';
  language?: Language;
  lastContext?: string;
  lastNamespace: Record<string, string>;
  knownNamespaces: Record<string, string[]>;
  contextColors: Record<string, string>;
  /** Saved tabs and panes of the main window (see tabs.ts). */
  layout?: unknown;
}

export interface ApiResource {
  name: string;
  shortNames: string[];
  group: string;
  version: string;
  namespaced: boolean;
  kind: string;
  verbs: string[];
  type: string;
}

export interface CommandEntry {
  id: number;
  at: string;
  command: string;
  write: boolean;
  ok: boolean;
  ms: number;
}

export function errorOf(err: unknown): ApiError {
  if (err instanceof RequestError) return err.info;
  return { kind: 'command', code: 'raw', message: String((err as Error)?.message ?? err) };
}
