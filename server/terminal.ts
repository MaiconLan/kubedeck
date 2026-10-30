import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { demoEnabled } from './demo.js';
import { AppError, invalid } from './errors.js';
import { checkName, formatCommand, recordCommand } from './kube.js';
import { checkContext, listContexts } from './resources.js';
import { isProtected } from './settings.js';
import { prepareCommand, type Scope, type TermBin } from './termargs.js';
import type { WsConnection } from './ws.js';

/**
 * Built-in terminal: a shell on this machine (or `kubectl exec` into a pod) streamed over a WebSocket.
 * With node-pty (optional dependency) it is a real terminal; without it, a plain pipe ("simple mode").
 *
 * In the shell, `kubectl` and `helm` resolve first to small scripts of ours. They ask this server how to
 * run each command: the tab's context and namespace are added, commands that change a protected context
 * wait for a confirmation in the UI, and every command lands in the command log.
 */

const MAX_SESSIONS = 32;
const CONFIRM_TIMEOUT_MS = 5 * 60_000;

// ---- process: PTY or pipe

interface Proc {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

interface PtyModule {
  spawn(file: string, args: string[], opts: { name?: string; cols?: number; rows?: number; cwd?: string; env?: Record<string, string> }): {
    onData(fn: (d: string) => void): void;
    onExit(fn: (e: { exitCode: number }) => void): void;
    write(d: string): void;
    resize(c: number, r: number): void;
    kill(): void;
  };
}

let ptyModule: PtyModule | null | undefined;

/** node-pty when it is installed and loads (a native module: it may be missing on some platforms). */
function loadPty(): PtyModule | null {
  if (ptyModule === undefined) {
    if (process.env.KUBEDECK_NO_PTY === '1') {
      ptyModule = null;
    } else {
      try {
        ptyModule = createRequire(import.meta.url)('node-pty') as PtyModule;
      } catch {
        ptyModule = null;
      }
    }
  }
  return ptyModule;
}

function startProc(
  file: string, args: string[], env: Record<string, string>, size: { cols: number; rows: number },
  onData: (d: string) => void, onExit: (code: number) => void,
): { proc: Proc; pty: boolean } {
  const pty = loadPty();
  if (pty) {
    const p = pty.spawn(resolveForPty(file, env), args, { name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd: homedir(), env });
    p.onData(onData);
    p.onExit((e) => onExit(e.exitCode));
    return {
      pty: true,
      proc: {
        write: (d) => p.write(d),
        resize: (c, r) => { try { p.resize(c, r); } catch { /* exited */ } },
        kill: () => { try { p.kill(); } catch { /* exited */ } },
      },
    };
  }
  const child: ChildProcess = spawn(file, args, { cwd: homedir(), env, windowsHide: true });
  // Without a terminal, programs print bare "\n"; the terminal UI needs "\r\n".
  const out = (b: Buffer) => onData(b.toString('utf8').replace(/\r?\n/g, '\r\n'));
  child.stdout!.on('data', out);
  child.stderr!.on('data', out);
  child.on('error', (e) => {
    onData(`\r\n${String(e.message)}\r\n`);
    onExit(127);
  });
  child.on('close', (code) => onExit(code ?? 1));
  return {
    pty: false,
    proc: {
      write: (d) => { if (child.stdin?.writable) child.stdin.write(d); },
      resize: () => {},
      kill: () => child.kill(),
    },
  };
}

// ---- environment and shims

/** The PATH key of an env object (Windows spells it "Path"). */
function pathKey(env: Record<string, string | undefined>): string {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
}

/** On Windows node-pty needs the real file name: "kubectl" becomes "C:\...\kubectl.exe". */
function resolveForPty(file: string, env: Record<string, string>): string {
  if (process.platform !== 'win32' || /[\\/]/.test(file)) return file;
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const names = /\.[^.]+$/.test(file) ? [file] : exts.map((e) => file + e.toLowerCase());
  for (const dir of (env[pathKey(env)] ?? '').split(delimiter).filter(Boolean)) {
    for (const n of names) if (existsSync(join(dir, n))) return join(dir, n);
  }
  return file;
}

function onPath(file: string): boolean {
  const dirs = (process.env[pathKey(process.env)] ?? '').split(delimiter).filter(Boolean);
  return dirs.some((d) => existsSync(join(d, file)));
}

function pickShell(pty: boolean): { file: string; args: string[] } {
  const custom = process.env.KUBEDECK_SHELL;
  if (process.platform === 'win32') {
    if (custom) return { file: custom, args: [] };
    // Without a terminal PowerShell shows no prompt; cmd.exe does.
    if (!pty) return { file: 'cmd.exe', args: [] };
    return { file: onPath('pwsh.exe') ? 'pwsh.exe' : 'powershell.exe', args: ['-NoLogo'] };
  }
  const file = custom || process.env.SHELL || (existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');
  return { file, args: pty ? [] : ['-i'] };
}

const SHIM_SCRIPT = String.raw`'use strict';
// Written by KubeDeck: runs kubectl/helm the way the KubeDeck terminal asks (context, namespace, confirmation).
const http = require('node:http');
const { spawn } = require('node:child_process');
const [bin, ...args] = process.argv.slice(2);
const env = process.env;
function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: Number(env.KUBEDECK_SHIM_PORT), path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-kubedeck-shim': env.KUBEDECK_SHIM_KEY || '' },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text || '{}') }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(data);
  });
}
// Ctrl+C reaches kubectl too; this script waits for it and reports how it ended.
process.on('SIGINT', () => {});
(async () => {
  const session = env.KUBEDECK_SESSION;
  let plan;
  try {
    plan = await post('/api/terminal/shim', { session, bin, args });
  } catch (e) {
    process.stderr.write('kubedeck: KubeDeck is not reachable (' + e.message + ')\n');
    process.exit(1);
  }
  if (plan.status !== 200 || !plan.body.allow) {
    process.stderr.write('kubedeck: ' + (plan.body.message || 'command refused') + '\n');
    process.exit(1);
  }
  const childEnv = Object.assign({}, env);
  for (const k of Object.keys(childEnv)) if (k.toUpperCase() === 'PATH') delete childEnv[k];
  childEnv.PATH = env.KUBEDECK_REAL_PATH || '';
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const done = (code) => post('/api/terminal/shim/done', { session, id: plan.body.id, code }).catch(() => {});
  const child = spawn(bin, plan.body.args, { stdio: 'inherit', env: childEnv });
  child.on('error', async (e) => {
    process.stderr.write('kubedeck: ' + bin + ': ' + e.message + '\n');
    await done(127);
    process.exit(127);
  });
  child.on('exit', async (code) => {
    await done(code === null ? 1 : code);
    process.exit(code === null ? 1 : code);
  });
})();
`;

let shimDir: string | undefined;

/** Folder with the kubectl/helm scripts, put first in the shell's PATH. */
function ensureShims(): string {
  if (shimDir && existsSync(shimDir)) return shimDir;
  const dir = mkdtempSync(join(tmpdir(), 'kubedeck-term-'));
  const script = join(dir, 'shim.cjs');
  writeFileSync(script, SHIM_SCRIPT);
  // Inside Electron, execPath is the app; ELECTRON_RUN_AS_NODE makes it behave as plain Node.
  const node = process.execPath;
  for (const bin of ['kubectl', 'helm'] as const) {
    if (process.platform === 'win32') {
      writeFileSync(join(dir, `${bin}.cmd`), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${node}" "${script}" ${bin} %*\r\n`);
    } else {
      const file = join(dir, bin);
      writeFileSync(file, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${node}" "${script}" ${bin} "$@"\n`);
      chmodSync(file, 0o755);
    }
  }
  shimDir = dir;
  return dir;
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

// ---- sessions

interface Session {
  id: string;
  key: Buffer;
  scope: Scope;
  conn: WsConnection;
  proc?: Proc;
  confirms: Map<string, (ok: boolean) => void>;
  running: Map<string, { command: string; write: boolean; started: number }>;
}

const sessions = new Map<string, Session>();

export interface StartMessage {
  type: 'start';
  mode: 'shell' | 'exec';
  ctx: string;
  ns: string;
  pod?: string;
  container?: string;
  cols?: number;
  rows?: number;
}

function sizeOf(m: { cols?: number; rows?: number }) {
  const clamp = (n: unknown, d: number) => (Number.isInteger(n) && (n as number) > 1 && (n as number) < 1000 ? (n as number) : d);
  return { cols: clamp(m.cols, 80), rows: clamp(m.rows, 24) };
}

function errorJson(err: unknown) {
  return err instanceof AppError ? err.toJSON() : new AppError('command', 'raw', String((err as Error)?.message ?? err)).toJSON();
}

/** Asks the UI of this session to confirm a command on a protected context. */
function ask(s: Session, command: string, ctx: string): Promise<boolean> {
  if (s.conn.closed) return Promise.resolve(false);
  const id = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), CONFIRM_TIMEOUT_MS);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      s.confirms.delete(id);
      resolve(ok);
    };
    s.confirms.set(id, finish);
    s.conn.send(JSON.stringify({ type: 'confirm', id, command, ctx }));
  });
}

