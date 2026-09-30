import type { IncomingMessage, ServerResponse } from 'node:http';
import { classifyStderr, invalid } from './errors.js';
import { checkName, checkType, kubectlJson, spawnKubectl } from './kube.js';

export interface LogParams {
  ctx: string;
  ns: string;
  /** "pods" or a workload type (deployments.apps, statefulsets.apps, ...). */
  type: string;
  name: string;
  container?: string;
  tail: number;
  previous: boolean;
  timestamps: boolean;
  follow: boolean;
}

async function buildArgs(p: LogParams): Promise<string[]> {
  const ns = checkName(p.ns, 'namespace');
  const name = checkName(p.name, 'name');
  const type = checkType(p.type);
  const args = ['logs', '-n', ns, `--tail=${Math.max(-1, Math.min(p.tail, 100_000))}`];

  if (type === 'pods') {
    args.push(name);
  } else {
    // Workload: follow every pod behind its selector, prefixed with pod/container.
    const obj = await kubectlJson(p.ctx, ['get', type, name, '-n', ns]);
    const labels: Record<string, string> = obj.spec?.selector?.matchLabels ?? {};
    const selector = Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',');
    if (!selector) throw invalid('noSelector', 'This resource has no pod selector.');
    args.push('-l', selector, '--prefix', '--max-log-requests=20');
    if (!p.container) args.push('--all-containers=true');
  }

  if (p.container) args.push('-c', checkName(p.container, 'container'));
  if (p.previous) args.push('--previous');
  if (p.timestamps) args.push('--timestamps');
  if (p.follow) args.push('-f');
  return args;
}

export async function streamLogs(req: IncomingMessage, res: ServerResponse, p: LogParams) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event: string, data: unknown) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let args: string[];
  try {
    args = await buildArgs(p);
  } catch (err: any) {
    send('failure', err?.toJSON?.() ?? { kind: 'invalid', code: 'raw', message: String(err?.message ?? err) });
    res.end();
    return;
  }

  const { child, command } = spawnKubectl(p.ctx, args);
  send('start', { command });

  let pending: string[] = [];
  let remainder = '';
  let stderr = '';

  const flush = () => {
    if (pending.length) {
      send('lines', pending);
      pending = [];
    }
  };
  const ticker = setInterval(flush, 120);
  const heartbeat = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15_000);

  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    const parts = (remainder + chunk).split(/\r?\n/);
    remainder = parts.pop() ?? '';
    pending.push(...parts);
    if (pending.length > 2000) flush();
  });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const cleanup = () => {
    clearInterval(ticker);
    clearInterval(heartbeat);
  };

  child.on('error', (err) => {
    cleanup();
    send('failure', { kind: 'missing-binary', code: 'missingBinary', params: { bin: 'kubectl' }, message: '"kubectl" was not found in PATH.', detail: String(err) });
    res.end();
  });

  child.on('close', (code) => {
    if (remainder) pending.push(remainder);
    flush();
    cleanup();
    if (code && code !== 0 && stderr.trim()) send('failure', classifyStderr(stderr, command).toJSON());
    else if (stderr.trim()) send('warning', stderr.trim());
    send('end', { code });
    res.end();
  });

  req.on('close', () => {
    cleanup();
    if (child.exitCode === null) child.kill();
  });
}
