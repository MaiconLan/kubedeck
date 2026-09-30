import { useCallback, useEffect, useRef, useState } from 'react';
import { errorOf, type ApiError } from './api';

export interface AsyncState<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload: () => void;
}

/**
 * Runs `fn` whenever `deps` change and, if `intervalMs` > 0, on a timer.
 * Polls never overlap and stale responses (from old deps) are dropped.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], intervalMs = 0): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback((background: boolean) => {
    if (background && inFlight.current) return;
    const gen = generation.current;
    inFlight.current = true;
    if (!background) setLoading(true);
    fnRef.current()
      .then((value) => {
        if (gen !== generation.current) return;
        setData(value);
        setError(undefined);
      })
      .catch((err) => {
        if (gen !== generation.current) return;
        setError(errorOf(err));
      })
      .finally(() => {
        inFlight.current = false;
        if (gen === generation.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    generation.current++;
    inFlight.current = false;
    setData(undefined);
    setError(undefined);
    run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (!intervalMs) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') run(true);
    }, intervalMs);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);

  return { data, error, loading, reload: () => run(false) };
}

export function useKey(handler: (e: KeyboardEvent) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = (e: KeyboardEvent) => ref.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
}

export function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