/** Runs one terminal over an accepted WebSocket. `port` is where the shims reach this server. */
export function handleTerminal(conn: WsConnection, port: number) {
  if (sessions.size >= MAX_SESSIONS) {
    conn.send(JSON.stringify({ type: 'error', error: invalid('tooManyTerminals', 'Too many terminals are open.').toJSON() }));
    conn.close();
    return;
  }
  const s: Session = {
    id: randomUUID(),
    key: randomBytes(24),
    scope: { ctx: '', ns: '*' },
    conn,
    confirms: new Map(),
    running: new Map(),
  };
  sessions.set(s.id, s);
  let started = false;

  conn.onClose(() => {
    sessions.delete(s.id);
    s.proc?.kill();
    for (const finish of [...s.confirms.values()]) finish(false);
  });

  conn.onMessage(async (text) => {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg?.type === 'input' && typeof msg.data === 'string') {
      s.proc?.write(msg.data);
    } else if (msg?.type === 'resize') {
      const { cols, rows } = sizeOf(msg);
      s.proc?.resize(cols, rows);
    } else if (msg?.type === 'confirm' && typeof msg.id === 'string') {
      s.confirms.get(msg.id)?.(msg.ok === true);
    } else if (msg?.type === 'scope') {
      try {
        s.scope = { ctx: await checkContext(msg.ctx), ns: typeof msg.ns === 'string' && msg.ns ? msg.ns : '*' };
      } catch {
        // Unknown context: keep the previous one.
      }
    } else if (msg?.type === 'start' && !started) {
      started = true;
      try {
        await start(s, msg as StartMessage, port);
      } catch (err) {
        conn.send(JSON.stringify({ type: 'error', error: errorJson(err) }));
        conn.close();
      }
    }
  });
}

