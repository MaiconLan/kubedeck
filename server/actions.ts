import { AppError, invalid } from './errors.js';
import { checkName, formatCommand, kubectl } from './kube.js';
import { isProtected } from './settings.js';

export type ActionName = 'restart' | 'scale' | 'delete' | 'reconcile' | 'suspend' | 'resume';

const FLUX_TYPES = [
  'kustomizations.kustomize.toolkit.fluxcd.io',
  'helmreleases.helm.toolkit.fluxcd.io',
  'gitrepositories.source.toolkit.fluxcd.io',
  'helmrepositories.source.toolkit.fluxcd.io',
  'ocirepositories.source.toolkit.fluxcd.io',
  'helmcharts.source.toolkit.fluxcd.io',
  'buckets.source.toolkit.fluxcd.io',
];

/** Server-side allowlist: which action may run on which resource type. */
export const ALLOWED: Record<ActionName, string[]> = {
  restart: ['deployments.apps', 'statefulsets.apps', 'daemonsets.apps'],
  scale: ['deployments.apps', 'statefulsets.apps'],
  delete: ['pods'],
  reconcile: FLUX_TYPES,
  suspend: FLUX_TYPES,
  resume: FLUX_TYPES,
};

export interface ActionRequest {
  ctx: string;
  ns: string;
  type: string;
  name: string;
  action: ActionName;
  replicas?: number;
  /** Required on protected contexts: must equal `name`. */
  confirmName?: string;
  dryRun?: boolean;
}

function buildArgs(req: ActionRequest): string[] {
  const allowed = ALLOWED[req.action];
  if (!allowed) throw invalid('unknownAction', 'Unknown action.');
  if (!allowed.includes(req.type)) throw invalid('actionNotAllowed', `Action "${req.action}" is not allowed for ${req.type}.`, { action: req.action, type: req.type });
  const name = checkName(req.name, 'name');
  const ns = checkName(req.ns, 'namespace');
  const target = `${req.type}/${name}`;

  switch (req.action) {
    case 'restart':
      return ['rollout', 'restart', target, '-n', ns];
    case 'scale': {
      const n = Number(req.replicas);
      if (!Number.isInteger(n) || n < 0 || n > 1000) throw invalid('invalidReplicas', 'Invalid replica count.');
      return ['scale', target, `--replicas=${n}`, '-n', ns];
    }
    case 'delete':
      return ['delete', target, '-n', ns, '--wait=false'];
    case 'reconcile':
      // Same annotation the flux CLI sets; no flux binary required.
      return ['annotate', target, '-n', ns, '--overwrite', `reconcile.fluxcd.io/requestedAt=${new Date().toISOString()}`];
    case 'suspend':
    case 'resume':
      return ['patch', target, '-n', ns, '--type=merge', '-p', JSON.stringify({ spec: { suspend: req.action === 'suspend' } })];
  }
}

export async function runAction(req: ActionRequest): Promise<{ command: string; output: string; protected: boolean }> {
  const args = buildArgs(req);
  const command = formatCommand('kubectl', ['--context', req.ctx, ...args]);
  const guarded = await isProtected(req.ctx);
  if (req.dryRun) return { command, output: '', protected: guarded };

  if (guarded && req.confirmName !== req.name) {
    throw new AppError('protected', 'protectedConfirm', 'Protected context: type the resource name to confirm.', { command });
  }
  const output = await kubectl(req.ctx, args, { write: true });
  return { command, output: output.trim(), protected: guarded };
}
