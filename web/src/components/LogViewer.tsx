import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api, type ApiError } from '../api';
import { ErrorBanner, Icon, Spinner } from './ui';

const MAX_LINES = 10_000;

interface Props {
  ctx: string;
  ns: string;
  /** "pods" or a workload type such as deployments.apps */
  type: string;
  name: string;
  containers: string[];
}

export function LogViewer({ ctx, ns, type, name, containers }: Props) {
  const isPod = type === 'pods';
  const [container, setContainer] = useState(isPod ? containers[0] ?? '' : '');
  const [tail, setTail] = useState(500);
  const [follow, setFollow] = useState(true);
  const [previous, setPrevious] = useState(false);
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
  const visible = q && onlyMatches ? lines.current.filter((l) => l.toLowerCase().includes(q)) : lines.current;

  const download = () => {
    const blob = new Blob([lines.current.join('\n')], { type: 'text/plain' });
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
            {!isPod && <option value="">Todos os containers</option>}
            {containers.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <select value={tail} onChange={(e) => setTail(Number(e.target.value))} className="select-sm" title="Linhas iniciais">
          {[100, 500, 2000, 10000].map((n) => <option key={n} value={n}>últimas {n}</option>)}
          <option value={-1}>tudo</option>
        </select>
        <Toggle on={follow} set={setFollow} label="Seguir" />
        <Toggle on={timestamps} set={setTimestamps} label="Horário" />
        {isPod && <Toggle on={previous} set={setPrevious} label="Anterior" title="Logs do container antes do último restart" />}
        <Toggle on={wrap} set={setWrap} label="Quebrar" />
        <div className="search-box">
          <Icon name="search" size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar nos logs" />
        </div>
        {q && <Toggle on={onlyMatches} set={setOnlyMatches} label="Só resultados" />}
        <span className="spacer" />
        <span className={`stream-state state-${status}`}>
          {status === 'connecting' ? <Spinner small /> : <span className="dot" />}
          {status === 'connecting' ? 'conectando' : status === 'streaming' ? (follow ? 'ao vivo' : 'carregado') : 'encerrado'}
          <span className="muted"> · {lines.current.length} linhas</span>
        </span>
        <button className="btn btn-ghost btn-sm" title="Reconectar" onClick={() => setSession((s) => s + 1)}><Icon name="refresh" /></button>
        <button className="btn btn-ghost btn-sm" title="Baixar .log" onClick={download}><Icon name="download" /></button>
      </div>
      {error && <ErrorBanner error={error} compact onRetry={() => setSession((s) => s + 1)} />}
      {warning && !error && <div className="log-warning">{warning}</div>}
      <div
        ref={body}
        className={`log-body${wrap ? ' wrap' : ''}`}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {visible.length === 0 && status !== 'connecting' && !error && <div className="log-empty">Nenhuma linha de log.</div>}
        {visible.map((line, i) => (
          <div key={i} className={`log-line ${lineTone(line)}`}>{highlight(line, q)}</div>
        ))}
      </div>
      {!stick.current && (
        <button className="btn jump-bottom" onClick={() => {
          stick.current = true;
          if (body.current) body.current.scrollTop = body.current.scrollHeight;
        }}>
          <Icon name="arrowDown" /> Ir para o fim
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

function lineTone(line: string): string {
  if (/\b(ERROR|ERR|FATAL|PANIC|CRITICAL|Exception|Traceback)\b|"level":"(error|fatal)"|level=(error|fatal)/i.test(line)) return 'l-err';
  if (/\b(WARN|WARNING)\b|"level":"warn|level=warn/i.test(line)) return 'l-warn';
  return '';
}

function highlight(line: string, q: string): ReactNode {
  if (!q) return line || ' ';
  const lower = line.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  let idx = lower.indexOf(q);
  while (idx >= 0) {
    parts.push(line.slice(from, idx), <mark key={idx}>{line.slice(idx, idx + q.length)}</mark>);
    from = idx + q.length;
    idx = lower.indexOf(q, from);
  }
  parts.push(line.slice(from));
  return parts;
}
