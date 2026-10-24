import { spawn, type ChildProcess } from 'node:child_process';

/** The proxy cannot start, died or cannot be reached: the caller falls back to plain kubectl. */
export class ProxyUnavailable extends Error {}

/** The request outlived its timeout; a real error, never a fallback. */
export class ProxyTimeout extends Error {}

/** The cluster answered with an HTTP error; a real error, never a fallback. */
export class ProxyHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const START_TIMEOUT_MS = 10_000;
const IDLE_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

/** The port of kubectl's `Starting to serve on 127.0.0.1:PORT` line, or undefined. */
export function parseProxyPort(out: string): number | undefined {
  const m = /Starting to serve on (?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\s/.exec(out);
  return m ? Number(m[1]) : undefined;
}

const REASONS: Record<number, string> = {
  400: 'BadRequest',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'NotFound',
  408: 'Timeout',
  429: 'TooManyRequests',
  500: 'InternalError',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

/** An error message in kubectl's wording, so `classifyStderr` maps it like a kubectl failure. */
export function httpErrorMessage(status: number, body: string): string {
  let reason: unknown;
  let message: unknown;
  try {
    ({ reason, message } = JSON.parse(body) as { reason?: unknown; message?: unknown });
  } catch {
    // A non-JSON body is used as is.
  }
  const label = typeof reason === 'string' && reason ? reason : (REASONS[status] ?? String(status));
  const detail = typeof message === 'string' && message ? message : body.trim().slice(0, 300);
  return `Error from server (${label}): ${detail || label}`;
}

interface Entry {
  child: ChildProcess;
  base: Promise<string>;
  timer?: ReturnType<typeof setTimeout>;
  dropped?: boolean;
}

function spawnProxy(context: string): ChildProcess {
  // `--context=` keeps a context name from being read as an option; the address is loopback only.
  return spawn('kubectl', [`--context=${context}`, 'proxy', '--port=0', '--address=127.0.0.1'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    env: process.env,
  });
}

function readPort(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => fail(new ProxyUnavailable('kubectl proxy did not start in time.')), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('error', onError);
      child.off('close', onClose);
    };
    const fail = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onData = (chunk: Buffer) => {
      seen += chunk.toString('utf8');
      const port = parseProxyPort(seen);
      if (port !== undefined) {
        cleanup();
        resolve(port);
      }
    };
    const onError = (e: Error) => fail(new ProxyUnavailable(String(e.message ?? e)));
    const onClose = () => fail(new ProxyUnavailable('kubectl proxy exited before it started.'));
    child.stdout?.on('data', onData);
    child.once('error', onError);
    child.once('close', onClose);
  });
}

/** One `kubectl proxy` child per context, started on first use, restarted after it dies, stopped when idle or on exit. */
export class KubeProxy {
  private readonly entries = new Map<string, Entry>();

  private drop(context: string, entry: Entry): void {
    if (entry.dropped) return;
    entry.dropped = true;
    if (this.entries.get(context) === entry) this.entries.delete(context);
    clearTimeout(entry.timer);
    try {
      entry.child.kill();
    } catch {
      // Already gone.
    }
  }

  private touch(context: string, entry: Entry): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.drop(context, entry), IDLE_MS);
    entry.timer.unref();
  }

  /** The base URL of the context's proxy; concurrent callers share one start. */
  private acquire(context: string): Entry {
    let entry = this.entries.get(context);
    if (!entry) {
      const child = spawnProxy(context);
      const created: Entry = {
        child,
        base: readPort(child, START_TIMEOUT_MS).then((port) => `http://127.0.0.1:${port}`),
      };
      entry = created;
      this.entries.set(context, created);
      created.base.catch(() => this.drop(context, created));
      child.once('close', () => this.drop(context, created));
      child.once('error', () => this.drop(context, created));
    }
    this.touch(context, entry);
    return entry;
  }

  /** GETs `path` through the context's proxy and parses the JSON. Throws `ProxyUnavailable` on a connection problem, `ProxyHttpError` on an API error. */
  async apiGet(context: string, path: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const entry = this.acquire(context);
    const timeout = AbortSignal.timeout(timeoutMs);
    let status: number;
    let body: string;
    try {
      const res = await fetch((await entry.base) + path, { signal: timeout, headers: { accept: 'application/json' } });
      status = res.status;
      body = await res.text();
    } catch (err) {
      if (timeout.aborted) throw new ProxyTimeout('The cluster did not answer: the request timed out.');
      throw err instanceof ProxyUnavailable ? err : new ProxyUnavailable(String((err as Error)?.message ?? err));
    }
    this.touch(context, entry);
    if (status < 200 || status >= 300) throw new ProxyHttpError(status, httpErrorMessage(status, body));
    try {
      return JSON.parse(body);
    } catch {
      throw new ProxyUnavailable('The cluster returned an invalid response.');
    }
  }

  /** Stops every child. */
  close(): void {
    for (const [context, entry] of [...this.entries]) this.drop(context, entry);
  }
}

export const kubeProxy = new KubeProxy();

process.on('exit', () => kubeProxy.close());
