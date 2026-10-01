/**
 * The current screen lives in the URL hash so the browser's back/forward
 * buttons work and every screen can be bookmarked:
 *   #/<context>/<namespace>/<screen type>[/<target type>/<target namespace or ->/<target name>]
 */
export interface Route {
  ctx: string;
  ns: string;
  type: string;
  target?: { type: string; ns?: string; name: string };
}

const NO_NS = '-';

export function buildHash(route: Route): string {
  const parts = [route.ctx, route.ns, route.type];
  if (route.target) parts.push(route.target.type, route.target.ns ?? NO_NS, route.target.name);
  return `#/${parts.map(encodeURIComponent).join('/')}`;
}

export function parseHash(hash: string): Route | null {
  const parts = hash.replace(/^#\/?/, '').split('/').filter((p) => p !== '');
  if (parts.length < 3) return null;
  try {
    const [ctx, ns, type, targetType, targetNs, targetName] = parts.map(decodeURIComponent);
    return {
      ctx,
      ns,
      type,
      target: targetName ? { type: targetType, ns: targetNs === NO_NS ? undefined : targetNs, name: targetName } : undefined,
    };
  } catch {
    return null;
  }
}

/** "g" followed by one of these keys jumps to that screen (k9s-style). */
export const GO_KEYS: Array<{ key: string; type: string }> = [
  { key: 'd', type: 'dashboard' },
  { key: 'm', type: 'map' },
  { key: 'n', type: 'nodes' },
  { key: 'e', type: 'events' },
  { key: 'p', type: 'pods' },
  { key: 'y', type: 'deployments.apps' },
  { key: 's', type: 'services' },
  { key: 'i', type: 'ingresses.networking.k8s.io' },
  { key: 'c', type: 'configmaps' },
  { key: 'x', type: 'secrets' },
  { key: 'k', type: 'kustomizations.kustomize.toolkit.fluxcd.io' },
  { key: 'h', type: 'helmreleases.helm.toolkit.fluxcd.io' },
  { key: 'r', type: 'helm-releases' },
];
