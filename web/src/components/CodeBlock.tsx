import { useMemo, useState, type ReactNode } from 'react';
import { t } from '../i18n';
import { CopyButton, Icon } from './ui';

/** Read-only code viewer with light YAML highlighting and in-text search. */
export function CodeBlock({ text, language = 'text', toolbar }: { text: string; language?: 'yaml' | 'text'; toolbar?: ReactNode }) {
  const [query, setQuery] = useState('');
  const [wrap, setWrap] = useState(false);
  const lines = useMemo(() => text.replace(/\n$/, '').split('\n'), [text]);
  const q = query.trim().toLowerCase();
  const matches = q ? lines.filter((l) => l.toLowerCase().includes(q)).length : 0;

  return (
    <div className="code">
      <div className="code-toolbar">
        <div className="search-box">
          <Icon name="search" size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('common.searchText')} />
          {q && <span className="search-count">{matches}</span>}
        </div>
        {toolbar}
        <span className="spacer" />
        <button className={`btn btn-ghost btn-sm${wrap ? ' active' : ''}`} onClick={() => setWrap(!wrap)} title={t('common.wrapLines')}>
          <Icon name="wrap" />
        </button>
        <CopyButton text={text} />
      </div>
      <pre className={`code-body${wrap ? ' wrap' : ''}`}>
        {lines.map((line, i) => {
          const hit = q && line.toLowerCase().includes(q);
          return (
            <div key={i} className={`code-line${hit ? ' hit' : ''}`}>
              <span className="ln">{i + 1}</span>
              <span className="lc">{language === 'yaml' ? yamlLine(line) : line || ' '}</span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}

const KEY_RE = /^(\s*(?:-\s+)?)([^\s#:'"][^:#]*?|"[^"]*"|'[^']*')(:)(\s+|$)(.*)$/;

function yamlLine(line: string): ReactNode {
  if (/^\s*#/.test(line)) return <span className="y-comment">{line}</span>;
  if (/^---\s*$/.test(line)) return <span className="y-comment">{line}</span>;
  const m = KEY_RE.exec(line);
  if (m) {
    return (
      <>
        {m[1]}
        <span className="y-key">{m[2]}</span>
        <span className="y-punct">{m[3]}</span>
        {m[4]}
        {yamlValue(m[5])}
      </>
    );
  }
  const item = /^(\s*-\s+)(.*)$/.exec(line);
  if (item) return <>{item[1]}{yamlValue(item[2])}</>;
  return line || ' ';
}

function yamlValue(value: string): ReactNode {
  if (!value) return null;
  if (/^(true|false|null|~)$/.test(value)) return <span className="y-bool">{value}</span>;
  if (/^-?\d+(\.\d+)?$/.test(value)) return <span className="y-num">{value}</span>;
  if (/^["']/.test(value)) return <span className="y-str">{value}</span>;
  if (/^[|>][-+]?$/.test(value)) return <span className="y-punct">{value}</span>;
  return <span className="y-val">{value}</span>;
}
