/**
 * Generic example catalog — one of each common AIBar type, not a product clone.
 * Hosts should replace these items with their own actions, labels, and icons.
 */
import {
  asItemIdentifier,
  defineItem,
  type AIBarItemIdentifier,
  type AIBarKernel,
  type ScrubberEntry,
} from '@aibar/core';
import { DEMO_EMOJI_CATEGORIES } from './emoji';

export const DEMO_IDS = {
  send: asItemIdentifier('com.example.aibar.mainbutton.send'),
  attach: asItemIdentifier('com.example.aibar.button.attach'),
  tools: asItemIdentifier('com.example.aibar.popover.tools'),
  thinking: asItemIdentifier('com.example.aibar.popover.thinking'),
  emoji: asItemIdentifier('com.example.aibar.popover.emoji'),
  status: asItemIdentifier('com.example.aibar.livestatus.run'),
  clear: asItemIdentifier('com.example.aibar.button.clear'),
  settings: asItemIdentifier('com.example.aibar.button.settings'),
} as const;

const EMOJI_CATEGORY_ID = asItemIdentifier('com.example.aibar.segmented.emoji-category');
const EMOJI_SCRUBBER_ID = asItemIdentifier('com.example.aibar.scrubber.emoji');

export type DemoThinking = 'Auto' | 'Off' | 'Low' | 'High' | 'Max';
export type DemoPhase = 'thinking' | 'answering';
export type DemoMessage = { role: 'user' | 'assistant'; text: string };

/** Seeded thread so the playground (and README screenshots) look like a product. */
export const SEED_MESSAGES: DemoMessage[] = [
  {
    role: 'user',
    text: 'How do I embed AIBar in a notes app?',
  },
  {
    role: 'assistant',
    text: 'Implement AIBarHostAdapter — dispatchAction, resolveIcon, and theme.tokens(). Register your own items. Agents publish Item Specs; they never ship host functions.',
  },
];

export type DemoSnap = {
  thinking: DemoThinking;
  emojiCategory: string;
  busy: boolean;
  phase: DemoPhase;
  progress: number;
  insertText: (token: string) => void;
};

const THINKING: readonly DemoThinking[] = ['Auto', 'Off', 'Low', 'High', 'Max'];

const ICON_CHIP = { min: 28, preferred: 32, max: 36 } as const;
const EMOJI_TAB_W = 28;
const EMOJI_CELL_W = 34;

function glyphsFor(categoryId: string): readonly string[] {
  const cat =
    DEMO_EMOJI_CATEGORIES.find((c) => c.id === categoryId) ?? DEMO_EMOJI_CATEGORIES[0];
  return cat?.glyphs ?? [];
}

export function demoDefinition(customizationIdentifier: string) {
  return {
    customizationIdentifier,
    defaultItemIdentifiers: [
      DEMO_IDS.send,
      DEMO_IDS.attach,
      DEMO_IDS.tools,
      DEMO_IDS.thinking,
      DEMO_IDS.emoji,
      DEMO_IDS.status,
      DEMO_IDS.clear,
      DEMO_IDS.settings,
    ] satisfies AIBarItemIdentifier[],
    principalItemIdentifier: DEMO_IDS.send,
    overflowAction: { name: 'host.openCommandPalette' },
  };
}

