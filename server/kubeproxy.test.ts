import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import {
  checkStatus,
  httpErrorMessage,
  kubeconfigSignature,
  KubeProxy,
  kubeProxy,
  parseProxyPort,
  proxyArgs,
  ProxyHttpError,
  ProxyUnavailable,
} from './kubeproxy.js';
import { AppError, classifyStderr } from './errors.js';
import { kubectlGet } from './kube.js';

test('parseProxyPort reads the port from the startup line', () => {
  assert.equal(parseProxyPort('Starting to serve on 127.0.0.1:54321\n'), 54321);
  assert.equal(parseProxyPort('Starting to serve on [::1]:8001\r\n'), 8001);
});

test('parseProxyPort waits for the complete line', () => {
  assert.equal(parseProxyPort('Starting to serve on 127.0.0.1:54'), undefined);
  assert.equal(parseProxyPort(''), undefined);
});

test('httpErrorMessage uses the status reason and message of the API body', () => {
  const body = JSON.stringify({ reason: 'Forbidden', message: 'pods is forbidden: User "u" cannot list resource "pods"' });
  assert.equal(httpErrorMessage(403, body), 'Error from server (Forbidden): pods is forbidden: User "u" cannot list resource "pods"');
});

test('httpErrorMessage falls back to the status name and a non-JSON body', () => {
  assert.equal(httpErrorMessage(503, 'unavailable'), 'Error from server (Service Unavailable): unavailable');
  assert.equal(httpErrorMessage(404, ''), 'Error from server (NotFound): NotFound');
  assert.equal(httpErrorMessage(418, ''), 'Error from server (418): 418');
});

test('proxy error messages are classified like kubectl failures', () => {
  const forbidden = httpErrorMessage(403, JSON.stringify({ reason: 'Forbidden', message: 'denied' }));
  assert.equal(classifyStderr(forbidden, 'cmd').kind, 'forbidden');
  assert.equal(classifyStderr(httpErrorMessage(401, JSON.stringify({ reason: 'Unauthorized' })), 'cmd').kind, 'auth');
  assert.equal(classifyStderr(httpErrorMessage(404, JSON.stringify({ reason: 'NotFound', message: 'x' })), 'cmd').kind, 'notfound');
});

test('the proxy rejects write methods', () => {
  const args = proxyArgs('ctx');
  assert.ok(args.includes('--reject-methods=POST,PUT,PATCH,DELETE'));
  assert.equal(args[0], '--context=ctx');
});

test('checkStatus accepts 2xx and treats gateway errors as an unavailable proxy', () => {
  assert.doesNotThrow(() => checkStatus(200, '{}'));
  for (const status of [502, 503, 504]) assert.throws(() => checkStatus(status, 'bad gateway'), ProxyUnavailable);
});

test('checkStatus keeps API errors, including an expired token, as HTTP errors', () => {
  const body = JSON.stringify({ reason: 'Unauthorized', message: 'token expired' });
  assert.throws(() => checkStatus(401, body), (e: unknown) => e instanceof ProxyHttpError && e.status === 401);
  const err = classifyStderr(httpErrorMessage(401, body), 'cmd');
  assert.equal(err.kind, 'auth');
  assert.throws(() => checkStatus(500, ''), ProxyHttpError);
});

type FakeChild = ChildProcess & { killed: boolean };

function fakeProxy(server: Server): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough() as any;
  child.stderr = new PassThrough() as any;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit('close', 0);
    return true;
  };
  const { port } = server.address() as AddressInfo;
  setImmediate(() => (child.stdout as unknown as PassThrough).write(`Starting to serve on 127.0.0.1:${port}\n`));
  return child;
}

async function withServer(handler: (req: IncomingMessage, res: ServerResponse) => void, run: (server: Server, children: FakeChild[]) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(server, []);
  } finally {
    server.close();
  }
}

test('KubeProxy starts one child per context and reuses it', async () => {
  await withServer(
    (_req, res) => res.end('{"items":[]}'),
    async (server, children) => {
      const proxy = new KubeProxy(() => {
        const child = fakeProxy(server);
        children.push(child);
        return child;
      }, () => 'sig');
      assert.deepEqual(await proxy.apiGet('a', '/api/v1/pods'), { items: [] });
      await proxy.apiGet('a', '/api/v1/pods');
      assert.equal(children.length, 1);
      await proxy.apiGet('b', '/api/v1/pods');
      assert.equal(children.length, 2);
      proxy.close();
      assert.ok(children.every((c) => c.killed));
    },
  );
});

test('KubeProxy restarts the child when the kubeconfig changed', async () => {
  await withServer(
    (_req, res) => res.end('{}'),
    async (server, children) => {
      let sig = 'one';
      const proxy = new KubeProxy(() => {
        const child = fakeProxy(server);
        children.push(child);
        return child;
      }, () => sig);
      await proxy.apiGet('a', '/x');
      sig = 'two';
      await proxy.apiGet('a', '/x');
      assert.equal(children.length, 2);
      assert.equal(children[0].killed, true);
      proxy.close();
    },
  );
});

test('KubeProxy restarts a child that died', async () => {
  await withServer(
    (_req, res) => res.end('{}'),
    async (server, children) => {
      const proxy = new KubeProxy(() => {
        const child = fakeProxy(server);
        children.push(child);
        return child;
      }, () => 'sig');
      await proxy.apiGet('a', '/x');
      children[0].kill();
      await proxy.apiGet('a', '/x');
      assert.equal(children.length, 2);
      proxy.close();
    },
  );
});

test('KubeProxy keeps API errors and gateway errors apart', async () => {
  await withServer(
    (req, res) => {
      res.statusCode = req.url === '/bad' ? 502 : 403;
      res.end(JSON.stringify({ reason: 'Forbidden', message: 'denied' }));
    },
    async (server) => {
      const proxy = new KubeProxy(() => fakeProxy(server), () => 'sig');
      await assert.rejects(proxy.apiGet('a', '/x'), ProxyHttpError);
      await assert.rejects(proxy.apiGet('a', '/bad'), ProxyUnavailable);
      proxy.close();
    },
  );
});

test('KubeProxy fails with ProxyUnavailable when the child exits before it started', async () => {
  const proxy = new KubeProxy(() => {
    const child = new EventEmitter() as ChildProcess;
    child.stdout = new PassThrough() as any;
    child.stderr = new PassThrough() as any;
    child.kill = () => true;
    setImmediate(() => child.emit('close', 1));
    return child;
  }, () => 'sig');
  await assert.rejects(proxy.apiGet('a', '/x'), ProxyUnavailable);
});

test('kubeconfigSignature changes with the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kd-cfg-'));
  const file = join(dir, 'config');
  const saved = process.env.KUBECONFIG;
  process.env.KUBECONFIG = file;
  try {
    const missing = kubeconfigSignature();
    writeFileSync(file, 'a');
    const first = kubeconfigSignature();
    writeFileSync(file, 'abc');
    assert.notEqual(missing, first);
    assert.notEqual(first, kubeconfigSignature());
  } finally {
    if (saved === undefined) delete process.env.KUBECONFIG;
    else process.env.KUBECONFIG = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kubectlGet falls back to kubectl when the proxy cannot start', async () => {
  const saved = process.env.PATH;
  const dir = mkdtempSync(join(tmpdir(), 'kd-empty-'));
  process.env.PATH = dir;
  try {
    await assert.rejects(kubectlGet('no-such-ctx', '/api/v1/pods', { timeoutMs: 5000 }), (e: unknown) => e instanceof AppError);
  } finally {
    process.env.PATH = saved;
    kubeProxy.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
