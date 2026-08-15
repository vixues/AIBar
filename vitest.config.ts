import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@aibar/protocol': join(root, 'protocol/src/index.ts'),
      '@aibar/core': join(root, 'core/src/index.ts'),
      '@aibar/intent': join(root, 'intent/src/index.ts'),
      '@aibar/renderer-dom': join(root, 'renderer-dom/src/index.ts'),
      '@aibar/renderer-dom/styles.css': join(root, 'renderer-dom/src/styles.css'),
      '@aibar/react': join(root, 'react/src/index.ts'),
      '@aibar/devtools': join(root, 'devtools/src/index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['__tests__/**/*.test.ts'],
    setupFiles: ['__tests__/setup.ts'],
  },
});
