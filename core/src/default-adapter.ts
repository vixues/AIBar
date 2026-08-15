/**
 * Minimal host adapter for embeds that have not yet wired i18n, icons, or
 * persistence (docs/technical/aibar-host-guide.md).
 */
import { formatChromeLabel } from './labels';
import type {
  ActionInvocation,
  ActionOutcome,
  AIBarHostAdapter,
  IconRenderable,
} from './host-adapter';

export type DefaultHostAdapterOptions = Partial<AIBarHostAdapter> &
  Pick<AIBarHostAdapter, 'dispatchAction'>;

function glyphIcon(ref: string): IconRenderable {
  const ch = ref.trim();
  return { kind: 'text', text: ch ? ch.slice(0, 2) : '·' };
}

export function createMemoryPersistence(): AIBarHostAdapter['persistence'] {
  const store = new Map<string, unknown>();
  return {
    async load(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async save(key: string, value: unknown) {
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
    resolveIcon: glyphIcon,
    persistence: createMemoryPersistence(),
    ...overrides,
  };
}
