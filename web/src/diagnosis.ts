/**
 * Rule-based "why isn't this pod running?" explanations.
 * Input: facts collected by the server (GET /api/diagnose). Output: translatable
 * diagnoses (message keys + params) plus the raw evidence they were derived from.
 * No AI involved: every rule matches fields and messages Kubernetes already reports.
 */
import { age, ts } from './format';
import { t, type MessageKey, type Params } from './i18n';

export type Severity = 'err' | 'warn' | 'info';
export type Category =
  | 'memory' | 'scheduling' | 'image' | 'config' | 'volume' | 'probe' | 'crash'
  | 'quota' | 'rollout' | 'eviction' | 'termination' | 'job' | 'other';
export type DiagAction = 'previousLogs' | 'logs' | 'yaml' | 'events';

export interface Msg {
  key: MessageKey;
  params?: Params;
}

export interface Diagnosis {
  severity: Severity;
  category: Category;
  title: Msg;
  detail?: Msg;
  bullets?: Msg[];
  evidence: string[];
  fix: Msg;
  actions: DiagAction[];
  container?: string;
  /** Set when a workload diagnosis comes from one of its pods. */
  pod?: { name: string; ns: string };
  /** How many of the workload's pods show the same problem. */
  affected?: number;
}

export interface PodFacts {
  pod: any;
  events: any[];
  previousLogs: Record<string, string[]>;
  missing: { secrets: string[]; configMaps: string[]; pvcs: string[] };
  pvcs: Array<{ name: string; phase: string }>;
}

export interface DiagnoseResult {
  kind: string;
  pod?: PodFacts;
  workload?: { object: any; events: any[]; pods: PodFacts[]; podCount: number };
}

const RANK: Record<Severity, number> = { err: 0, warn: 1, info: 2 };
const STUCK_MS = 60_000;

const m = (key: MessageKey, params?: Params): Msg => ({ key, params });

export function text(msg: Msg): string {
  return t(msg.key, msg.params);
}

function fmtEvent(e: any): string {
  return `event ${age(e.lastTimestamp)} ${e.reason}${e.count > 1 ? ` (x${e.count})` : ''}: ${e.message ?? ''}`.trim();
}

function eventsMatching(events: any[], test: RegExp, reasons?: string[]): any[] {
  return events.filter((e) => (!reasons || reasons.includes(e.reason)) && test.test(`${e.reason} ${e.message ?? ''}`));
}

function containerSpec(pod: any, name: string): any {
  return [...(pod.spec?.containers ?? []), ...(pod.spec?.initContainers ?? [])].find((c: any) => c.name === name) ?? {};
}

function describeProbe(p: any): string {
  if (!p) return '—';
  if (p.httpGet) return `HTTP ${p.httpGet.path ?? '/'}:${p.httpGet.port}`;
  if (p.tcpSocket) return `TCP :${p.tcpSocket.port}`;
  if (p.grpc) return `gRPC :${p.grpc.port}`;
  if (p.exec) return `exec ${(p.exec.command ?? []).join(' ')}`;
  return '—';
}

function registryOf(image: string): string {
  const first = image.split('/')[0];
  return image.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost') ? first : 'docker.io';
}

/** Where a Secret/ConfigMap is used, e.g. "env DB_PASSWORD" or "volume config". */
function usagesOf(pod: any, kind: 'Secret' | 'ConfigMap', name: string): string[] {
  const out: string[] = [];
  for (const c of [...(pod.spec?.containers ?? []), ...(pod.spec?.initContainers ?? [])]) {
    for (const e of c.env ?? []) {
      const ref = kind === 'Secret' ? e.valueFrom?.secretKeyRef : e.valueFrom?.configMapKeyRef;
      if (ref?.name === name) out.push(`env ${e.name}`);
    }
    for (const e of c.envFrom ?? []) {
      const ref = kind === 'Secret' ? e.secretRef : e.configMapRef;
      if (ref?.name === name) out.push(`envFrom (${c.name})`);
    }
  }
  for (const v of pod.spec?.volumes ?? []) {
    const ref = kind === 'Secret' ? v.secret?.secretName : v.configMap?.name;
    if (ref === name) out.push(`volume ${v.name}`);
  }
  if (kind === 'Secret' && (pod.spec?.imagePullSecrets ?? []).some((s: any) => s.name === name)) out.push('imagePullSecrets');
  return [...new Set(out)];
}

