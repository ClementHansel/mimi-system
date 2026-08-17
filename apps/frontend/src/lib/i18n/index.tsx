'use client';

import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { id } from './id';

/**
 * Bahasa Indonesia is the only locale (BUILD-PLAN §6.9) — there is no
 * language switcher and no second dictionary. The provider still exists (a)
 * so every string flows through one `t()` call site instead of being
 * hardcoded, and (b) so a second locale is a new dictionary file away, not a
 * rewrite of every component.
 *
 * Usage: `const { t } = useI18n(); t('common.save')`,
 * `t('validation.minValue', { min: 1 })` for `{{min}}`-style interpolation.
 */

type Params = Record<string, string | number>;

function resolvePath(dict: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, segment) => {
    if (node && typeof node === 'object' && segment in (node as Record<string, unknown>)) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, dict);
}

function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}

export function translate(key: string, params?: Params): string {
  const value = resolvePath(id, key);
  if (typeof value !== 'string') {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[i18n] missing key: "${key}"`);
    }
    return key;
  }
  return interpolate(value, params);
}

interface I18nCtx {
  /** Translate a dot-path key, e.g. t('nav.pos'), t('validation.minValue', { min: 1 }). */
  t: (key: string, params?: Params) => string;
  locale: 'id';
}

const I18nContext = createContext<I18nCtx>({ t: translate, locale: 'id' });

export function I18nProvider({ children }: { children: ReactNode }) {
  const t = useCallback((key: string, params?: Params) => translate(key, params), []);
  return <I18nContext.Provider value={{ t, locale: 'id' }}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nCtx {
  return useContext(I18nContext);
}

export type { Dictionary } from './id';
