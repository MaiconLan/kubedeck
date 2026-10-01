/** "g" followed by one of these keys jumps to that screen (k9s-style). */
export const GO_KEYS: Array<{ key: string; type: string }> = [
  { key: 'd', type: 'dashboard' },
  { key: 'm', type: 'map' }, // only active when FEATURES.relationMap is on
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
