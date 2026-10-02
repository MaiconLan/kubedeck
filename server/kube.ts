import { spawn, type ChildProcess } from 'node:child_process';
import { demoEnabled, demoRun, demoSpawn } from './demo.js';
import { AppError, classifyStderr, invalid } from './errors.js';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface CommandEntry {
  id: number;
  at: string;
  command: string;
  write: boolean;
  ok: boolean;
  ms: number;
}

const history: CommandEntry[] = [];
let nextId = 1;

export function commandHistory(): CommandEntry[] {
  return history.slice().reverse();
}

function record(command: string, write: boolean, ok: boolean, started: number) {
  history.push({ id: nextId++, at: new Date().toISOString(), command, write, ok, ms: Date.now() - started });
  if (history.length > 400) history.splice(0, history.length - 400);
}

/** Human-readable command line, quoted for copy/paste into a terminal. */
export function formatCommand(bin: string, args: string[]): string {
  return [bin, ...args]
    .map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(' ');
}

export interface RunOptions {
  timeoutMs?: number;
  write?: boolean;
  /** Accept stdout even when the exit code is non-zero (e.g. partial api-resources). */
  allowPartial?: boolean;
}

export type Bin = 'kubectl' | 'helm' | 'az' | 'kubelogin';

/**
 * On Windows the Azure CLI is a batch file (az.cmd), which Node can only start
 * through cmd.exe. Arguments are then quoted by us, and anything cmd could
 * interpret inside double quotes is rejected up front.
 */
function spawnBin(bin: Bin, args: string[]): ChildProcess {
  if (bin === 'az' && process.platform === 'win32') {
    const quoted = args.map((a) => {
      if (/["%^!\r\n]/.test(a)) throw invalid('invalidChars', 'Value contains characters that are not allowed.');
      return /^[\w@+=:,./-]+$/.test(a) ? a : `"${a}"`;
    });
    return spawn(['az', ...quoted].join(' '), { windowsHide: true, env: process.env, shell: true });
  }
  return spawn(bin, args, { windowsHide: true, env: process.env });
}

export function run(bin: Bin, args: string[], opts: RunOptions = {}): Promise<string> {
  const command = formatCommand(bin, args);
  const started = Date.now();
  if (demoEnabled()) {
    return demoRun(bin, args, command).then(
      (out) => {
        record(command, !!opts.write, true, started);
        return out;
      },
      (e) => {
        record(command, !!opts.write, false, started);
        throw e;
      },
    );
  }
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnBin(bin, args);
    } catch (err) {
      if (err instanceof AppError) {
        reject(err);
        return;
      }
      reject(missingBinary(bin, command, err));
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout!.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) child.kill();
      else out.push(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => err.push(chunk));

    child.on('error', (e) => {
      clearTimeout(timer);
      record(command, !!opts.write, false, started);
      reject(missingBinary(bin, command, e));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      const ok = code === 0 || (!!opts.allowPartial && stdout.trim().length > 0);
      record(command, !!opts.write, ok && !timedOut, started);
      if (timedOut) {
        reject(new AppError('timeout', 'timeout', 'The cluster took too long to respond.', { detail: stderr, command }));
      } else if (ok) {
        resolve(stdout);
      } else {
        reject(classifyStderr(stderr || stdout, command));
      }
    });
  });
}

function missingBinary(bin: string, command: string, err: unknown): AppError {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') {
    return new AppError('missing-binary', 'missingBinary', `"${bin}" was not found in PATH.`, { detail: String(err), command, params: { bin } });
  }
  return new AppError('command', 'spawnFailed', `Failed to run ${bin}.`, { detail: String(err), command, params: { bin } });
}

export function kubectl(ctx: string, args: string[], opts?: RunOptions): Promise<string> {
  return run('kubectl', ['--context', ctx, ...args], opts);
}

export async function kubectlJson<T = any>(ctx: string, args: string[], opts?: RunOptions): Promise<T> {
  const text = await kubectl(ctx, [...args, '-o', 'json'], opts);
  return JSON.parse(text) as T;
}

export function helm(ctx: string, args: string[], opts?: RunOptions): Promise<string> {
  return run('helm', [...args, '--kube-context', ctx], opts);
}

/** Long-running process (logs -f). Caller owns its lifecycle. */
export function spawnKubectl(ctx: string, args: string[]): { child: ChildProcess; command: string } {
  const full = ['--context', ctx, ...args];
  const command = formatCommand('kubectl', full);
  record(command, false, true, Date.now());
  const child = demoEnabled() ? demoSpawn(full) : spawn('kubectl', full, { windowsHide: true, env: process.env });
  return { child, command };
}

// ---- input validation -------------------------------------------------------

const NAME_RE = /^[a-z0-9]([-a-z0-9._:]*[a-z0-9])?$/i;
const TYPE_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/i;

export function checkName(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 253 || !NAME_RE.test(value)) {
    throw invalid('invalidField', `Invalid value for ${field}.`, { field });
  }
  return value;
}

export function checkType(value: unknown): string {
  if (typeof value !== 'string' || value.length > 253 || !TYPE_RE.test(value)) {
    throw invalid('invalidType', 'Invalid resource type.');
  }
  return value;
}

/** Namespace args: empty/"*" means all namespaces. */
export function nsArgs(ns: string | undefined | null): string[] {
  if (!ns || ns === '*') return ['--all-namespaces'];
  return ['-n', checkName(ns, 'namespace')];
}