function podRequests(pod: any): { cpu: string; memory: string } {
  const cpu = (pod.spec?.containers ?? []).map((c: any) => c.resources?.requests?.cpu).filter(Boolean);
  const mem = (pod.spec?.containers ?? []).map((c: any) => c.resources?.requests?.memory).filter(Boolean);
  return { cpu: cpu.join(' + ') || '—', memory: mem.join(' + ') || '—' };
}

// ---- pods --------------------------------------------------------------------

export function diagnosePod(f: PodFacts): Diagnosis[] {
  const p = f.pod;
  const st = p.status ?? {};
  const events = f.events ?? [];
  const ns = p.metadata?.namespace ?? '';
  const out: Diagnosis[] = [];

  // Missing Secrets / ConfigMaps / PVCs are the clearest signal; report them first.
  for (const [kind, names] of [['Secret', f.missing?.secrets ?? []], ['ConfigMap', f.missing?.configMaps ?? []]] as const) {
    for (const name of names) {
      out.push({
        severity: 'err', category: 'config',
        title: m('diag.missingRef.title', { kind, name }),
        detail: m('diag.missingRef.detail', { ns, uses: usagesOf(p, kind, name).join(', ') || '—' }),
        evidence: [`${kind.toLowerCase()}/${name}: not found in namespace ${ns}`, ...eventsMatching(events, new RegExp(name)).slice(0, 2).map(fmtEvent)],
        fix: m('diag.missingRef.fix', { kind, name, ns }),
        actions: ['yaml', 'events'],
      });
    }
  }
  for (const name of f.missing?.pvcs ?? []) {
    out.push({
      severity: 'err', category: 'volume',
      title: m('diag.missingPvc.title', { name }),
      evidence: [`persistentvolumeclaim/${name}: not found in namespace ${ns}`],
      fix: m('diag.missingPvc.fix', { name, ns }),
      actions: ['yaml'],
    });
  }

  if (st.reason === 'Evicted') {
    out.push({
      severity: 'err', category: 'eviction',
      title: m('diag.evicted.title'),
      detail: st.message ? m('diag.raw', { text: st.message }) : undefined,
      evidence: [`status.reason=Evicted`, st.message ? `status.message: ${st.message}` : ''].filter(Boolean),
      fix: m('diag.evicted.fix'),
      actions: ['events'],
    });
  }

  if (p.metadata?.deletionTimestamp && Date.now() - ts(p.metadata.deletionTimestamp) > 5 * 60_000) {
    out.push({
      severity: 'warn', category: 'termination',
      title: m('diag.terminating.title', { age: age(p.metadata.deletionTimestamp) }),
      detail: (p.metadata.finalizers ?? []).length ? m('diag.terminating.finalizers', { list: p.metadata.finalizers.join(', ') }) : undefined,
      evidence: [`metadata.deletionTimestamp=${p.metadata.deletionTimestamp}`, ...(p.metadata.finalizers ?? []).map((x: string) => `finalizer ${x}`)],
      fix: m('diag.terminating.fix'),
      actions: ['yaml'],
    });
  }

  const scheduled = (st.conditions ?? []).find((c: any) => c.type === 'PodScheduled');
  if (scheduled?.status === 'False' && scheduled.reason === 'Unschedulable') {
    out.push(unschedulable(p, scheduled.message ?? '', events));
  } else if (st.phase === 'Pending' && !p.spec?.nodeName && Date.now() - ts(p.metadata?.creationTimestamp) > STUCK_MS && !scheduled) {
    out.push({
      severity: 'warn', category: 'scheduling',
      title: m('diag.pendingNoScheduler.title'),
      evidence: [`status.phase=Pending`, ...events.slice(0, 2).map(fmtEvent)],
      fix: m('diag.pendingNoScheduler.fix'),
      actions: ['events'],
    });
  }

  const statuses: Array<{ s: any; init: boolean }> = [
    ...(st.initContainerStatuses ?? []).map((s: any) => ({ s, init: true })),
    ...(st.containerStatuses ?? []).map((s: any) => ({ s, init: false })),
  ];
  for (const { s, init } of statuses) {
    const d = containerDiagnosis(p, s, init, f, events);
    if (d) out.push(d);
  }

  // PVC exists but has no volume bound: the pod waits in ContainerCreating/Pending.
  for (const pvc of f.pvcs ?? []) {
    if (pvc.phase === 'Pending') {
      out.push({
        severity: 'err', category: 'volume',
        title: m('diag.pvcPending.title', { name: pvc.name }),
        evidence: [`persistentvolumeclaim/${pvc.name} phase=Pending`],
        fix: m('diag.pvcPending.fix', { name: pvc.name }),
        actions: ['events'],
      });
    }
  }

  return dedupe(out);
}

