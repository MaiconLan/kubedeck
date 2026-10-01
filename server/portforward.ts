import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import { AppError, classifyStderr, invalid } from './errors.js';
import { checkName, spawnKubectl } from './kube.js';

/** kubectl port-forward accepts these resource kinds. */
const TARGETS: Record<string, string> = {
  pods: 'pod',
  services: 'svc',
  'deployments.apps': 'deployment',
  'statefulsets.apps': 'statefulset',
};

export interface ForwardRequest {
  ctx: string;
  ns: string;
  type: string;
  name: string;
  remotePort: number;
  /** 0 or missing: pick a free port. */
  localPort?: number;
}

interface Forward {
  id: string;
  ctx: string;
  ns: string;
  type: string;
  name: string;
  remotePort: number;
  localPort: number;
  status: 'starting' | 'active' | 'error' | 'stopped';
  error?: unknown;
  startedAt: string;
  command: string;
  child?: ChildProcess;
}

const forwards = new Map<string, Forward>();

function publicView(f: Forward) {
  const { child: _child, ...rest } = f;
  return rest;
}

export function listForwards() {
  return [...forwards.values()].map(publicView);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

function checkPort(value: unknown, allowZero: boolean): number {
  const n = Number(value ?? 0);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1) || n > 65535) throw invalid('invalidPort', 'Invalid port.');
  return n;
}

export async function startForward(req: ForwardRequest) {
  const kind = TARGETS[req.type];
  if (!kind) throw invalid('forwardNotAllowed', `Port-forward is not available for ${req.type}.`, { type: req.type });
  const ns = checkName(req.ns, 'namespace');
  const name = checkName(req.name, 'name');
  const remotePort = checkPort(req.remotePort, false);
  let localPort = checkPort(req.localPort, true);

  if (localPort === 0) {
    localPort = await freePort();
  } else if (!(await portAvailable(localPort))) {
    throw new AppError('invalid', 'portInUse', `Local port ${localPort} is already in use.`, { params: { port: localPort } });
  }

  const { child, command } = spawnKubectl(req.ctx, [
    'port-forward', '-n', ns, `${kind}/${name}`, `${localPort}:${remotePort}`, '--address', '127.0.0.1',
  ]);

  const fwd: Forward = {
    id: randomUUID(),
    ctx: req.ctx,
    ns,
    type: req.type,
    name,
    remotePort,
    localPort,
    status: 'starting',
    startedAt: new Date().toISOString(),
    command,
    child,
  };
  forwards.set(fwd.id, fwd);

  let stderr = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    if (chunk.includes('Forwarding from')) fwd.status = 'active';
  });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    stderr += chunk;
    if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
  });
  child.on('error', (err) => {
    fwd.status = 'error';
    fwd.error = new AppError('missing-binary', 'missingBinary', '"kubectl" was not found in PATH.', {
      detail: String(err), command, params: { bin: 'kubectl' },
    }).toJSON();
  });
  child.on('close', () => {
    fwd.child = undefined;
    if (fwd.status === 'stopped') return;
    fwd.status = 'error';
    fwd.error = stderr.trim()
      ? classifyStderr(stderr, command).toJSON()
      : new AppError('command', 'forwardEnded', 'The port-forward ended.', { command }).toJSON();
  });

  // Wait briefly so most failures (pod not found, port refused) are reported right away.
  await new Promise<void>((resolve) => {
    const done = () => { clearInterval(poll); clearTimeout(limit); resolve(); };
    const poll = setInterval(() => fwd.status !== 'starting' && done(), 100);
    const limit = setTimeout(done, 8000);
  });
  if (fwd.status === 'error') {
    forwards.delete(fwd.id);
    const e = fwd.error as any;
    throw new AppError(e.kind ?? 'command', e.code ?? 'raw', e.message ?? 'Port-forward failed.', {
      detail: e.detail, command, params: e.params,
    });
  }
  return publicView(fwd);
}

export function stopForward(id: string | null) {
  const fwd = id ? forwards.get(id) : undefined;
  if (!fwd) throw new AppError('notfound', 'notFound', 'Resource not found.');
  fwd.status = 'stopped';
  fwd.child?.kill();
  forwards.delete(fwd.id);
  return { ok: true };
}

export function stopAllForwards() {
  for (const fwd of forwards.values()) {
    fwd.status = 'stopped';
    fwd.child?.kill();
  }
  forwards.clear();
}
