import { AppError, invalid } from './errors.js';
import { checkName, formatCommand, run } from './kube.js';

const AZ_TIMEOUT_MS = 120_000;

const SUBSCRIPTION_RE = /^[\w .()-]{1,128}$/;
const GROUP_RE = /^[\w.()-]{1,90}$/;
const CLUSTER_RE = /^[\w-]{1,63}$/;
const CONTEXT_RE = /^[\w.@:-]{1,100}$/;

function check(value: unknown, re: RegExp, field: string): string {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!re.test(v)) throw invalid('invalidField', `Invalid value for ${field}.`, { field });
  return v;
}

export async function listSubscriptions() {
  const out = await run('az', ['account', 'list', '--all', '-o', 'json'], { timeoutMs: AZ_TIMEOUT_MS });
  return (JSON.parse(out || '[]') as any[])
    .map((s) => ({ id: s.id, name: s.name, tenantId: s.tenantId, isDefault: !!s.isDefault, state: s.state }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listAksClusters(subscription: unknown) {
  const sub = check(subscription, SUBSCRIPTION_RE, 'account');
  const out = await run('az', ['aks', 'list', '--subscription', sub, '-o', 'json'], { timeoutMs: AZ_TIMEOUT_MS });
  return (JSON.parse(out || '[]') as any[])
    .map((c) => ({
      name: c.name,
      resourceGroup: c.resourceGroup,
      location: c.location,
      kubernetesVersion: c.currentKubernetesVersion ?? c.kubernetesVersion,
      powerState: c.powerState?.code ?? '',
      aad: !!c.aadProfile,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface AddAksRequest {
  subscription: string;
  resourceGroup: string;
  cluster: string;
  contextName?: string;
  namespace?: string;
  /** Rewrites the AAD user entry to use the az login token (kubelogin -l azurecli). */
  kubelogin?: boolean;
  dryRun?: boolean;
}

export type StepId = 'selectAccount' | 'getCredentials' | 'kubelogin' | 'setNamespace';

interface Step {
  id: StepId;
  bin: 'az' | 'kubectl' | 'kubelogin';
  args: string[];
  /** Failure is reported but does not abort the flow. */
  optional?: boolean;
}

function plan(req: AddAksRequest): { context: string; steps: Step[] } {
  const subscription = check(req.subscription, SUBSCRIPTION_RE, 'account');
  const group = check(req.resourceGroup, GROUP_RE, 'resourceGroup');
  const cluster = check(req.cluster, CLUSTER_RE, 'cluster');
  const context = req.contextName?.trim() ? check(req.contextName, CONTEXT_RE, 'context') : cluster;
  const namespace = req.namespace?.trim() ? checkName(req.namespace.trim(), 'namespace') : '';

  const steps: Step[] = [
    { id: 'selectAccount', bin: 'az', args: ['account', 'set', '--subscription', subscription] },
    {
      id: 'getCredentials',
      bin: 'az',
      args: ['aks', 'get-credentials', '--resource-group', group, '--name', cluster, '--context', context, '--overwrite-existing'],
    },
  ];
  if (req.kubelogin) {
    steps.push({
      id: 'kubelogin',
      bin: 'kubelogin',
      args: ['convert-kubeconfig', '-l', 'azurecli', '--context', context],
      optional: true,
    });
  }
  if (namespace) {
    steps.push({ id: 'setNamespace', bin: 'kubectl', args: ['config', 'set-context', context, '--namespace', namespace] });
  }
  return { context, steps };
}

export interface StepResult {
  step: StepId;
  command: string;
  ok: boolean;
  skipped?: boolean;
  output: string;
  /** Translatable note about a non-fatal failure. */
  note?: string;
}

export async function addAksCluster(req: AddAksRequest): Promise<{ context: string; steps: StepResult[] }> {
  const { context, steps } = plan(req);
  const results: StepResult[] = [];

  for (const step of steps) {
    const command = formatCommand(step.bin, step.args);
    if (req.dryRun) {
      results.push({ step: step.id, command, ok: true, skipped: true, output: '' });
      continue;
    }
    try {
      const output = await run(step.bin, step.args, { timeoutMs: AZ_TIMEOUT_MS, write: true });
      results.push({ step: step.id, command, ok: true, output: output.trim() });
    } catch (err) {
      const e = err instanceof AppError ? err : new AppError('command', 'raw', String(err), { command });
      if (!step.optional) {
        // Keep the steps that already ran visible in the error detail.
        const done = results.map((r) => `✓ ${r.command}`).join('\n');
        throw new AppError(e.kind, e.code, e.message, {
          detail: [done, e.detail].filter(Boolean).join('\n\n'),
          command,
          params: e.params,
          step: step.id,
        });
      }
      results.push({
        step: step.id,
        command,
        ok: false,
        output: e.detail || e.message,
        note: e.kind === 'missing-binary' ? 'kubeloginMissing' : undefined,
      });
    }
  }
  return { context, steps: results };
}
