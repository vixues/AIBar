import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

const envFree = ['protocol', 'core', 'intent'];

const aibarDomGlobals = [
  'window', 'document', 'navigator', 'localStorage', 'sessionStorage',
  'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver',
  'MutationObserver', 'IntersectionObserver', 'HTMLElement', 'Element',
  'CustomEvent', 'fetch', 'scheduler',
].map((name) => ({
  name,
  message: `INV-A4: no DOM/environment globals in this zone (use RendererBackend / HostAdapter for '${name}').`,
}));

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'examples/**'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true }, ecmaVersion: 'latest', sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: { 'no-undef': 'off' },
  },
  ...envFree.map((pkg) => ({
    files: [`${pkg}/src/**/*.{ts,tsx}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react-dom'], message: `${pkg} is environment-free (INV-A4).` },
          ],
        },
      ],
      'no-restricted-globals': ['error', ...aibarDomGlobals],
    },
  })),
  {
    files: ['renderer-dom/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['react', 'react-dom'], message: '@aibar/renderer-dom must not depend on React.' }] },
      ],
    },
  },
];