export function registerDemoCatalog(kernel: AIBarKernel, snap: DemoSnap): void {
  kernel.register(
    defineItem({
      id: DEMO_IDS.send,
      type: 'mainButton',
      labelKey: 'Send',
      showsLabel: true,
      parity: 'shortcut:app.send',
      visibilityPriority: 1100,
      width: { min: 40, preferred: 52, max: 72 },
      text: () => (snap.busy ? 'Stop' : 'Send'),
      action: { name: 'app.send' },
    }),
  );

  kernel.register(
    defineItem({
      id: DEMO_IDS.attach,
      type: 'button',
      labelKey: 'Attach',
      icon: 'paperclip',
      showsLabel: false,
      parity: 'none:demo-attach',
      visibilityPriority: 900,
      width: ICON_CHIP,
      action: { name: 'app.attach' },
    }),
  );

  kernel.register(
    defineItem({
      id: DEMO_IDS.tools,
      type: 'popover',
      labelKey: 'Tools',
      icon: 'wrench',
      showsLabel: false,
      parity: 'none:demo-tools',
      visibilityPriority: 880,
      width: ICON_CHIP,
      children: [
        defineItem({
          id: asItemIdentifier('com.example.aibar.button.tool.search'),
          type: 'button',
          labelKey: 'Search',
          icon: 'search',
          showsLabel: true,
          parity: 'none:demo-search',
          width: { min: 72, preferred: 120, max: 180 },
          action: { name: 'app.insert', params: { token: '/search ' } },
        }),
        defineItem({
          id: asItemIdentifier('com.example.aibar.button.tool.image'),
          type: 'button',
          labelKey: 'Image',
          icon: 'image',
          showsLabel: true,
          parity: 'none:demo-image',
          width: { min: 72, preferred: 120, max: 180 },
          action: { name: 'app.insert', params: { token: '/image ' } },
        }),
        defineItem({
          id: asItemIdentifier('com.example.aibar.button.tool.code'),
          type: 'button',
          labelKey: 'Code',
          icon: 'code',
          showsLabel: true,
          parity: 'none:demo-code',
          width: { min: 72, preferred: 120, max: 180 },
          action: { name: 'app.insert', params: { token: '/code ' } },
        }),
      ],
    }),
  );

  kernel.register(
    defineItem({
      id: DEMO_IDS.thinking,
      type: 'popover',
      expand: 'inline',
      labelKey: 'Thinking',
      showsLabel: true,
      parity: 'none:demo-thinking',
      visibilityPriority: 910,
      width: { min: 48, preferred: 64, max: 88 },
      text: () => snap.thinking,
      children: THINKING.map((value) =>
        defineItem({
          id: asItemIdentifier(
            `com.example.aibar.button.thinking.${value.toLowerCase()}`,
          ),
          type: 'button',
          labelKey: value,
          showsLabel: true,
          active: () => snap.thinking === value,
          parity: 'none:demo-thinking',
          width: { min: 48, preferred: 64, max: 88 },
          onInvoke: () => {
            snap.thinking = value;
          },
        }),
      ),
    }),
  );

  const tabCount = DEMO_EMOJI_CATEGORIES.length;
  kernel.register(
    defineItem({
      id: DEMO_IDS.emoji,
      type: 'popover',
      labelKey: 'Emoji',
      icon: 'smile',
      showsLabel: false,
      parity: 'none:demo-emoji',
      visibilityPriority: 870,
      width: ICON_CHIP,
      children: [
        defineItem({
          id: EMOJI_CATEGORY_ID,
          type: 'segmented',
          labelKey: 'Emoji category',
          parity: 'none:demo-emoji-category',
          showsLabel: false,
          visibilityPriority: 1000,
          width: {
            min: Math.min(120, tabCount * 22),
            preferred: tabCount * EMOJI_TAB_W,
            max: tabCount * 34,
          },
          segments: DEMO_EMOJI_CATEGORIES.map((cat) => ({
            key: cat.id,
            labelKey: cat.label,
            glyph: cat.tabGlyph,
          })),
          selectedSegment: () => snap.emojiCategory,
          onSelectSegment: (_ctx, key) => {
            snap.emojiCategory = key;
            if (kernel.activeSubSurfaceTrigger() === DEMO_IDS.emoji) {
              kernel.openPopover(DEMO_IDS.emoji);
              kernel.inputSink().scrubTo?.(EMOJI_SCRUBBER_ID, 0);
            }
          },
        }),
        defineItem({
          id: EMOJI_SCRUBBER_ID,
          type: 'scrubber',
          labelKey: 'Emoji',
          parity: 'none:demo-emoji-scrubber',
          width: { min: 160, preferred: 400, max: 640, flex: 2 },
          scrubber: {
            dataSource: {
              count: () => glyphsFor(snap.emojiCategory).length,
              itemAt: (i): ScrubberEntry => {
                const g = glyphsFor(snap.emojiCategory)[i] ?? '';
                return { label: g, data: g };
              },
              keyOf: (_e, i) => `${snap.emojiCategory}:${i}`,
            },
            delegate: {
              selectionMode: 'none',
              layout: { kind: 'fixed', itemWidth: EMOJI_CELL_W },
              onSelect: (_index, entry) => {
                const glyph = typeof entry.data === 'string' ? entry.data : entry.label;
                if (glyph) snap.insertText(glyph);
              },
            },
          },
        }),
      ],
    }),
  );

  kernel.register(
    defineItem({
      id: DEMO_IDS.status,
      type: 'liveStatus',
      labelKey: 'Status',
      parity: 'none:demo-status',
      visibilityPriority: 820,
      width: { min: 48, preferred: 72, max: 96 },
      zone: 'system',
      text: (ctx) => ctx.runs?.[0]?.label ?? 'Idle',
    }),
  );

  kernel.register(
    defineItem({
      id: DEMO_IDS.clear,
      type: 'button',
      labelKey: 'Clear',
      icon: 'trash',
      showsLabel: true,
      parity: 'none:demo-clear',
      effect: 'destructive',
      visibilityPriority: -200,
      action: { name: 'app.clear' },
    }),
  );

  kernel.register(
    defineItem({
      id: DEMO_IDS.settings,
      type: 'button',
      labelKey: 'Settings',
      icon: 'settings',
      showsLabel: true,
      parity: 'none:demo-settings',
      visibilityPriority: -400,
      action: { name: 'app.settings' },
    }),
  );
}
