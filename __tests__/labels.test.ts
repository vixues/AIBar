/**
 * Chrome label fallbacks (docs/aibar-architecture.md §10).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHROME_LABELS,
  createDefaultHostAdapter,
  formatChromeLabel,
  resolveChromeLabel,
} from '@aibar/core';

describe('DEFAULT_CHROME_LABELS', () => {
  it('interpolates count placeholders', () => {
    expect(formatChromeLabel('aibar.overflowCount', { count: 3 })).toBe('3 more');
    expect(formatChromeLabel('aibar.runningMany', { count: 4 })).toBe('4 running');
  });

  it('prefers a host translation over the English catalog', () => {
    expect(
      resolveChromeLabel((key) => `L(${key})`, 'aibar.collapse'),
    ).toBe('L(aibar.collapse)');
  });

  it('falls back when the host echoes the raw key', () => {
    expect(resolveChromeLabel((key) => key, 'aibar.collapse')).toBe('Collapse');
    expect(resolveChromeLabel((key) => key, 'aibar.deny')).toBe('Deny');
  });

  it('maps named icon refs to Lucide-style SVG, and keeps emoji as text', () => {
    const adapter = createDefaultHostAdapter({
      dispatchAction: async () => ({ ok: true }),
    });
    const send = adapter.resolveIcon('send');
    expect(send.kind).toBe('svg');
    if (send.kind === 'svg') {
      expect(send.svg).toContain('viewBox="0 0 24 24"');
      expect(send.svg).toContain('stroke="currentColor"');
    }
    expect(adapter.resolveIcon('paperclip').kind).toBe('svg');
    expect(adapter.resolveIcon('👋')).toEqual({ kind: 'text', text: '👋' });
  });

  it('covers every kernel-synthesized chrome key', () => {
    expect(Object.keys(DEFAULT_CHROME_LABELS).sort()).toEqual(
      [
        'aibar.allow',
        'aibar.collapse',
        'aibar.deny',
        'aibar.dismiss',
        'aibar.overflowCount',
        'aibar.overflowOpenPalette',
        'aibar.runningMany',
        'aibar.suggestionAria',
        'aibar.suggestionAriaWithReason',
        'aibar.systemCollapse',
        'aibar.systemExpand',
      ].sort(),
    );
  });
});