function unschedulable(pod: any, message: string, events: any[]): Diagnosis {
  // "0/3 nodes are available: 1 node(s) had untolerated taint {...}, 2 Insufficient cpu. preemption: ..."
  const head = /^(\d+\/\d+) nodes are available/.exec(message);
  const body = message.split(/nodes are available:\s*/)[1]?.split(/\.\s*preemption:/i)[0] ?? message;
  const parts = body.split(/,\s*(?=\d+ )/).map((x) => x.trim().replace(/\.$/, '')).filter(Boolean);

  let fixKey: MessageKey = 'diag.sched.fixGeneric';
  const bullets: Msg[] = parts.map((part) => {
    const n = /^(\d+)/.exec(part)?.[1] ?? '?';
    let r: RegExpExecArray | null;
    if ((r = /Insufficient (\S+)/.exec(part))) {
      if (fixKey === 'diag.sched.fixGeneric') fixKey = 'diag.sched.fixResources';
      return m('diag.sched.insufficient', { n, resource: r[1] });
    }
    if ((r = /(?:untolerated taint|had taint)\s*(\{[^}]*\})?/.exec(part))) {
      if (fixKey === 'diag.sched.fixGeneric') fixKey = 'diag.sched.fixTaint';
      return m('diag.sched.taint', { n, taint: r[1] ?? '' });
    }
    if (/node affinity|node selector/i.test(part)) {
      if (fixKey === 'diag.sched.fixGeneric') fixKey = 'diag.sched.fixAffinity';
      return m('diag.sched.affinity', { n });
    }
    if (/unbound|PersistentVolumeClaim/i.test(part)) {
      fixKey = 'diag.sched.fixPvc';
      return m('diag.sched.pvc');
    }
    if (/volume node affinity conflict/i.test(part)) return m('diag.sched.volumeZone', { n });
    if (/Too many pods/i.test(part)) return m('diag.sched.tooManyPods', { n });
    if (/unschedulable/i.test(part)) return m('diag.sched.cordoned', { n });
    if (/free ports/i.test(part)) return m('diag.sched.ports', { n });
    return m('diag.raw', { text: part });
  });

  const req = podRequests(pod);
  return {
    severity: 'warn', category: 'scheduling',
    title: m('diag.unschedulable.title', { available: head?.[1] ?? '0' }),
    detail: m('diag.unschedulable.detail', req),
    bullets,
    evidence: [`PodScheduled=False reason=Unschedulable`, message, ...eventsMatching(events, /FailedScheduling/).slice(0, 1).map(fmtEvent)],
    fix: m(fixKey),
    actions: ['events', 'yaml'],
  };
}

