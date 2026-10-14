import { useMemo, useRef, useState, type ReactNode } from 'react';
import { t } from '../i18n';
import { FindNav, marked, useFind } from './find';
import { CopyButton, Icon } from './ui';

/** Read-only code viewer with light YAML highlighting and in-text search. */
export function CodeBlock({ text, language = 'text', toolbar }: { text: string; language?: 'yaml' | 'text'; toolbar?: ReactNode }) {
  const [query, setQuery] = useState('');
  const [wrap, setWrap] = useState(false);
  const lines = useMemo(() => text.replace(/\n$/, '').split('\n'), [text]);
  const q = query.trim().toLowerCase();
  const body = useRef<HTMLPreElement>(null);
  const find = useFind(lines, q, body);

  return (
    <div className="code">
      <div className="code-toolbar">
        <div className="search-box">
          <Icon name="search" size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={find.onKeyDown} placeholder={t('common.searchText')} />
          <FindNav find={find} />
        </div>
        {toolbar}
        <span className="spacer" />
        <button className={`btn btn-ghost btn-sm${wrap ? ' active' : ''}`} onClick={() => setWrap(!wrap)} title={t('common.wrapLines')}>
          <Icon name="wrap" />
        </button>
        <CopyButton text={text} />
      </div>
      <pre ref={body} className={`code-body${wrap ? ' wrap' : ''}`}>
        {lines.map((line, i) => {
          const starts = find.startsIn(i);
          const activeStart = find.activeIn(i);
          const mk = (text: string, offset: number) => marked(text, offset, starts, q.length, activeStart);
          return (
            <div key={i} className={`code-line${starts ? ' hit' : ''}`}>
              <span className="ln">{i + 1}</span>
              <span className="lc">{language === 'yaml' ? yamlLine(line, mk) : mk(line, 0) || ' '}</span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}

const KEY_RE = /^(\s*(?:-\s+)?)([^\s#:'"][^:#]*?|"[^"]*"|'[^']*')(:)(\s+|$)(.*)$/;

/** Wraps the part of a line that starts at `offset` (search highlight). */
type Mark = (text: string, offset: number) => ReactNode;

function yamlLine(line: string, mk: Mark): ReactNode {
  if (/^\s*#/.test(line)) return <span className="y-comment">{mk(line, 0)}</span>;
  if (/^---\s*$/.test(line)) return <span className="y-comment">{mk(line, 0)}</span>;
  const m = KEY_RE.exec(line);
  if (m) {
    const keyAt = m[1].length;
    const colonAt = keyAt + m[2].length;
    const gapAt = colonAt + m[3].length;
    const valueAt = gapAt + m[4].length;
    return (
      <>
        {mk(m[1], 0)}
        <span className="y-key">{mk(m[2], keyAt)}</span>
        <span className="y-punct">{mk(m[3], colonAt)}</span>
        {mk(m[4], gapAt)}
        {yamlValue(m[5], mk, valueAt)}
      </>
    );
  }
  const item = /^(\s*-\s+)(.*)$/.exec(line);
  if (item) return <>{mk(item[1], 0)}{yamlValue(item[2], mk, item[1].length)}</>;
  return mk(line, 0) || ' ';
}

function yamlValue(value: string, mk: Mark, at: number): ReactNode {
  if (!value) return null;
  const text = mk(value, at);
  if (/^(true|false|null|~)$/.test(value)) return <span className="y-bool">{text}</span>;
  if (/^-?\d+(\.\d+)?$/.test(value)) return <span className="y-num">{text}</span>;
  if (/^["']/.test(value)) return <span className="y-str">{text}</span>;
  if (/^[|>][-+]?$/.test(value)) return <span className="y-punct">{text}</span>;
  return <span className="y-val">{text}</span>;
}
