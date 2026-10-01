import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from './http.js';
import { stopAllForwards } from './portforward.js';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const option = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (flag('--help') || flag('-h')) {
  console.log(`kubedeck — local Kubernetes dashboard

Usage: kubedeck [--port 7420] [--no-open]

  --port <n>   fixed port (default: any free port)
  --no-open    do not open the browser automatically
`);
  process.exit(0);
}

const dev = flag('--dev');
const port = Number(option('--port') ?? (dev ? 7420 : 0));
const token = dev ? 'dev' : randomBytes(24).toString('hex');

const server = createApp(token);

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Pass --port with another port.`);
  else console.error(err);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const actual = (server.address() as AddressInfo).port;
  const url = dev ? `http://localhost:5173/?t=${token}` : `http://127.0.0.1:${actual}/?t=${token}`;
  console.log(`\n  KubeDeck running at ${url}\n  Press Ctrl+C to stop.\n`);
  if (!dev && !flag('--no-open')) openBrowser(url);
});

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => { /* no browser launcher available */ });
    child.unref();
  } catch {
    // The URL is printed above; opening the browser is best-effort.
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopAllForwards();
    server.close();
    process.exit(0);
  });
}

// Child kubectl processes must not outlive the server.
process.on('exit', stopAllForwards);
