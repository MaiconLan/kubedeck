import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { demoEnabled } from './demo.js';

export interface Settings {
  protectedContexts: string[];
  refreshSeconds: number;
  theme: 'dark' | 'light';
  /** UI language; unset means "follow the browser". */
  language?: 'en' | 'pt-BR';
  lastContext?: string;
  lastNamespace: Record<string, string>;
  /** Namespaces typed by hand, for contexts where listing namespaces is forbidden. */
  knownNamespaces: Record<string, string[]>;
  contextColors: Record<string, string>;
  /** Saved tabs/panes of the main window; opaque to the server. */
  layout?: unknown;
}

const DEFAULTS: Settings = {
  protectedContexts: [],
  refreshSeconds: 5,
  theme: 'dark',
  lastNamespace: {},
  knownNamespaces: {},
  contextColors: {},
};

const DIR = join(homedir(), '.kubedeck');
const FILE = join(DIR, 'settings.json');

let cache: Settings | null = null;

// Demo mode keeps settings in memory, starting from a fixed state, and never touches ~/.kubedeck.
const DEMO_SETTINGS: Settings = {
  ...DEFAULTS,
  protectedContexts: ['prod-eu'],
  language: 'en',
  lastContext: 'local-dev',
  lastNamespace: { 'local-dev': '*', staging: 'apps', 'prod-eu': 'apps' },
};

export async function loadSettings(): Promise<Settings> {
  if (cache) return cache;
  if (demoEnabled()) {
    cache = structuredClone(DEMO_SETTINGS);
    return cache;
  }
  try {
    const raw = JSON.parse(await readFile(FILE, 'utf8'));
    cache = { ...DEFAULTS, ...raw };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache!;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next: Settings = { ...current };
  if (Array.isArray(patch.protectedContexts)) {
    next.protectedContexts = patch.protectedContexts.filter((c) => typeof c === 'string');
  }
  if (typeof patch.refreshSeconds === 'number' && patch.refreshSeconds >= 0 && patch.refreshSeconds <= 3600) {
    next.refreshSeconds = patch.refreshSeconds;
  }
  if (patch.theme === 'dark' || patch.theme === 'light') next.theme = patch.theme;
  if (patch.language === 'en' || patch.language === 'pt-BR') next.language = patch.language;
  if (patch.layout && typeof patch.layout === 'object' && JSON.stringify(patch.layout).length < 200_000) next.layout = patch.layout;
  if (typeof patch.lastContext === 'string') next.lastContext = patch.lastContext;
  if (isStringRecord(patch.lastNamespace)) next.lastNamespace = { ...current.lastNamespace, ...patch.lastNamespace };
  if (isStringRecord(patch.contextColors)) next.contextColors = { ...current.contextColors, ...patch.contextColors };
  if (patch.knownNamespaces && typeof patch.knownNamespaces === 'object') {
    next.knownNamespaces = { ...current.knownNamespaces };
    for (const [ctx, list] of Object.entries(patch.knownNamespaces)) {
      if (Array.isArray(list)) next.knownNamespaces[ctx] = list.filter((n) => typeof n === 'string').slice(0, 100);
    }
  }
  cache = next;
  if (demoEnabled()) return next;
  await mkdir(DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export async function isProtected(ctx: string): Promise<boolean> {
  return (await loadSettings()).protectedContexts.includes(ctx);
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return !!v && typeof v === 'object' && Object.values(v).every((x) => typeof x === 'string');
}