function containerDiagnosis(pod: any, s: any, init: boolean, f: PodFacts, events: any[]): Diagnosis | null {
  const name: string = s.name;
  const spec = containerSpec(pod, name);
  const waiting = s.state?.waiting;
  const term = s.state?.terminated;
  const last = s.lastState?.terminated;
  const image: string = spec.image ?? s.image ?? '';
  const label = init ? `init:${name}` : name;
  const base = { container: name };
  const created = ts(pod.metadata?.creationTimestamp);

  // Image problems.
  if (waiting && /ImagePullBackOff|ErrImagePull|InvalidImageName|ErrImageNeverPull/.test(waiting.reason ?? '')) {
    const failed = eventsMatching(events, /./, ['Failed']).filter((e) => /pull|image/i.test(e.message ?? ''));
    const all = `${waiting.message ?? ''} ${failed.map((e) => e.message).join(' ')}`;
    const evidence = [`${label}: waiting reason=${waiting.reason}`, ...failed.slice(0, 2).map(fmtEvent)];
    const params = { image, registry: registryOf(image), container: label };
    if (waiting.reason === 'InvalidImageName') {
      return { ...base, severity: 'err', category: 'image', title: m('diag.imageInvalid.title', params), evidence, fix: m('diag.imageInvalid.fix'), actions: ['yaml'] };
    }
    if (/not found|manifest unknown|does not exist|NotFound/i.test(all) && !/unauthorized|authentication required/i.test(all)) {
      return { ...base, severity: 'err', category: 'image', title: m('diag.imageNotFound.title', params), evidence, fix: m('diag.imageNotFound.fix', params), actions: ['yaml', 'events'] };
    }
    if (/unauthorized|denied|authentication required|\b40[13]\b|pull access/i.test(all)) {
      return { ...base, severity: 'err', category: 'image', title: m('diag.imageAuth.title', params), evidence, fix: m('diag.imageAuth.fix', params), actions: ['yaml', 'events'] };
    }
    if (/no such host|i\/o timeout|dial tcp|connection refused|TLS handshake|x509/i.test(all)) {
      return { ...base, severity: 'err', category: 'image', title: m('diag.registryDown.title', params), evidence, fix: m('diag.registryDown.fix', params), actions: ['events'] };
    }
    return { ...base, severity: 'err', category: 'image', title: m('diag.imagePull.title', params), evidence, fix: m('diag.imagePull.fix', params), actions: ['events'] };
  }

  // Configuration referenced by the container (the missing-object rule may already cover it).
  if (waiting?.reason === 'CreateContainerConfigError') {
    const msg: string = waiting.message ?? '';
    const evidence = [`${label}: waiting reason=CreateContainerConfigError`, msg].filter(Boolean);
    let r: RegExpExecArray | null;
    if ((r = /(secret|configmap) "([^"]+)" not found/i.exec(msg))) {
      const kind = r[1].toLowerCase() === 'secret' ? 'Secret' : 'ConfigMap';
      return {
        ...base, severity: 'err', category: 'config',
        title: m('diag.missingRef.title', { kind, name: r[2] }),
        detail: m('diag.missingRef.detail', { ns: pod.metadata?.namespace ?? '', uses: usagesOf(pod, kind, r[2]).join(', ') || '—' }),
        evidence, fix: m('diag.missingRef.fix', { kind, name: r[2], ns: pod.metadata?.namespace ?? '' }), actions: ['yaml'],
      };
    }
    if ((r = /couldn't find key (\S+) in (Secret|ConfigMap) ([^/\s]+)\/(\S+)/i.exec(msg))) {
      return {
        ...base, severity: 'err', category: 'config',
        title: m('diag.missingKey.title', { key: r[1], kind: r[2], name: r[4] }),
        evidence, fix: m('diag.missingKey.fix', { key: r[1], kind: r[2], name: r[4] }), actions: ['yaml'],
      };
    }
    if (/non-root|runAsNonRoot/i.test(msg)) {
      return { ...base, severity: 'err', category: 'config', title: m('diag.runAsNonRoot.title', { container: label }), evidence, fix: m('diag.runAsNonRoot.fix'), actions: ['yaml'] };
    }
    return { ...base, severity: 'err', category: 'config', title: m('diag.configError.title', { container: label }), detail: m('diag.raw', { text: msg }), evidence, fix: m('diag.configError.fix'), actions: ['yaml', 'events'] };
  }

  if (waiting && /CreateContainerError|RunContainerError|StartError/.test(waiting.reason ?? '')) {
    const msg: string = waiting.message ?? '';
    const evidence = [`${label}: waiting reason=${waiting.reason}`, msg].filter(Boolean);
    if (/executable file not found|no such file or directory/i.test(msg)) {
      return { ...base, severity: 'err', category: 'crash', title: m('diag.commandNotFound.title', { container: label }), detail: m('diag.raw', { text: msg }), evidence, fix: m('diag.commandNotFound.fix'), actions: ['yaml'] };
    }
    return { ...base, severity: 'err', category: 'crash', title: m('diag.startError.title', { container: label }), detail: m('diag.raw', { text: msg }), evidence, fix: m('diag.startError.fix'), actions: ['yaml', 'events'] };
  }

  // Crashes and kills.
  const crashing = waiting?.reason === 'CrashLoopBackOff' || (term && term.exitCode !== 0) || ((s.restartCount ?? 0) >= 3 && last);
  const run = term && term.exitCode !== 0 ? term : last;
  if (crashing && run) {
    const logs = f.previousLogs?.[name] ?? [];
    const evidence = [
      `${label}: ${s.state?.waiting ? `waiting reason=${waiting.reason}` : term ? 'terminated' : 'running'} · restarts=${s.restartCount ?? 0}`,
      `lastState.terminated reason=${run.reason ?? '—'} exitCode=${run.exitCode}${run.finishedAt ? ` (${age(run.finishedAt)} ago)` : ''}`,
      ...eventsMatching(events, /BackOff|Killing|Unhealthy/).slice(0, 2).map(fmtEvent),
    ];
    const limit = spec.resources?.limits?.memory;
    const params = { container: label, code: run.exitCode, limit: limit ?? '—', restarts: s.restartCount ?? 0 };

    if (run.reason === 'OOMKilled') {
      return {
        ...base, severity: 'err', category: 'memory',
        title: m('diag.oom.title'),
        detail: limit ? m('diag.oom.detail', params) : m('diag.oom.noLimit', params),
        evidence, fix: m(limit ? 'diag.oom.fix' : 'diag.oom.fixNoLimit', params), actions: ['previousLogs', 'yaml'],
      };
    }
    const liveness = eventsMatching(events, /Liveness probe failed|failed liveness probe/i);
    if (liveness.length) {
      return {
        ...base, severity: 'err', category: 'probe',
        title: m('diag.livenessKill.title', { container: label }),
        detail: m('diag.livenessKill.detail', { probe: describeProbe(spec.livenessProbe) }),
        evidence: [...evidence, ...liveness.slice(0, 1).map(fmtEvent)],
        fix: m('diag.livenessKill.fix'), actions: ['previousLogs', 'events'],
      };
    }
    if (run.exitCode === 137) {
      return { ...base, severity: 'err', category: 'crash', title: m('diag.killed.title', params), evidence, fix: m('diag.killed.fix'), actions: ['previousLogs', 'events'] };
    }
    if (run.exitCode === 127) {
      return { ...base, severity: 'err', category: 'crash', title: m('diag.commandNotFound.title', params), evidence: [...evidence, ...logs.slice(-3)], fix: m('diag.commandNotFound.fix'), actions: ['previousLogs', 'yaml'] };
    }
    if (run.exitCode === 126) {
      return { ...base, severity: 'err', category: 'crash', title: m('diag.permission.title', params), evidence: [...evidence, ...logs.slice(-3)], fix: m('diag.permission.fix'), actions: ['previousLogs', 'yaml'] };
    }
    if (run.exitCode === 0) {
      return { ...base, severity: 'warn', category: 'crash', title: m('diag.exitsZero.title', params), evidence, fix: m('diag.exitsZero.fix'), actions: ['previousLogs', 'yaml'] };
    }
    return {
      ...base, severity: 'err', category: 'crash',
      title: m('diag.appCrash.title', params),
      detail: logs.length ? m('diag.appCrash.detailLogs') : m('diag.appCrash.detailNoLogs'),
      evidence: [...evidence, ...logs.slice(-6).map((l) => `log: ${l}`)],
      fix: m('diag.appCrash.fix'), actions: ['previousLogs', 'events'],
    };
  }

  // Stuck creating: usually a volume that cannot mount.
  if (waiting?.reason === 'ContainerCreating' && Date.now() - created > STUCK_MS) {
    const mount = eventsMatching(events, /./, ['FailedMount', 'FailedAttachVolume', 'FailedCreatePodSandBox']);
    if (mount.length) {
      const sandbox = mount[0].reason === 'FailedCreatePodSandBox';
      return {
        ...base, severity: 'err', category: sandbox ? 'other' : 'volume',
        title: m(sandbox ? 'diag.sandbox.title' : 'diag.mount.title'),
        detail: m('diag.raw', { text: mount[0].message ?? '' }),
        evidence: mount.slice(0, 3).map(fmtEvent),
        fix: m(sandbox ? 'diag.sandbox.fix' : 'diag.mount.fix'), actions: ['events'],
      };
    }
  }

  // Running but not ready / probes failing.
  if (s.state?.running && !s.ready && !init) {
    const startup = eventsMatching(events, /Startup probe failed/i);
    const readiness = eventsMatching(events, /Readiness probe failed/i);
    const hit = startup.length ? startup : readiness;
    if (hit.length) {
      const probe = startup.length ? spec.startupProbe : spec.readinessProbe;
      return {
        ...base, severity: 'warn', category: 'probe',
        title: m(startup.length ? 'diag.startup.title' : 'diag.readiness.title', { container: label }),
        detail: m('diag.readiness.detail', { probe: describeProbe(probe) }),
        evidence: [`${label}: running, ready=false`, ...hit.slice(0, 2).map(fmtEvent)],
        fix: m('diag.readiness.fix'), actions: ['logs', 'events'],
      };
    }
  }

  // Healthy now, but restarting a lot.
  if ((s.restartCount ?? 0) >= 5 && s.state?.running) {
    return {
      ...base, severity: 'warn', category: 'crash',
      title: m('diag.restarts.title', { container: label, n: s.restartCount }),
      detail: last ? m('diag.restarts.detail', { reason: last.reason ?? '—', code: last.exitCode, when: last.finishedAt ? age(last.finishedAt) : '—' }) : undefined,
      evidence: [`${label}: restarts=${s.restartCount}`, last ? `lastState.terminated reason=${last.reason ?? '—'} exitCode=${last.exitCode}` : ''].filter(Boolean),
      fix: m(last?.reason === 'OOMKilled' ? 'diag.oom.fix' : 'diag.restarts.fix', { limit: spec.resources?.limits?.memory ?? '—' }),
      actions: ['previousLogs'],
    };
  }
  return null;
}

