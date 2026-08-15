import { defineConfig } from 'tsup';

export default function createTsupConfig(options: {
  entry?: string[];
  external?: (string | RegExp)[];
  banner?: Record<string, string>;
} = {}) {
  return defineConfig({
    entry: options.entry ?? ['src/index.ts'],
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    splitting: false,
    external: options.external ?? [/^@aibar\//, 'react', 'react-dom'],
    banner: options.banner,
  });
}
