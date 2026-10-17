/**
 * ANSI SGR (color/style) support for log lines. Many images (Bitnami, Spring Boot, ...) color their output;
 * kubectl passes the escape codes through. We split a line into its plain text, which is what search, copy and
 * level detection work on, and the style runs to paint over it.
 */

export interface AnsiStyle {
  /** Palette index 0-15, themed through CSS (`.ansi-fg-N`). */
  fgIndex?: number;
  bgIndex?: number;
  /** Literal colors for the 256-color cube and truecolor. */
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface AnsiRun {
  text: string;
  /** Offset of `text` within the plain line. */
  offset: number;
  style: AnsiStyle | null;
}

// CSI sequences: ESC [ params intermediates final. Only the SGR ones ("m") carry style.
const CSI_RE = /\x1b\[([0-9;:]*)([ -/]*)([@-~])/g;
// Any other escape we do not understand (OSC titles, charset selection, lone ESC) is dropped too.
const OTHER_ESC_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)?|[()][A-Za-z0-9]|[@-Z\\-_])/g;

export function hasAnsi(line: string): boolean {
  return line.includes('\x1b');
}

export function stripAnsi(line: string): string {
  return hasAnsi(line) ? line.replace(CSI_RE, '').replace(OTHER_ESC_RE, '') : line;
}

function cube(n: number): string | undefined {
  if (n < 0 || n > 255) return undefined;
  if (n < 16) return undefined; // handled by the themed palette
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const level = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${level(Math.floor(i / 36))},${level(Math.floor(i / 6) % 6)},${level(i % 6)})`;
}

function same(a: AnsiStyle | null, b: AnsiStyle | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.fgIndex === b.fgIndex && a.bgIndex === b.bgIndex && a.fg === b.fg && a.bg === b.bg
    && !!a.bold === !!b.bold && !!a.dim === !!b.dim && !!a.italic === !!b.italic && !!a.underline === !!b.underline;
}

function isEmpty(s: AnsiStyle): boolean {
  return s.fgIndex === undefined && s.bgIndex === undefined && !s.fg && !s.bg && !s.bold && !s.dim && !s.italic && !s.underline;
}

/** Applies one SGR parameter list to `cur` and returns the new style. */
function applySgr(cur: AnsiStyle, params: string): AnsiStyle {
  const codes = params === '' ? [0] : params.split(/[;:]/).map((p) => (p === '' ? 0 : Number(p)));
  const s: AnsiStyle = { ...cur };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) { for (const k of Object.keys(s) as (keyof AnsiStyle)[]) delete s[k]; }
    else if (c === 1) s.bold = true;
    else if (c === 2) s.dim = true;
    else if (c === 3) s.italic = true;
    else if (c === 4) s.underline = true;
    else if (c === 22) { delete s.bold; delete s.dim; }
    else if (c === 23) delete s.italic;
    else if (c === 24) delete s.underline;
    else if (c >= 30 && c <= 37) { s.fgIndex = c - 30; delete s.fg; }
    else if (c >= 90 && c <= 97) { s.fgIndex = c - 90 + 8; delete s.fg; }
    else if (c === 39) { delete s.fgIndex; delete s.fg; }
    else if (c >= 40 && c <= 47) { s.bgIndex = c - 40; delete s.bg; }
    else if (c >= 100 && c <= 107) { s.bgIndex = c - 100 + 8; delete s.bg; }
    else if (c === 49) { delete s.bgIndex; delete s.bg; }
    else if (c === 38 || c === 48) {
      const fgSide = c === 38;
      const mode = codes[i + 1];
      let idx: number | undefined;
      let lit: string | undefined;
      if (mode === 5) {
        const n = codes[i + 2];
        i += 2;
        if (n !== undefined && n < 16) idx = n;
        else if (n !== undefined) lit = cube(n);
      } else if (mode === 2) {
        const [r, g, b] = [codes[i + 2], codes[i + 3], codes[i + 4]];
        i += 4;
        if ([r, g, b].every((v) => v !== undefined && v >= 0 && v <= 255)) lit = `rgb(${r},${g},${b})`;
      } else continue;
      if (fgSide) { s.fgIndex = idx; s.fg = lit; if (idx === undefined) delete s.fgIndex; if (!lit) delete s.fg; }
      else { s.bgIndex = idx; s.bg = lit; if (idx === undefined) delete s.bgIndex; if (!lit) delete s.bg; }
    }
  }
  return s;
}

/** Plain text of `line` plus its style runs. Lines without escapes come back as a single unstyled run. */
export function parseAnsi(line: string): { text: string; runs: AnsiRun[] } {
  if (!hasAnsi(line)) return { text: line, runs: [{ text: line, offset: 0, style: null }] };

  const runs: AnsiRun[] = [];
  let style: AnsiStyle = {};
  let plainLen = 0;
  let pos = 0;

  const push = (raw: string) => {
    const text = raw.replace(OTHER_ESC_RE, '');
    if (!text) return;
    const st = isEmpty(style) ? null : style;
    const last = runs[runs.length - 1];
    if (last && same(last.style, st)) last.text += text;
    else runs.push({ text, offset: plainLen, style: st });
    plainLen += text.length;
  };

  for (const m of line.matchAll(CSI_RE)) {
    push(line.slice(pos, m.index));
    pos = m.index! + m[0].length;
    if (m[3] === 'm' && !m[2]) style = applySgr(style, m[1]);
  }
  push(line.slice(pos));

  return { text: runs.map((r) => r.text).join(''), runs };
}
