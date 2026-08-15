/**
 * Minimal host adapter for embeds that have not yet wired i18n, icons, or
 * persistence (docs/aibar-host-guide.md).
 */
import { resolveDefaultIcon } from './icons';
import { formatChromeLabel } from './labels';
import type {
  ActionInvocation,
  ActionOutcome,
  AIBarHostAdapter,
} from './host-adapter';

export type DefaultHostAdapterOptions = Partial<AIBarHostAdapter> &
  Pick<AIBarHostAdapter, 'dispatchAction'>;

export { resolveDefaultIcon } from './icons';

/**
 * Dark reference tokens (ChatGPT-like charcoal shelf). Hosts override via
 * `adapter.theme`.
 */
export const DEFAULT_THEME_TOKENS_DARK: Readonly<Record<string, string>> = {
  '--aibar-surface-bg': 'hsl(0 0% 18%)',
  '--aibar-surface-border': 'hsl(0 0% 26%)',
  '--aibar-item-bg': 'hsl(0 0% 24%)',
  '--aibar-item-bg-hover': 'hsl(0 0% 29%)',
  '--aibar-item-bg-pressed': 'hsl(0 0% 20%)',
  '--aibar-item-bg-active': 'hsl(0 0% 32%)',
  '--aibar-item-fg': 'hsl(0 0% 93%)',
  '--aibar-item-fg-muted': 'hsl(0 0% 62%)',
  '--aibar-item-fg-disabled': 'hsl(0 0% 42%)',
  '--aibar-accent': 'hsl(0 0% 100%)',
  '--aibar-accent-fg': 'hsl(0 0% 10%)',
  '--aibar-suggestion': 'hsl(262 70% 72%)',
  '--aibar-danger': 'hsl(0 72% 58%)',
  '--aibar-live': 'hsl(168 70% 45%)',
  '--aibar-focus-ring': 'hsl(0 0% 100%)',
  '--aibar-item-radius': '10px',
  '--aibar-surface-radius': '16px',
};

/** Light reference tokens (white keys on a pale shelf). */
export const DEFAULT_THEME_TOKENS_LIGHT: Readonly<Record<string, string>> = {
  '--aibar-surface-bg': 'hsl(0 0% 94%)',
  '--aibar-surface-border': 'hsl(0 0% 88%)',
  '--aibar-item-bg': 'hsl(0 0% 100%)',
  '--aibar-item-bg-hover': 'hsl(0 0% 97%)',
  '--aibar-item-bg-pressed': 'hsl(0 0% 92%)',
  '--aibar-item-bg-active': 'hsl(0 0% 90%)',
  '--aibar-item-fg': 'hsl(0 0% 10%)',
  '--aibar-item-fg-muted': 'hsl(0 0% 45%)',
  '--aibar-item-fg-disabled': 'hsl(0 0% 62%)',
  '--aibar-accent': 'hsl(0 0% 10%)',
  '--aibar-accent-fg': 'hsl(0 0% 100%)',
  '--aibar-suggestion': 'hsl(262 55% 48%)',
  '--aibar-danger': 'hsl(0 72% 46%)',
  '--aibar-live': 'hsl(168 55% 32%)',
  '--aibar-focus-ring': 'hsl(0 0% 10%)',
  '--aibar-item-radius': '10px',
  '--aibar-surface-radius': '16px',
};

/** Alias of the dark reference theme. */
export const DEFAULT_THEME_TOKENS = DEFAULT_THEME_TOKENS_DARK;

export function createMemoryPersistence(): AIBarHostAdapter['persistence'] {
  const store = new Map<string, unknown>();
  return {
    async load(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    async save(key, value) {
      store.set(key, value);
    },
  };
}

export function createDefaultHostAdapter(
  options: DefaultHostAdapterOptions,
): AIBarHostAdapter {
  const { dispatchAction, ...overrides } = options;
  return {
    contextProviders: [],
    dispatchAction: (inv: ActionInvocation): Promise<ActionOutcome> =>
      dispatchAction(inv),
    resolveLabel: (key, opts) => formatChromeLabel(key, opts) ?? key,
    resolveIcon: resolveDefaultIcon,
    persistence: createMemoryPersistence(),
    theme: {
      tokens: () => DEFAULT_THEME_TOKENS_DARK,
      subscribe: () => () => {},
    },
    ...overrides,
  };
}
