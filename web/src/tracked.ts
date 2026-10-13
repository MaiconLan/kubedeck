import type { TrackedRef } from './api';
import { KIND_BY_TYPE, type Cell } from './catalog';
import { images, shortImage } from './format';
import type { MessageKey } from './i18n';

type Key = Omit<TrackedRef, 'fields'>;

export interface TrackField {
  id: string;
  label: MessageKey;
  get: (pod: any) => Cell;
}

const podColumn = (key: string) => (pod: any): Cell => KIND_BY_TYPE.get('pods')?.columns.find((c) => c.key === key)?.get(pod) ?? '';

/** Pod facts a tracked card can show; the pods list columns are reused where they exist. */
export const TRACK_FIELDS: TrackField[] = [
  { id: 'status', label: 'col.status', get: podColumn('status') },
  { id: 'ready', label: 'col.ready', get: podColumn('ready') },
  { id: 'restarts', label: 'col.restarts', get: podColumn('restarts') },
  { id: 'node', label: 'col.node', get: podColumn('node') },
  { id: 'ip', label: 'col.ip', get: podColumn('ip') },
  { id: 'age', label: 'col.age', get: podColumn('age') },
  {
    id: 'owner', label: 'col.owner',
    get: (pod) => { const r = pod.metadata?.ownerReferences?.[0]; return r ? `${r.kind}/${r.name}` : '—'; },
  },
  {
    id: 'images', label: 'col.images',
    get: (pod) => { const all = images(pod.spec); return { text: all.split(', ').map(shortImage).join(', '), title: all }; },
  },
  {
    id: 'containers', label: 'tracked.containers',
    get: (pod) => (pod.spec?.containers ?? []).map((c: any) => c.name).join(', '),
  },
  {
    id: 'labels', label: 'tracked.labels',
    get: (pod) => {
      const all = Object.entries(pod.metadata?.labels ?? {}).map(([k, v]) => `${k}=${v}`).join(', ');
      return { text: all || '—', title: all };
    },
  },
];

export const DEFAULT_FIELDS = ['ready', 'restarts', 'node', 'age'];
/** A medium card has room for this many fields. */
export const MAX_FIELDS = 6;

export function fieldsOf(ref: TrackedRef): TrackField[] {
  const ids = ref.fields ?? DEFAULT_FIELDS;
  return TRACK_FIELDS.filter((f) => ids.includes(f.id));
}

/** The tracked entry a pod belongs to, if any. */
export function entryOf(list: TrackedRef[], ctx: string, pod: any): TrackedRef | undefined {
  const k = keyFor(ctx, pod);
  return list.find((t) => sameTrack(t, k));
}

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
