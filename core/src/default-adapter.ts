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

/** Named Lucide-style refs → a single glyph so default embeds are readable. */
const ICON_GLYPHS: Readonly<Record<string, string>> = {
  send: '➤',
  attach: '📎',
  paperclip: '📎',
  sparkles: '✦',
  settings: '⚙',
  trash: '⌫',
  command: '⌘',
  image: '🖼',
  smile: '☺',
};

function glyphIcon(ref: string): IconRenderable {
  const named = ICON_GLYPHS[ref.trim().toLowerCase()];
  if (named) return { kind: 'text', text: named };
  const chars = Array.from(ref.trim());
  if (chars.length === 0) return { kind: 'text', text: '·' };
  // Keep short emoji / glyphs intact (String.slice can split a surrogate pair).
  if (chars.length <= 2) return { kind: 'text', text: chars.join('') };
  return { kind: 'text', text: chars[0]! };
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
