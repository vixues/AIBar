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

  it('maps named icon refs to glyphs instead of truncated latin', () => {
    const adapter = createDefaultHostAdapter({
      dispatchAction: async () => ({ ok: true }),
    });
    expect(adapter.resolveIcon('send')).toEqual({ kind: 'text', text: '➤' });
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