// ---- workloads -----------------------------------------------------------------

export function diagnoseWorkload(r: NonNullable<DiagnoseResult['workload']>): Diagnosis[] {
  const o = r.object;
  const st = o.status ?? {};
  const out: Diagnosis[] = [];
  const conditions: any[] = st.conditions ?? [];
  const cond = (type: string) => conditions.find((c) => c.type === type);

  const failure = cond('ReplicaFailure');
  const failedCreate = eventsMatching(r.events, /./, ['FailedCreate']);
  const createMsg: string = failure?.status === 'True' ? failure.message ?? '' : failedCreate[0]?.message ?? '';
  if (createMsg) out.push(createFailure(createMsg, [failure?.status === 'True' ? `ReplicaFailure: ${failure.message}` : '', ...failedCreate.slice(0, 2).map(fmtEvent)].filter(Boolean)));

  if (o.kind === 'Job') {
    const failed = cond('Failed');
    if (failed?.status === 'True') {
      const deadline = failed.reason === 'DeadlineExceeded';
      out.push({
        severity: 'err', category: 'job',
        title: m(deadline ? 'diag.jobDeadline.title' : 'diag.jobBackoff.title', { limit: o.spec?.backoffLimit ?? 6 }),
        detail: failed.message ? m('diag.raw', { text: failed.message }) : undefined,
        evidence: [`condition Failed reason=${failed.reason}`, `succeeded=${st.succeeded ?? 0} failed=${st.failed ?? 0}`],
        fix: m(deadline ? 'diag.jobDeadline.fix' : 'diag.jobBackoff.fix'), actions: ['events'],
      });
    }
  }

  const progressing = cond('Progressing');
  if (progressing?.status === 'False' && progressing.reason === 'ProgressDeadlineExceeded') {
    out.push({
      severity: 'warn', category: 'rollout',
      title: m('diag.rolloutStuck.title'),
      detail: progressing.message ? m('diag.raw', { text: progressing.message }) : undefined,
      evidence: [`Progressing=False reason=ProgressDeadlineExceeded`, `updated=${st.updatedReplicas ?? 0} ready=${st.readyReplicas ?? 0} desired=${o.spec?.replicas ?? 0}`],
      fix: m('diag.rolloutStuck.fix'), actions: ['events'],
    });
  }

  // Problems of the pods behind the workload, grouped when several pods share one.
  const fromPods: Diagnosis[] = [];
  for (const pf of r.pods) {
    for (const d of diagnosePod(pf)) {
      const same = fromPods.find((x) => x.title.key === d.title.key && x.container === d.container);
      if (same) same.affected = (same.affected ?? 1) + 1;
      else fromPods.push({ ...d, pod: { name: pf.pod.metadata.name, ns: pf.pod.metadata.namespace }, affected: 1 });
    }
  }
  out.push(...fromPods);

  const desired = o.kind === 'DaemonSet' ? st.desiredNumberScheduled ?? 0 : o.spec?.replicas ?? 0;
  if (!out.length) {
    if (o.kind === 'DaemonSet' && desired === 0) {
      out.push({ severity: 'info', category: 'scheduling', title: m('diag.dsNoNodes.title'), evidence: ['desiredNumberScheduled=0'], fix: m('diag.dsNoNodes.fix'), actions: ['yaml'] });
    } else if (o.kind !== 'DaemonSet' && o.kind !== 'Job' && desired === 0) {
      out.push({ severity: 'info', category: 'other', title: m('diag.scaledToZero.title'), evidence: ['spec.replicas=0'], fix: m('diag.scaledToZero.fix'), actions: [] });
    } else if (desired > 0 && r.podCount === 0) {
      out.push({ severity: 'warn', category: 'other', title: m('diag.noPods.title'), evidence: [`desired=${desired} pods=0`, ...r.events.slice(0, 2).map(fmtEvent)], fix: m('diag.noPods.fix'), actions: ['events'] });
    }
  }
  return dedupe(out);
}