async function start(s: Session, msg: StartMessage, port: number) {
  if (demoEnabled()) throw invalid('terminalDemo', 'The terminal is not available in demo mode.');
  const ctx = await checkContext(msg.ctx);
  const ns = typeof msg.ns === 'string' && msg.ns ? msg.ns : '*';
  s.scope = { ctx, ns };
  const size = sizeOf(msg);
  const pty = !!loadPty();

  // Output is coalesced a little: a PTY often emits many tiny chunks.
  let pending = '';
  let flushing = false;
  const onData = (d: string) => {
    pending += d;
    if (flushing) return;
    flushing = true;
    setTimeout(() => {
      flushing = false;
      const data = pending;
      pending = '';
      s.conn.send(JSON.stringify({ type: 'output', data }));
    }, 8);
  };

  let file: string;
  let args: string[];
  let env = baseEnv();
  let logged: { command: string; started: number } | undefined;

  if (msg.mode === 'exec') {
    const podNs = checkName(msg.ns, 'namespace');
    const pod = checkName(msg.pod, 'name');
    const container = msg.container ? checkName(msg.container, 'container') : undefined;
    const run = pty
      ? 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'
      : 'command -v bash >/dev/null 2>&1 && exec bash -i || exec sh -i';
    file = 'kubectl';
    args = ['--context', ctx, 'exec', pty ? '-it' : '-i', '-n', podNs, pod, ...(container ? ['-c', container] : []), '--', 'sh', '-c', run];
    const command = formatCommand(file, args);
    // A shell in a pod can change anything in it: on a protected context, confirm first.
    if ((await isProtected(ctx)) && !(await ask(s, command, ctx))) {
      recordCommand(command, true, false, Date.now());
      throw new AppError('protected', 'terminalRefused', 'Not confirmed: the command did not run.', { command });
    }
    logged = { command, started: Date.now() };
  } else {
    ({ file, args } = pickShell(pty));
    const dir = ensureShims();
    const key = pathKey(env);
    const realPath = env[key] ?? '';
    delete env[key];
    env = {
      ...env,
      PATH: `${dir}${delimiter}${realPath}`,
      KUBEDECK_REAL_PATH: realPath,
      KUBEDECK_SHIM_PORT: String(port),
      KUBEDECK_SHIM_KEY: s.key.toString('hex'),
      KUBEDECK_SESSION: s.id,
    };
  }

  if (s.conn.closed) return;
  const { proc } = startProc(file, args, env, size, onData, (code) => {
    if (logged) recordCommand(logged.command, true, code === 0, logged.started);
    // Sends what is still buffered before the exit notice.
    setTimeout(() => {
      s.conn.send(JSON.stringify({ type: 'exit', code }));
      s.proc = undefined;
    }, 20);
  });
  s.proc = proc;
  s.conn.send(JSON.stringify({ type: 'ready', pty, shell: msg.mode === 'exec' ? logged!.command : [file, ...args].join(' ') }));
}

