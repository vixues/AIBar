/**
 * Compact emoji sets for the playground scrubber (iOS keyboard lineage).
 * Tabs are glyph-only; hosts should replace this with their own catalog.
 */
export interface DemoEmojiCategory {
  id: string;
  label: string;
  tabGlyph: string;
  glyphs: readonly string[];
}

export const DEMO_EMOJI_CATEGORIES: readonly DemoEmojiCategory[] = [
  {
    id: 'frequent',
    label: 'Frequent',
    tabGlyph: '🕒',
    glyphs: [
      '👍', '👎', '😀', '😂', '😍', '🤔', '😢', '🙏', '👏', '🔥',
      '✨', '⭐', '🎉', '✅', '💡', '🚀', '👀', '💯', '❤️', '💬',
    ],
  },
  {
    id: 'smileys',
    label: 'Smileys',
    tabGlyph: '😀',
    glyphs: [
      '😀', '😃', '😄', '😁', '😅', '🤣', '😂', '🙂', '😉', '😊',
      '😇', '🥰', '😍', '🤩', '😘', '😋', '😜', '🤔', '😐', '😏',
      '😒', '🙄', '😬', '😌', '😔', '😴', '😷', '🤯', '🤠', '🥳',
      '😎', '🤓', '😕', '😮', '😳', '🥺', '😢', '😭', '😤', '😡',
    ],
  },
  {
    id: 'gestures',
    label: 'Gestures',
    tabGlyph: '👋',
    glyphs: [
      '👋', '🤚', '✋', '🖖', '👌', '🤌', '✌️', '🤞', '🤟', '🤘',
      '🤙', '👈', '👉', '👆', '👇', '👍', '👎', '✊', '👊', '👏',
      '🙌', '🫶', '👐', '🤲', '🤝', '🙏', '💪', '✍️', '🫡', '👀',
    ],
  },
  {
    id: 'symbols',
    label: 'Symbols',
    tabGlyph: '💡',
    glyphs: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '💕',
      '💯', '💥', '💫', '⭐', '🌟', '✨', '🔥', '🎉', '✅', '❌',
      '⚠️', '❓', '💡', '📌', '💬', '🔒', '🔓', '➡️', '⬇️', '♻️',
    ],
  },
];
