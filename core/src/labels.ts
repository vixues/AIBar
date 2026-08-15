/**
 * Kernel-synthesized chrome strings (docs/aibar-architecture.md §10).
 *
 * Hosts override via `AIBarHostAdapter.resolveLabel`. When the host returns
 * the raw key (or an empty string), these English fallbacks are used so a
 * third-party embed is not forced to ship an i18n catalog.
 */
export const DEFAULT_CHROME_LABELS: Readonly<Record<string, string>> = {
  'aibar.overflowOpenPalette': 'More commands',
  'aibar.overflowCount': '{count} more',
  'aibar.collapse': 'Collapse',
  'aibar.runningMany': '{count} running',
  'aibar.systemExpand': 'Show more',
  'aibar.systemCollapse': 'Show less',
  'aibar.deny': 'Deny',
  'aibar.allow': 'Allow',
  'aibar.dismiss': 'Dismiss {label}',
  'aibar.suggestionAria': 'AI suggestion',
  'aibar.suggestionAriaWithReason': 'AI suggestion: {reason}',
};

export function formatChromeLabel(
  key: string,
  opts?: Record<string, unknown>,
): string | undefined {
  const template = DEFAULT_CHROME_LABELS[key];
  if (!template) return undefined;
  if (!opts) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    opts[name] == null ? '' : String(opts[name]),
  );
}

/**
 * Prefer the host string when it is a real translation; otherwise the
 * in-package English catalog; otherwise the raw key.
 */
export function resolveChromeLabel(
  resolve: (key: string, opts?: Record<string, unknown>) => string,
  key: string,
  opts?: Record<string, unknown>,
): string {
  const host = resolve(key, opts);
  if (host && host !== key) return host;
  return formatChromeLabel(key, opts) ?? host ?? key;
}
