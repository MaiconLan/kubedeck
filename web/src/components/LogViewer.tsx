import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { parseAnsi, stripAnsi, type AnsiStyle } from '../ansi';
import { api, type ApiError } from '../api';
import { t, type MessageKey } from '../i18n';
import { FindNav, marked, useFind } from './find';
import { ErrorBanner, Icon, Spinner } from './ui';

const MAX_LINES = 10_000;

interface Props {
  ctx: string;
  ns: string;
  /** "pods" or a workload type such as deployments.apps */
  type: string;
  name: string;
  containers: string[];
  initialPrevious?: boolean;
  initialContainer?: string;
}

export function LogViewer({ ctx, ns, type, name, containers, initialPrevious = false, initialContainer }: Props) {
  const isPod = type === 'pods';
  const [container, setContainer] = useState(initialContainer ?? (isPod ? containers[0] ?? '' : ''));
  const [tail, setTail] = useState(500);
  const [follow, setFollow] = useState(true);
  const [previous, setPrevious] = useState(initialPrevious);
  const [timestamps, setTimestamps] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [query, setQuery] = useState('');
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [status, setStatus] = useState<'connecting' | 'streaming' | 'ended'>('connecting');
  const [error, setError] = useState<ApiError>();
  const [warning, setWarning] = useState('');
  const [, setTick] = useState(0);
  const [session, setSession] = useState(0);

  const lines = useRef<string[]>([]);
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    lines.current = [];
    setError(undefined);
    setWarning('');
    setStatus('connecting');
    setTick((t) => t + 1);

    const es = new EventSource(api.logsUrl({ ctx, ns, type, name, container, tail, follow: follow ? 1 : 0, previous, timestamps }));
    es.addEventListener('start', () => setStatus('streaming'));
    es.addEventListener('lines', (e) => {
      const batch: string[] = JSON.parse((e as MessageEvent).data);
      const buf = lines.current;
      buf.push(...batch);
      if (buf.length > MAX_LINES) buf.splice(0, buf.length - MAX_LINES);
      setTick((t) => t + 1);
    });
    es.addEventListener('warning', (e) => setWarning(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('failure', (e) => setError(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('end', () => {
      setStatus('ended');
      es.close();
    });
    es.onerror = () => {
      setStatus('ended');
      es.close();
    };
    return () => es.close();
  }, [ctx, ns, type, name, container, tail, follow, previous, timestamps, session]);

  useLayoutEffect(() => {
    const el = body.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const q = query.trim().toLowerCase();
  const visible = q && onlyMatches ? lines.current.filter((l) => stripAnsi(l).toLowerCase().includes(q)) : lines.current;
  // Search what is on screen (without the timestamp column or color codes), and stop following the tail while navigating.
  const find = useFind(visible.map((l) => stripAnsi(splitLine(l, timestamps).message)), q, body, () => { stick.current = false; });

  const download = () => {
    const blob = new Blob([lines.current.map(stripAnsi).join('\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}${container ? `-${container}` : ''}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="logs">
      <div className="code-toolbar logs-toolbar">
        {(containers.length > 1 || !isPod) && (
          <select value={container} onChange={(e) => setContainer(e.target.value)} className="select-sm">
            {!isPod && <option value="">{t('logs.allContainers')}</option>}
            {containers.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <select value={tail} onChange={(e) => setTail(Number(e.target.value))} className="select-sm" title={t('logs.initialLines')}>
          {[100, 500, 2000, 10000].map((n) => <option key={n} value={n}>{t('logs.lastN', { n })}</option>)}
          <option value={-1}>{t('logs.everything')}</option>
        </select>
        <Toggle on={follow} set={setFollow} label={t('logs.follow')} />
        <Toggle on={timestamps} set={setTimestamps} label={t('logs.timestamps')} />
        {isPod && <Toggle on={previous} set={setPrevious} label={t('logs.previous')} title={t('logs.previousTitle')} />}
        <Toggle on={wrap} set={setWrap} label={t('logs.wrap')} />
        <div className="search-box">
          <Icon name="search" size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={find.onKeyDown} placeholder={t('logs.search')} />
          <FindNav find={find} />
        </div>
        {q && <Toggle on={onlyMatches} set={setOnlyMatches} label={t('logs.onlyMatches')} />}
        <span className="spacer" />
        <span className={`stream-state state-${status}`}>
          {status === 'connecting' ? <Spinner small /> : <span className="dot" />}
          {status === 'connecting' ? t('logs.connecting') : status === 'streaming' ? (follow ? t('logs.live') : t('logs.loaded')) : t('logs.ended')}
          <span className="muted"> · {t('logs.lines', { n: lines.current.length })}</span>
        </span>
        <button className="btn btn-ghost btn-sm" title={t('logs.reconnect')} onClick={() => setSession((s) => s + 1)}>
          <Icon name="refresh" size={14} /><span className="label">{t('btn.reconnect')}</span>
        </button>
        <button className="btn btn-ghost btn-sm" title={t('logs.download')} onClick={download}>
          <Icon name="download" size={14} /><span className="label">.log</span>
        </button>
      </div>
      {error && <ErrorBanner error={error} compact onRetry={() => setSession((s) => s + 1)} />}
      {warning && !error && <div className="log-warning">{warning}</div>}
      <div
        ref={body}
        className={`log-body${wrap ? ' wrap' : ''}${timestamps ? ' with-ts' : ''}`}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {/* The stream starts before kubectl prints anything, so "no lines" is only certain once it has ended. */}
        {visible.length === 0 && !error && (lines.current.length === 0 && status !== 'ended'
          ? <div className="log-empty log-waiting"><Spinner small /> {t('logs.waiting')}</div>
          : <div className="log-empty">{t('logs.empty')}</div>)}
        {visible.map((line, i) => <LogLine key={i} line={line} timestamps={timestamps} qLen={q.length} starts={find.startsIn(i)} activeStart={find.activeIn(i)} />)}
      </div>
      {!stick.current && (
        <button className="btn jump-bottom" onClick={() => {
          stick.current = true;
          if (body.current) body.current.scrollTop = body.current.scrollHeight;
        }}>
          <Icon name="arrowDown" /> {t('logs.jumpBottom')}
        </button>
      )}
    </div>
  );
}

function Toggle({ on, set, label, title }: { on: boolean; set: (v: boolean) => void; label: string; title?: string }) {
  return (
    <button className={`chip${on ? ' chip-on' : ''}`} onClick={() => set(!on)} title={title}>
      {label}
    </button>
  );
}

type Level = 'err' | 'warn' | 'info' | 'debug';

const LEVEL_LABEL: Record<Level, MessageKey> = {
  err: 'logs.level.err',
  warn: 'logs.level.warn',
  info: 'logs.level.info',
  debug: 'logs.level.debug',
};

function lineLevel(line: string): Level | null {
  if (/\b(ERROR|ERR|FATAL|PANIC|CRITICAL|Exception|Traceback)\b|"level":"(error|fatal)"|level=(error|fatal)/i.test(line)) return 'err';
  if (/\b(WARN|WARNING)\b|"level":"warn|level=warn/i.test(line)) return 'warn';
  if (/\b(DEBUG|DBG|TRACE)\b|"level":"(debug|trace)"|level=(debug|trace)/i.test(line)) return 'debug';
  if (/\b(INFO)\b|"level":"info"|level=info/i.test(line)) return 'info';
  return null;
}

// kubectl --timestamps puts an RFC3339 time first (after the [pod/container] prefix, if any).
const TS_RE = /^(\[[^\]]+\] )?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})) ?(.*)$/;

/** HH:MM:SS in local time; the full timestamp stays in the tooltip. */
function clock(ts: string): string {
  const d = new Date(ts);
  if (!ts || isNaN(d.getTime())) return '';
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Separates the kubectl timestamp from the message when the timestamp column is shown. */
function splitLine(line: string, timestamps: boolean): { ts: string; message: string } {
  const m = timestamps ? TS_RE.exec(line) : null;
  return m ? { ts: m[2], message: (m[1] ?? '') + m[3] } : { ts: '', message: line };
}

interface LogLineProps {
  line: string;
  timestamps: boolean;
  qLen: number;
  starts: number[] | undefined;
  activeStart: number;
}

function LogLine({ line, timestamps, qLen, starts, activeStart }: LogLineProps) {
  const { ts, message: raw } = splitLine(line, timestamps);
  const { text: message, runs } = parseAnsi(raw);
  const level = lineLevel(message);
  return (
    <div className={`log-line${level ? ` l-${level}` : ''}`}>
      {timestamps && <span className="log-ts" title={ts}>{clock(ts)}</span>}
      {level ? <span className={`lvl lvl-${level}`}>{t(LEVEL_LABEL[level])}</span> : <span />}
      <span className="log-msg">
        {message
          ? runs.map((r) => {
              const content = marked(r.text, r.offset, starts, qLen, activeStart);
              return r.style ? <span key={r.offset} className={ansiClass(r.style)} style={ansiInline(r.style)}>{content}</span> : <span key={r.offset}>{content}</span>;
            })
          : ' '}
      </span>
    </div>
  );
}

function ansiClass(s: AnsiStyle): string | undefined {
  const c = [
    s.fgIndex !== undefined && `ansi-fg-${s.fgIndex}`,
    s.bgIndex !== undefined && `ansi-bg-${s.bgIndex}`,
    s.bold && 'ansi-bold',
    s.dim && 'ansi-dim',
    s.italic && 'ansi-italic',
    s.underline && 'ansi-underline',
  ].filter(Boolean);
  return c.length ? c.join(' ') : undefined;
}

function ansiInline(s: AnsiStyle): CSSProperties | undefined {
  return s.fg || s.bg ? { color: s.fg, backgroundColor: s.bg } : undefined;
}