function createFailure(msg: string, evidence: string[]): Diagnosis {
  let r: RegExpExecArray | null;
  if ((r = /exceeded quota: ([^,]+), requested: ([^,]+), used: ([^,]+), limited: ([^\s,]+)/.exec(msg))) {
    return {
      severity: 'err', category: 'quota',
      title: m('diag.quota.title'),
      detail: m('diag.quota.detail', { quota: r[1], requested: r[2], used: r[3], limited: r[4] }),
      evidence, fix: m('diag.quota.fix', { quota: r[1] }), actions: ['events'],
    };
  }
  if (/must specify (limits|requests)/i.test(msg)) {
    return { severity: 'err', category: 'quota', title: m('diag.quotaNeedsResources.title'), detail: m('diag.raw', { text: msg }), evidence, fix: m('diag.quotaNeedsResources.fix'), actions: ['yaml'] };
  }
  if ((r = /admission webhook "([^"]+)" denied the request:?\s*(.*)/.exec(msg))) {
    return { severity: 'err', category: 'config', title: m('diag.webhook.title', { name: r[1] }), detail: m('diag.raw', { text: r[2] }), evidence, fix: m('diag.webhook.fix'), actions: ['yaml', 'events'] };
  }
  if ((r = /serviceaccount "([^"]+)" not found/i.exec(msg))) {
    return { severity: 'err', category: 'config', title: m('diag.missingSa.title', { name: r[1] }), evidence, fix: m('diag.missingSa.fix', { name: r[1] }), actions: ['yaml'] };
  }
  return { severity: 'err', category: 'other', title: m('diag.createFailed.title'), detail: m('diag.raw', { text: msg }), evidence, fix: m('diag.createFailed.fix'), actions: ['events'] };
}

