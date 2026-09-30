import { en, type Messages } from './en';
import { ptBR } from './pt-BR';

export type Language = 'en' | 'pt-BR';
export type MessageKey = keyof Messages;
export type Params = Record<string, string | number>;

const DICTIONARIES: Record<Language, Messages> = { en, 'pt-BR': ptBR };

export const LANGUAGES: Array<{ id: Language; label: string; short: string }> = [
  { id: 'en', label: 'English', short: 'EN' },
  { id: 'pt-BR', label: 'Português', short: 'PT' },
];

export function detectLanguage(): Language {
  return navigator.language?.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
}

// Module-level so non-React helpers (formatters, catalog columns) can translate too.
// The app re-renders from the top when the language changes.
let current: Language = detectLanguage();

export function setLanguage(lang: Language) {
  current = lang;
  document.documentElement.lang = lang;
}

export function getLanguage(): Language {
  return current;
}

function interpolate(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name) => (params[name] !== undefined ? String(params[name]) : m));
}

export function t(key: MessageKey, params?: Params): string {
  return interpolate(DICTIONARIES[current][key] ?? en[key] ?? key, params);
}

/** For keys built at runtime (error codes, field names); undefined when unknown. */
export function tryT(key: string, params?: Params): string | undefined {
  const text = (DICTIONARIES[current] as Record<string, string>)[key] ?? (en as Record<string, string>)[key];
  return text === undefined ? undefined : interpolate(text, params);
}
