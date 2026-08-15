/**
 * Light / dark page scheme for the example hosts.
 * AIBar tokens come from `@aibar/core` reference themes — swap them in your app.
 */
import {
  DEFAULT_THEME_TOKENS_DARK,
  DEFAULT_THEME_TOKENS_LIGHT,
} from '@aibar/core';

export type ColorScheme = 'light' | 'dark';

const STORAGE_KEY = 'aibar-example-theme';

export function detectScheme(): ColorScheme {
  try {
    const q = new URLSearchParams(window.location.search).get('theme');
    if (q === 'light' || q === 'dark') return q;
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // private mode / non-browser
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyScheme(scheme: ColorScheme): void {
  document.documentElement.dataset.theme = scheme;
  document.documentElement.style.colorScheme = scheme;
  try {
    localStorage.setItem(STORAGE_KEY, scheme);
  } catch {
    // quota
  }
}

export function createThemeController() {
  let scheme = detectScheme();
  applyScheme(scheme);
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const fn of listeners) fn();
  };
  return {
    get: (): ColorScheme => scheme,
    set(next: ColorScheme) {
      if (next === scheme) return;
      scheme = next;
      applyScheme(scheme);
      notify();
    },
    toggle() {
      this.set(scheme === 'dark' ? 'light' : 'dark');
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    adapterTheme: {
      tokens: () =>
        scheme === 'dark' ? DEFAULT_THEME_TOKENS_DARK : DEFAULT_THEME_TOKENS_LIGHT,
      subscribe: (onChange: () => void) => {
        listeners.add(onChange);
        return () => {
          listeners.delete(onChange);
        };
      },
    },
  };
}

export type ThemeController = ReturnType<typeof createThemeController>;
