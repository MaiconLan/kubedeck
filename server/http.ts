import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runAction, ALLOWED, type ActionRequest } from './actions.js';
import { addAksCluster, listAksClusters, listSubscriptions, type AddAksRequest } from './azure.js';
import { dashboard } from './dashboard.js';
import { AppError, invalid } from './errors.js';
import { listReleases, releaseDetail, type HelmView } from './helm.js';
import { commandHistory } from './kube.js';
import { streamLogs } from './logs.js';
import { listForwards, startForward, stopForward, type ForwardRequest } from './portforward.js';
import {
  checkContext, decodeSecret, describe, discover, eventsFor, getJson, getYaml,
  listContexts, listNamespaces, listObjects,
} from './resources.js';
import { loadSettings, saveSettings } from './settings.js';

const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const ALLOWED_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

type Query = URLSearchParams;
type Handler = (q: Query, req: IncomingMessage, res: ServerResponse) => Promise<unknown>;

export function createApp(token: string) {
  const tokenBuf = Buffer.from(token);

  const routes: Record<string, Handler> = {
    'GET /api/contexts': async () => listContexts(),
    'GET /api/settings': async () => loadSettings(),
    'PUT /api/settings': async (_q, req) => saveSettings(await readJson(req)),
    'GET /api/commands': async () => commandHistory(),
    'GET /api/actions': async () => ALLOWED,

    'GET /api/namespaces': async (q) => listNamespaces(await ctxOf(q)),
    'GET /api/discovery': async (q) => discover(await ctxOf(q), q.get('fresh') === '1'),
    'GET /api/list': async (q) =>
      listObjects(await ctxOf(q), q.get('type') ?? '', q.get('ns') ?? undefined, {
        labels: q.get('labels') || undefined,
        fields: q.get('fields') || undefined,
      }),
    'GET /api/dashboard': async (q) => dashboard(await ctxOf(q), q.get('ns') ?? undefined),

    'GET /api/forwards': async () => listForwards(),
    'POST /api/forwards': async (_q, req) => {
      const body = (await readJson(req)) as ForwardRequest;
      body.ctx = await checkContext(body.ctx);
      return startForward(body);
    },
    'DELETE /api/forwards': async (q) => stopForward(q.get('id')),
    'GET /api/object': async (q) => {
      const ctx = await ctxOf(q);
      const [type, name, ns] = [q.get('type') ?? '', q.get('name') ?? '', q.get('ns') || undefined];
      return q.get('format') === 'yaml' ? { text: await getYaml(ctx, type, name, ns) } : getJson(ctx, type, name, ns);
    },
    'GET /api/describe': async (q) => ({
      text: await describe(await ctxOf(q), q.get('type') ?? '', q.get('name') ?? '', q.get('ns') || undefined),
    }),
    'GET /api/events': async (q) =>
      eventsFor(await ctxOf(q), q.get('kind') ?? '', q.get('name') ?? '', q.get('ns') || undefined),
    'GET /api/secret': async (q) => decodeSecret(await ctxOf(q), q.get('name') ?? '', q.get('ns') ?? ''),

    'GET /api/helm/releases': async (q) => listReleases(await ctxOf(q), q.get('ns') ?? undefined),
    'GET /api/helm/detail': async (q) => ({
      text: await releaseDetail(await ctxOf(q), q.get('ns') ?? '', q.get('name') ?? '', (q.get('view') ?? 'status') as HelmView),
    }),

    'GET /api/azure/subscriptions': async () => listSubscriptions(),
    'GET /api/azure/clusters': async (q) => listAksClusters(q.get('subscription')),
    'POST /api/azure/add': async (_q, req) => addAksCluster((await readJson(req)) as AddAksRequest),

    'POST /api/action': async (_q, req) => {
      const body = (await readJson(req)) as ActionRequest;
      body.ctx = await checkContext(body.ctx);
      return runAction(body);
    },
  };

  function authorized(req: IncomingMessage, url: URL): boolean {
    const given = Buffer.from(String(req.headers['x-kubedeck-token'] ?? url.searchParams.get('t') ?? ''));
    return given.length === tokenBuf.length && timingSafeEqual(given, tokenBuf);
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Blocks DNS-rebinding: only loopback host names may reach the server.
    if (!ALLOWED_HOST.test(req.headers.host ?? '')) {
      res.writeHead(403).end('Forbidden host');
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      try {
        await serveStatic(url.pathname, res);
      } catch {
        if (!res.headersSent) res.writeHead(400).end();
      }
      return;
    }

    if (!authorized(req, url)) {
      sendJson(res, 401, { kind: 'token', code: 'invalidToken', message: 'Invalid session. Open the address printed in the terminal.' });
      return;
    }

    try {
      if (req.method === 'GET' && url.pathname === '/api/logs') {
        const q = url.searchParams;
        await streamLogs(req, res, {
          ctx: await ctxOf(q),
          ns: q.get('ns') ?? '',
          type: q.get('type') ?? 'pods',
          name: q.get('name') ?? '',
          container: q.get('container') || undefined,
          tail: Number(q.get('tail') ?? 500) || 500,
          previous: q.get('previous') === '1',
          timestamps: q.get('timestamps') === '1',
          follow: q.get('follow') !== '0',
        });
        return;
      }

      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) {
        sendJson(res, 404, { kind: 'notfound', code: 'routeNotFound', message: 'Route not found.' });
        return;
      }
      sendJson(res, 200, await handler(url.searchParams, req, res));
    } catch (err) {
      const e = err instanceof AppError ? err : new AppError('command', 'raw', String((err as Error)?.message ?? err));
      if (!res.headersSent) sendJson(res, e.status, e.toJSON());
      else res.end();
    }
  });
}

function ctxOf(q: Query): Promise<string> {
  return checkContext(q.get('ctx'));
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw invalid('bodyTooLarge', 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw invalid('invalidJson', 'Invalid JSON.');
  }
}

async function serveStatic(pathname: string, res: ServerResponse) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([\\/])+/, '');
  let file = join(WEB_ROOT, rel);
  if (!file.startsWith(WEB_ROOT.endsWith(sep) ? WEB_ROOT : WEB_ROOT + sep) && file !== WEB_ROOT) {
    res.writeHead(403).end();
    return;
  }
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(WEB_ROOT, 'index.html'); // SPA fallback
  }
  try {
    await stat(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('UI not found. Run "npm run build" before starting kubedeck.');
    return;
  }
  const immutable = file.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}
