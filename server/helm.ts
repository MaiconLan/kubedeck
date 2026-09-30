import { invalid } from './errors.js';
import { checkName, helm } from './kube.js';

export async function listReleases(ctx: string, ns: string | undefined) {
  const scope = !ns || ns === '*' ? ['--all-namespaces'] : ['-n', checkName(ns, 'namespace')];
  const out = await helm(ctx, ['list', ...scope, '--all', '-o', 'json', '--max', '0'], { timeoutMs: 30_000 });
  return JSON.parse(out || '[]');
}

export type HelmView = 'status' | 'history' | 'values' | 'values-all' | 'manifest' | 'notes';

export async function releaseDetail(ctx: string, ns: string, name: string, view: HelmView): Promise<string> {
  const base = [checkName(name, 'release'), '-n', checkName(ns, 'namespace')];
  switch (view) {
    case 'status':
      return helm(ctx, ['status', ...base]);
    case 'history':
      return helm(ctx, ['history', ...base, '-o', 'json']);
    case 'values':
      return helm(ctx, ['get', 'values', ...base, '-o', 'yaml']);
    case 'values-all':
      return helm(ctx, ['get', 'values', ...base, '--all', '-o', 'yaml']);
    case 'manifest':
      return helm(ctx, ['get', 'manifest', ...base]);
    case 'notes':
      return helm(ctx, ['get', 'notes', ...base]);
    default:
      throw invalid('invalidHelmView', 'Invalid Helm view.');
  }
}
