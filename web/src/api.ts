import type { ActionName } from './catalog';

export interface ApiError {
  kind: string;
  message: string;
  detail?: string;
  command?: string;
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
    throw new RequestError({ kind: 'offline', message: 'O servidor do KubeDeck não está respondendo. Ele ainda está rodando no terminal?' });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new RequestError(data ?? { kind: 'command', message: `Erro HTTP ${res.status}` });
  return data as T;
}

export const api = {
  contexts: () => request<{ current: string; contexts: ContextInfo[] }>('GET', '/api/contexts'),
  settings: () => request<Settings>('GET', '/api/settings'),
  saveSettings: (patch: Partial<Settings>) => request<Settings>('PUT', '/api/settings', {}, patch),
  commands: () => request<CommandEntry[]>('GET', '/api/commands'),
  namespaces: (ctx: string) => request<{ forbidden: boolean; names: string[] }>('GET', '/api/namespaces', { ctx }),
  discovery: (ctx: string, fresh = false) => request<ApiResource[]>('GET', '/api/discovery', { ctx, fresh }),
  list: (ctx: string, type: string, ns: string) =>
    request<{ namespaced: boolean; items: any[] }>('GET', '/api/list', { ctx, type, ns }),
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
  label: string;
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
  lastContext?: string;
  lastNamespace: Record<string, string>;
  knownNamespaces: Record<string, string[]>;
  contextColors: Record<string, string>;
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
  return { kind: 'command', message: String((err as Error)?.message ?? err) };
}
