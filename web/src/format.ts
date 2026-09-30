import { getLanguage, t } from './i18n';

export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'muted';

export function age(ts?: string): string {
  if (!ts) return '';
  const secs = Math.max(0, Math.floor((Date.now() - Date.parse(ts)) / 1000));
  if (secs < 120) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 120) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h${mins % 60 ? `${mins % 60}m` : ''}`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d${hours % 24 ? `${hours % 24}h` : ''}`;
  return `${Math.floor(days / 365)}y${days % 365}d`;
}

export function ts(value?: string): number {
  return value ? Date.parse(value) || 0 : 0;
}

export function dateTime(value?: string): string {
  if (!value) return '';
  const d = new Date(value);
  return isNaN(d.getTime()) ? value : d.toLocaleString(getLanguage());
}

const ERROR_REASONS = /CrashLoopBackOff|Error|ErrImagePull|ImagePullBackOff|InvalidImageName|OOMKilled|CreateContainer(Config)?Error|Failed|Evicted|ContainerStatusUnknown|DeadlineExceeded|BackoffLimitExceeded/i;

export function podStatus(pod: any): { text: string; tone: Tone } {
  const st = pod.status ?? {};
  let reason: string = st.reason || st.phase || 'Unknown';
  let initializing = false;

  const inits: any[] = st.initContainerStatuses ?? [];
  inits.forEach((c, i) => {
    if (initializing) return;
    const t = c.state?.terminated;
    const w = c.state?.waiting;
    if (t && t.exitCode === 0) return;
    if (t) reason = `Init:${t.reason || (t.signal ? `Signal:${t.signal}` : `ExitCode:${t.exitCode}`)}`;
    else if (w?.reason && w.reason !== 'PodInitializing') reason = `Init:${w.reason}`;
    else reason = `Init:${i}/${inits.length}`;
    initializing = true;
  });

  if (!initializing) {
    let hasRunning = false;
    for (const c of [...(st.containerStatuses ?? [])].reverse()) {
      const w = c.state?.waiting;
      const t = c.state?.terminated;
      if (w?.reason) reason = w.reason;
      else if (t?.reason) reason = t.reason;
      else if (t) reason = t.signal ? `Signal:${t.signal}` : `ExitCode:${t.exitCode}`;
      else if (c.ready && c.state?.running) hasRunning = true;
    }
    if (reason === 'Completed' && hasRunning) reason = 'Running';
  }

  if (pod.metadata?.deletionTimestamp) reason = st.reason === 'NodeLost' ? 'Unknown' : 'Terminating';

  let tone: Tone = 'info';
  if (ERROR_REASONS.test(reason)) tone = 'err';
  else if (reason === 'Running') tone = readyCount(pod)[0] === readyCount(pod)[1] ? 'ok' : 'warn';
  else if (reason === 'Succeeded' || reason === 'Completed') tone = 'muted';
  else if (reason === 'Terminating' || reason.startsWith('Init:') || reason === 'Pending' || reason === 'ContainerCreating') tone = 'warn';
  return { text: reason, tone };
}

export function readyCount(pod: any): [number, number] {
  const cs: any[] = pod.status?.containerStatuses ?? [];
  const total = pod.spec?.containers?.length ?? cs.length;
  return [cs.filter((c) => c.ready).length, total];
}

export function restarts(pod: any): number {
  return (pod.status?.containerStatuses ?? []).reduce((n: number, c: any) => n + (c.restartCount ?? 0), 0);
}

export function condition(obj: any, type: string): any | undefined {
  return (obj.status?.conditions ?? []).find((c: any) => c.type === type);
}

/** Generic "Ready" condition, used by Flux objects and most operators. */
export function readyState(obj: any): { text: string; tone: Tone; message: string } {
  if (obj.spec?.suspend === true) return { text: t('status.suspended'), tone: 'muted', message: '' };
  const c = condition(obj, 'Ready');
  if (!c) return { text: '—', tone: 'muted', message: '' };
  if (c.status === 'True') return { text: 'Ready', tone: 'ok', message: c.message ?? '' };
  if (c.status === 'False') {
    const stalled = condition(obj, 'Stalled')?.status === 'True';
    const reconciling = condition(obj, 'Reconciling')?.status === 'True';
    if (reconciling && !stalled) return { text: t('status.reconciling'), tone: 'warn', message: c.message ?? '' };
    return { text: c.reason || 'NotReady', tone: 'err', message: c.message ?? '' };
  }
  return { text: c.reason || 'Unknown', tone: 'warn', message: c.message ?? '' };
}

export function ratio(ready: number | undefined, total: number | undefined): { text: string; tone: Tone } {
  const r = ready ?? 0;
  const t = total ?? 0;
  return { text: `${r}/${t}`, tone: t === 0 ? 'muted' : r >= t ? 'ok' : r === 0 ? 'err' : 'warn' };
}

export function images(spec: any): string {
  return (spec?.containers ?? []).map((c: any) => c.image).join(', ');
}

export function shortImage(image: string): string {
  const noRegistry = image.includes('/') ? image.split('/').slice(-1)[0] : image;
  return noRegistry.length > 60 ? `${noRegistry.slice(0, 57)}…` : noRegistry;
}

export function selectorString(labels: Record<string, string> | undefined): string {
  return Object.entries(labels ?? {}).map(([k, v]) => `${k}=${v}`).join(',');
}
