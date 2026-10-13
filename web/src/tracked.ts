import type { TrackedRef } from './api';

type Key = Omit<TrackedRef, 'fields'>;

export function trackKeyOf(pod: any): Key {
  const ns = pod.metadata?.namespace ?? '';
  const podName = pod.metadata?.name ?? '';
  const ref = pod.metadata?.ownerReferences?.[0];
  if (ref?.kind === 'ReplicaSet') {
    const hash = pod.metadata?.labels?.['pod-template-hash'];
    if (hash && ref.name.endsWith(`-${hash}`)) {
      return { ctx: '', ns, kind: 'Deployment', name: ref.name.slice(0, -(hash.length + 1)) };
    }
  } else if (ref && (ref.kind === 'StatefulSet' || ref.kind === 'DaemonSet' || ref.kind === 'Job')) {
    return { ctx: '', ns, kind: ref.kind, name: ref.name };
  }
  return { ctx: '', ns, kind: 'Pod', name: podName };
}

export function sameTrack(a: Key, b: Key): boolean {
  return a.ctx === b.ctx && a.ns === b.ns && a.kind === b.kind && a.name === b.name;
}

function keyFor(ctx: string, pod: any): Key {
  return { ...trackKeyOf(pod), ctx };
}

export function isTracked(list: TrackedRef[], ctx: string, pod: any): boolean {
  const k = keyFor(ctx, pod);
  return list.some((t) => sameTrack(t, k));
}

export function toggleTracked(list: TrackedRef[], ctx: string, pod: any): TrackedRef[] {
  const k = keyFor(ctx, pod);
  return isTracked(list, ctx, pod) ? list.filter((t) => !sameTrack(t, k)) : [...list, k];
}
