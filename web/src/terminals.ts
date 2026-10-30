import { uid } from './tabs';

/** A terminal in the bottom panel: a shell on this machine (follows the focused tab) or a shell inside a pod. */
export type TermSession =
  | { id: string; kind: 'shell' }
  | { id: string; kind: 'pod'; ctx: string; pod: { name: string; ns: string } };

export function newShell(): TermSession {
  return { id: uid('s'), kind: 'shell' };
}

export function newPodShell(ctx: string, pod: { name: string; ns: string }): TermSession {
  return { id: uid('s'), kind: 'pod', ctx, pod };
}