function dedupe(list: Diagnosis[]): Diagnosis[] {
  const seen = new Set<string>();
  return list
    .filter((d) => {
      const k = `${d.title.key}|${JSON.stringify(d.title.params ?? {})}|${d.container ?? ''}|${d.pod?.name ?? ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

export function diagnoseResult(r: DiagnoseResult): Diagnosis[] {
  if (r.pod) return diagnosePod(r.pod);
  if (r.workload) return diagnoseWorkload(r.workload);
  return [];
}

// ---- quick hints (dashboard: no events or logs available) --------------------

export function quickPodHint(pod: any): string | null {
  const d = diagnosePod({ pod, events: [], previousLogs: {}, missing: { secrets: [], configMaps: [], pvcs: [] }, pvcs: [] })[0];
  return d ? text(d.title) : null;
}

export function quickWorkloadHint(w: any): string | null {
  const failure = (w.status?.conditions ?? []).find((c: any) => c.type === 'ReplicaFailure' && c.status === 'True');
  if (failure?.message) return text(createFailure(failure.message, []).title);
  const progressing = (w.status?.conditions ?? []).find((c: any) => c.type === 'Progressing' && c.status === 'False');
  if (progressing?.reason === 'ProgressDeadlineExceeded') return text(m('diag.rolloutStuck.title'));
  return null;
}

/** Whether an object looks unhealthy enough to run the (more expensive) diagnosis. */
export function needsDiagnosis(obj: any): boolean {
  const st = obj?.status ?? {};
  switch (obj?.kind) {
    case 'Pod': {
      if (st.phase === 'Succeeded') return false;
      if (st.phase !== 'Running' || obj.metadata?.deletionTimestamp || st.reason === 'Evicted') return true;
      const cs: any[] = [...(st.initContainerStatuses ?? []), ...(st.containerStatuses ?? [])];
      return cs.some((c) => (!c.ready && !c.state?.terminated) || (c.restartCount ?? 0) >= 5 || c.state?.waiting);
    }
    case 'Deployment':
    case 'StatefulSet':
    case 'ReplicaSet': {
      const want = obj.spec?.replicas ?? 0;
      const failing = (st.conditions ?? []).some((c: any) => (c.type === 'ReplicaFailure' && c.status === 'True') || (c.type === 'Progressing' && c.status === 'False'));
      return failing || (st.readyReplicas ?? 0) < want;
    }
    case 'DaemonSet':
      return (st.numberReady ?? 0) < (st.desiredNumberScheduled ?? 0);
    case 'Job':
      return (st.conditions ?? []).some((c: any) => c.type === 'Failed' && c.status === 'True') || (st.failed ?? 0) > 0;
    default:
      return false;
  }
}

export const DIAGNOSABLE: Record<string, string> = {
  Pod: 'pods',
  Deployment: 'deployments.apps',
  StatefulSet: 'statefulsets.apps',
  DaemonSet: 'daemonsets.apps',
  ReplicaSet: 'replicasets.apps',
  Job: 'jobs.batch',
};

/** Plain-text version for "Copy diagnosis" (in the current UI language). */
export function diagnosisAsText(d: Diagnosis, subject: string): string {
  const lines = [
    `${t('diag.heading')} · ${t(`diag.cat.${d.category}`)} — ${subject}`,
    text(d.title),
    ...(d.detail ? [text(d.detail)] : []),
    ...(d.bullets ?? []).map((b) => `- ${text(b)}`),
    '',
    `${t('diag.evidence')}:`,
    ...d.evidence.map((e) => `  ${e}`),
    '',
    `${t('diag.whatToDo')}: ${text(d.fix)}`,
  ];
  return lines.join('\n');
}
