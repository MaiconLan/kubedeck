// Kubernetes resource quantities ("250m", "1.5", "128Mi", "3Gi", "123456n").

const CPU_SUFFIX: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3 };

/** Returns cores. */
export function parseCpu(q: unknown): number {
  const m = /^([0-9.eE+-]+)([numk]?)$/.exec(String(q ?? '').trim());
  return m ? Number(m[1]) * (CPU_SUFFIX[m[2]] ?? 1) || 0 : 0;
}

const MEM_SUFFIX: Record<string, number> = {
  '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60,
  m: 1e-3,
};

/** Returns bytes. */
export function parseMemory(q: unknown): number {
  const m = /^([0-9.]+(?:[eE][+-]?\d+)?)([a-zA-Z]{0,2})$/.exec(String(q ?? '').trim());
  return m ? Number(m[1]) * (MEM_SUFFIX[m[2]] ?? 1) || 0 : 0;
}
