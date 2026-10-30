/**
 * How the terminal treats a `kubectl` or `helm` command line typed in its shell:
 * which context and namespace to add (those of the tab, unless the command sets its own),
 * and whether it may change the cluster (then a protected context asks for confirmation).
 */

export type TermBin = 'kubectl' | 'helm';

export interface Scope {
  ctx: string;
  /** '*' means all namespaces: nothing is added. */
  ns: string;
}

export interface Prepared {
  args: string[];
  /** Context the command runs against; undefined when it uses the kubeconfig's current context. */
  ctx?: string;
  verb?: string;
  write: boolean;
}

// Global flags that take a value, so the word after them is not the verb.
const KUBECTL_VALUE_FLAGS = new Set([
  '--as', '--as-group', '--as-uid', '--cache-dir', '--certificate-authority', '--client-certificate', '--client-key',
  '--cluster', '--context', '--kubeconfig', '--log-flush-frequency', '-n', '--namespace', '--password', '--profile',
  '--profile-output', '--request-timeout', '-s', '--server', '--tls-server-name', '--token', '--user', '--username',
  '-v', '--v', '--vmodule',
]);
const HELM_VALUE_FLAGS = new Set([
  '--kube-context', '-n', '--namespace', '--kubeconfig', '--kube-apiserver', '--kube-as-user', '--kube-as-group',
  '--kube-ca-file', '--kube-token', '--kube-tls-server-name', '--registry-config', '--repository-cache',
  '--repository-config', '--burst-limit', '--qps', '--content-cache',
]);

const KUBECTL_BUILTIN = new Set([
  'create', 'expose', 'run', 'set', 'explain', 'get', 'edit', 'delete', 'rollout', 'scale', 'autoscale', 'certificate',
  'cluster-info', 'top', 'cordon', 'uncordon', 'drain', 'taint', 'describe', 'logs', 'attach', 'exec', 'port-forward',
  'proxy', 'cp', 'auth', 'debug', 'events', 'diff', 'apply', 'patch', 'replace', 'wait', 'kustomize', 'label',
  'annotate', 'completion', 'alpha', 'api-resources', 'api-versions', 'config', 'plugin', 'version', 'options', 'help',
]);
const KUBECTL_READ = new Set([
  'explain', 'get', 'cluster-info', 'top', 'describe', 'logs', 'events', 'diff', 'wait', 'kustomize', 'completion',
  'api-resources', 'api-versions', 'config', 'plugin', 'version', 'options', 'help', 'port-forward',
]);
/** Local commands: no context or namespace is added. */
const KUBECTL_LOCAL = new Set(['config', 'completion', 'plugin', 'options', 'help', 'kustomize']);

const HELM_READ = new Set([
  'completion', 'create', 'dependency', 'dep', 'env', 'get', 'help', 'history', 'hist', 'lint', 'list', 'ls', 'package',
  'plugin', 'pull', 'push', 'registry', 'repo', 'search', 'show', 'inspect', 'status', 'template', 'verify', 'version',
]);
const HELM_CLUSTER = new Set([
  'get', 'history', 'hist', 'list', 'ls', 'status', 'template', 'install', 'upgrade', 'uninstall', 'delete', 'del', 'un',
  'rollback', 'test',
]);

/** Arguments before `--`; what follows belongs to the command run in the container. */
function own(args: string[]): string[] {
  const i = args.indexOf('--');
  return i < 0 ? args : args.slice(0, i);
}

/** Positional words (not flags or flag values), in order. */
function positionals(args: string[], valueFlags: Set<string>): string[] {
  const words: string[] = [];
  const list = own(args);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith('-')) {
      if (!a.includes('=') && valueFlags.has(a)) i++;
      continue;
    }
    words.push(a);
  }
  return words;
}

/** Value of a flag (`--flag v` or `--flag=v`), if given. */
function flagValue(args: string[], names: string[]): string | undefined {
  const list = own(args);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    for (const n of names) {
      if (a === n) return list[i + 1];
      if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
    }
  }
  return undefined;
}

function hasNamespace(args: string[]): boolean {
  return own(args).some((a) =>
    a === '-A' || a === '--all-namespaces' || a.startsWith('--all-namespaces=')
    || a === '--namespace' || a.startsWith('--namespace=')
    || (a.startsWith('-n') && !a.startsWith('--')));
}

export function prepareCommand(bin: TermBin, args: string[], scope: Scope): Prepared {
  const kube = bin === 'kubectl';
  const valueFlags = kube ? KUBECTL_VALUE_FLAGS : HELM_VALUE_FLAGS;
  const words = positionals(args, valueFlags);
  const verb = words[0];
  const ctxFlag = kube ? '--context' : '--kube-context';
  const given = flagValue(args, [ctxFlag]);

  let write: boolean;
  let inject: boolean;
  if (kube) {
    const builtin = verb !== undefined && KUBECTL_BUILTIN.has(verb);
    // Plugins (kubectl-foo) refuse global flags before their name and may do anything.
    write = verb !== undefined && (!builtin || !KUBECTL_READ.has(verb));
    if (verb === 'rollout' && (words[1] === 'status' || words[1] === 'history')) write = false;
    if (verb === 'auth' && words[1] !== 'reconcile') write = false;
    inject = builtin && !KUBECTL_LOCAL.has(verb!);
  } else {
    write = verb !== undefined && !HELM_READ.has(verb);
    inject = verb !== undefined && HELM_CLUSTER.has(verb);
  }

  // Another kubeconfig has its own contexts: the tab's context means nothing there.
  if (flagValue(args, ['--kubeconfig']) !== undefined) inject = false;

  const extra: string[] = [];
  if (inject && given === undefined && scope.ctx) extra.push(`${ctxFlag}=${scope.ctx}`);
  if (inject && scope.ns && scope.ns !== '*' && !hasNamespace(args)) extra.push(`--namespace=${scope.ns}`);

  const ctx = given ?? (inject ? scope.ctx : undefined);
  return { args: [...extra, ...args], ctx: ctx || undefined, verb, write };
}