// ---- shim endpoints (authorized by the session key, not the UI token)

function sessionFor(req: IncomingMessage, id: unknown): Session | undefined {
  const s = typeof id === 'string' ? sessions.get(id) : undefined;
  const given = Buffer.from(String(req.headers['x-kubedeck-shim'] ?? ''), 'hex');
  return s && given.length === s.key.length && timingSafeEqual(given, s.key) ? s : undefined;
}

export async function handleShim(req: IncomingMessage, res: ServerResponse, path: string, body: any) {
  const send = (status: number, data: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };
  const s = sessionFor(req, body?.session);
  if (!s) {
    send(403, { allow: false, message: 'this terminal session has ended' });
    return;
  }

  if (path === '/api/terminal/shim/done') {
    const run = s.running.get(String(body.id));
    if (run) {
      s.running.delete(String(body.id));
      recordCommand(run.command, run.write, body.code === 0, run.started);
    }
    send(200, {});
    return;
  }

  const bin: TermBin | undefined = body.bin === 'kubectl' || body.bin === 'helm' ? body.bin : undefined;
  const args = Array.isArray(body.args) && body.args.every((a: unknown) => typeof a === 'string') ? (body.args as string[]) : undefined;
  if (!bin || !args) {
    send(400, { allow: false, message: 'invalid command' });
    return;
  }
  const plan = prepareCommand(bin, args, s.scope);
  const command = formatCommand(bin, plan.args);
  let target = plan.ctx;
  if (!target && plan.write) {
    try {
      target = (await listContexts()).current;
    } catch {
      // No kubeconfig: kubectl reports it.
    }
  }
  if (plan.write && target && (await isProtected(target)) && !(await ask(s, command, target))) {
    recordCommand(command, true, false, Date.now());
    send(200, { allow: false, message: `not confirmed on protected context "${target}"; the command did not run` });
    return;
  }
  const id = randomUUID();
  s.running.set(id, { command, write: plan.write, started: Date.now() });
  send(200, { allow: true, id, args: plan.args });
}

/** Ends every terminal (server shutdown) and removes the shim folder. */
export function stopAllTerminals() {
  for (const s of sessions.values()) {
    s.proc?.kill();
    s.conn.close(1001);
  }
  sessions.clear();
  if (shimDir) {
    try { rmSync(shimDir, { recursive: true, force: true }); } catch { /* best effort */ }
    shimDir = undefined;
  }
}
