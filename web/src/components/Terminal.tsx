import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ApiError } from '../api';
import { useAsync } from '../hooks';
import { t } from '../i18n';
import { Badge, ErrorBanner, Icon, Spinner } from './ui';

interface Props {
  ctx: string;
  ns: string;
  /** Shown in its pane; a hidden terminal keeps running. */
  visible: boolean;
  focused: boolean;
  /** Set: a shell inside this pod (`kubectl exec`) instead of a shell on this machine. */
  pod?: { name: string; ns: string };
}

type Status = 'connecting' | 'ready' | 'exited' | 'failed';

interface Confirm {
  id: string;
  command: string;
  ctx: string;
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

/** xterm colors from the app's CSS tokens, so the terminal follows the theme. */
function themeFromCss(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim() || undefined;
  return {
    background: v('--bg-sunken'),
    foreground: v('--text'),
    cursor: v('--accent'),
    cursorAccent: v('--bg-sunken'),
    selectionBackground: v('--accent-soft'),
    red: v('--err'),
    green: v('--ok'),
    yellow: v('--warn'),
    blue: v('--info'),
    magenta: v('--accent'),
    brightBlack: v('--text-3'),
  };
}

/** Container to open by default: the pod's default-container annotation, else the first one. */
function defaultContainer(pod: any): string | undefined {
  return pod?.metadata?.annotations?.['kubectl.kubernetes.io/default-container'] ?? pod?.spec?.containers?.[0]?.name;
}

export function Terminal({ ctx, ns, visible, focused, pod }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm>();
  const fitRef = useRef<FitAddon>();
  const wsRef = useRef<WebSocket>();
  const [status, setStatus] = useState<Status>('connecting');
  const [pty, setPty] = useState(true);
  const [command, setCommand] = useState('');
  const [error, setError] = useState<ApiError>();
  const [confirm, setConfirm] = useState<Confirm>();
  const [typed, setTyped] = useState('');
  const [run, setRun] = useState(0);

  const podObj = useAsync(() => (pod ? api.object(ctx, 'pods', pod.name, pod.ns) : Promise.resolve(null)), [ctx, pod?.name, pod?.ns]);
  const containers: string[] = useMemo(() => (podObj.data?.spec?.containers ?? []).map((c: any) => c.name), [podObj.data]);
  const [container, setContainer] = useState<string>();
  useEffect(() => {
    if (podObj.data && !container) setContainer(defaultContainer(podObj.data));
  }, [podObj.data, container]);

  // Mutable state the xterm callbacks read.
  const live = useRef({ status: 'connecting' as Status, pty: true, line: '', history: [] as string[], at: 0 });

  // ---- xterm instance (one per component; sessions reuse it)
  useEffect(() => {
    const term = new XTerm({
      fontFamily: '"Geist Mono", ui-monospace, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: themeFromCss(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    termRef.current = term;
    fitRef.current = fit;

    // Copy and paste like other terminals: Ctrl+Shift+C/V, and Ctrl+C copies when text is selected.
    term.attachCustomKeyEventHandler((e) => {
      // Ctrl+` belongs to the app (shows/hides the terminal panel).
      if (e.ctrlKey && e.key === '`') return false;
      if (e.type !== 'keydown' || isMac) return true;
      const key = e.key.toLowerCase();
      if (e.ctrlKey && (key === 'c') && (e.shiftKey || term.hasSelection())) {
        const text = term.getSelection();
        if (text) void navigator.clipboard?.writeText(text);
        term.clearSelection();
        e.preventDefault();
        return false;
      }
      // Ctrl+V / Ctrl+Shift+V: let the browser paste into xterm's textarea.
      if (e.ctrlKey && key === 'v') return false;
      return true;
    });

    const send = (data: string) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    };

    term.onData((data) => {
      const s = live.current;
      if (s.status === 'exited' || s.status === 'failed') {
        if (data === '\r') setRun((n) => n + 1);
        return;
      }
      if (s.pty) {
        send(data);
        return;
      }
      // Simple mode (no PTY): the program does not echo, so the line is edited here.
      if (data.startsWith('\x1b')) {
        // Up/down: history; other escape sequences (arrows, function keys) are ignored.
        if ((data === '\x1b[A' || data === '\x1b[B') && s.history.length) {
          s.at = Math.max(0, Math.min(s.history.length, s.at + (data === '\x1b[A' ? -1 : 1)));
          const next = s.history[s.at] ?? '';
          term.write('\b \b'.repeat(s.line.length) + next);
          s.line = next;
        }
        return;
      }
      for (const ch of data.replace(/\r\n/g, '\r')) {
        if (ch === '\r' || ch === '\n') {
          term.write('\r\n');
          if (s.line.trim()) s.history.push(s.line);
          s.at = s.history.length;
          send(`${s.line}\n`);
          s.line = '';
        } else if (ch === '\x7f' || ch === '\b') {
          if (s.line) {
            s.line = s.line.slice(0, -1);
            term.write('\b \b');
          }
        } else if (ch === '\x03') {
          term.write('^C\r\n');
          s.line = '';
        } else if (ch >= ' ') {
          s.line += ch;
          term.write(ch);
        }
      }
    });

    term.onResize(({ cols, rows }) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });

    const observer = new ResizeObserver(() => {
      if (host.current && host.current.offsetWidth > 0 && host.current.offsetHeight > 0) {
        try { fit.fit(); } catch { /* not laid out yet */ }
      }
    });
    observer.observe(host.current!);

    // Theme switch: the app changes data-theme on <html>.
    const themeWatch = new MutationObserver(() => { term.options.theme = themeFromCss(); });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });

    return () => {
      observer.disconnect();
      themeWatch.disconnect();
      wsRef.current?.close();
      term.dispose();
    };
  }, []);

  // ---- session
  const waitingForContainer = !!pod && !container && !podObj.error;
  useEffect(() => {
    const term = termRef.current;
    if (!term || waitingForContainer) return;
    const setLive = (st: Status) => { live.current.status = st; setStatus(st); };
    setLive('connecting');
    setError(undefined);
    setConfirm(undefined);
    live.current.line = '';
    term.reset();

    const ws = new WebSocket(api.terminalUrl());
    wsRef.current = ws;
    ws.onopen = () => {
      try { fitRef.current?.fit(); } catch { /* hidden */ }
      ws.send(JSON.stringify({
        type: 'start',
        mode: pod ? 'exec' : 'shell',
        ctx,
        ns: pod ? pod.ns : ns,
        pod: pod?.name,
        container,
        cols: term.cols,
        rows: term.rows,
      }));
    };
    ws.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.type === 'output') {
        term.write(msg.data);
      } else if (msg.type === 'ready') {
        live.current.pty = msg.pty;
        setPty(msg.pty);
        setCommand(msg.shell);
        setLive('ready');
      } else if (msg.type === 'exit') {
        term.write(`\r\n\x1b[2m${t('term.exited', { code: msg.code })}\x1b[0m\r\n`);
        setLive('exited');
      } else if (msg.type === 'confirm') {
        setTyped('');
        setConfirm({ id: msg.id, command: msg.command, ctx: msg.ctx });
      } else if (msg.type === 'error') {
        setError(msg.error);
        setLive('failed');
      }
    };
    ws.onclose = () => {
      if (live.current.status === 'connecting' || live.current.status === 'ready') setLive('exited');
    };
    return () => {
      ws.onclose = null;
      ws.close();
    };
    // The tab's namespace is sent with `scope` below; it does not restart a local shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, container, waitingForContainer, pod?.name, pod?.ns, pod ? ctx : '']);

  // The shell follows the tab's context and namespace.
  useEffect(() => {
    const ws = wsRef.current;
    if (!pod && status === 'ready' && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'scope', ctx, ns }));
  }, [ctx, ns, status, pod]);

  useEffect(() => {
    if (visible && focused && !confirm) termRef.current?.focus();
  }, [visible, focused, confirm, status]);

  const answer = (ok: boolean) => {
    const c = confirm;
    if (!c) return;
    wsRef.current?.send(JSON.stringify({ type: 'confirm', id: c.id, ok }));
    setConfirm(undefined);
  };

  return (
    <div className="term-screen">
      <div className="term-bar">
        <Icon name="terminal" size={14} />
        <span className="mono small term-command" title={command}>{command || (pod ? `kubectl exec ${pod.name}` : t('term.shell'))}</span>
        {pod && containers.length > 1 && (
          <select className="term-select" value={container ?? ''} onChange={(e) => setContainer(e.target.value)} title={t('term.container')}>
            {containers.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        {!pty && status === 'ready' && <Badge tone="warn" title={t('term.simpleHint')}>{t('term.simple')}</Badge>}
        <span className="spacer" />
        {status === 'connecting' && <Spinner small />}
        <button className="btn btn-ghost btn-sm" onClick={() => setRun((n) => n + 1)} title={t('term.restart')}>
          <Icon name="restart" size={14} /><span className="label">{t('term.restart')}</span>
        </button>
      </div>
      {error && <div className="term-error"><ErrorBanner error={error} onRetry={() => setRun((n) => n + 1)} /></div>}
      {podObj.error && <div className="term-error"><ErrorBanner error={podObj.error} onRetry={podObj.reload} /></div>}
      <div className="term-host" ref={host} />

      {confirm && (
        <div className="modal-backdrop">
          <div className="modal modal-danger" role="dialog" aria-modal="true">
            <header className="modal-head">
              <h3>{t('term.confirmTitle')}</h3>
              <button className="btn btn-ghost" onClick={() => answer(false)}><Icon name="close" /></button>
            </header>
            <div className="modal-body">
              <div className="ctx-line">
                {t('actionDialog.context')} <strong>{confirm.ctx}</strong>
                <span className="protected-tag"><Icon name="lock" size={12} /> {t('actionDialog.protected')}</span>
              </div>
              <p>{t(pod ? 'term.confirmExec' : 'term.confirmExplain')}</p>
              <div className="field">
                <span className="mono-label">{t('actionDialog.command')}</span>
                <pre className="cmd"><span className="prompt">$ </span>{confirm.command}</pre>
              </div>
              <label className="field">
                <span>{t('term.typeContext', { ctx: confirm.ctx })}</span>
                <input
                  autoFocus
                  className="confirm-input"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && typed === confirm.ctx) answer(true);
                    if (e.key === 'Escape') answer(false);
                  }}
                  placeholder={confirm.ctx}
                  spellCheck={false}
                />
              </label>
            </div>
            <footer className="modal-foot">
              <button className="btn btn-ghost" onClick={() => answer(false)}>{t('common.cancel')}</button>
              <button className="btn btn-danger" disabled={typed !== confirm.ctx} onClick={() => answer(true)}>{t('term.run')}</button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
