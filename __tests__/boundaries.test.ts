/**
 * Package-boundary invariants for @aibar/* (docs/aibar-architecture.md §2.2, INV-A4).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKGS = ['protocol', 'core', 'intent', 'renderer-dom', 'react', 'devtools'] as const;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'dist' || entry === 'node_modules') continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\./.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

const DOM_GLOBALS = /\b(window|document|navigator|requestAnimationFrame|HTMLElement)\b/;
const REACT_IMPORT = /from\s+['"]react(-dom)?['"]/;
const RELATIVE_IMPORT = /from\s+['"](\.\.?\/[^'"]*)['"]/g;

function pkgSrc(name: string): string {
  return join(PACKAGES_ROOT, name, 'src');
}

describe('AIBar package boundaries', () => {
  for (const pkg of ['protocol', 'core', 'intent'] as const) {
    it(`${pkg}/ contains no DOM globals and no React (INV-A4)`, () => {
      const offenders: string[] = [];
      for (const file of sourceFiles(pkgSrc(pkg))) {
        const raw = readFileSync(file, 'utf8');
        const domHit = codeOnly(raw).match(DOM_GLOBALS);
        if (domHit) offenders.push(`${file}: DOM global \`${domHit[1]}\``);
        if (REACT_IMPORT.test(raw)) offenders.push(`${file}: imports react`);
      }
      expect(offenders).toEqual([]);
    });
  }

  it('renderer-dom/ does not import React', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(pkgSrc('renderer-dom'))) {
      if (REACT_IMPORT.test(readFileSync(file, 'utf8'))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('no package imports LeAgent host code', () => {
    const offenders: string[] = [];
    for (const pkg of PKGS) {
      for (const file of sourceFiles(pkgSrc(pkg))) {
        const raw = readFileSync(file, 'utf8');
        const aliasImports = raw.match(/from\s+['"]@\/[^'"]*['"]/g) ?? [];
        for (const imp of aliasImports) offenders.push(`${file}: ${imp}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('relative imports never escape a package src root', () => {
    const offenders: string[] = [];
    for (const pkg of PKGS) {
      const srcRoot = pkgSrc(pkg);
      for (const file of sourceFiles(srcRoot)) {
        const raw = readFileSync(file, 'utf8');
        const relDir = relative(srcRoot, dirname(file));
        const depth = !relDir || relDir === '.' ? 0 : relDir.split(/[\\/]/).length;
        RELATIVE_IMPORT.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = RELATIVE_IMPORT.exec(raw))) {
          const spec = match[1]!;
          const up = spec.match(/^(\.\.\/)+/);
          const upCount = up ? up[0].length / 3 : 0;
          if (upCount > depth) offenders.push(`${file}: ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('dependency direction is protocol ← core ← others', () => {
    const forbidden: Record<string, string[]> = {
      protocol: ['@aibar/core', '@aibar/intent', '@aibar/renderer-dom', '@aibar/react', '@aibar/devtools'],
      core: ['@aibar/intent', '@aibar/renderer-dom', '@aibar/react', '@aibar/devtools'],
      intent: ['@aibar/renderer-dom', '@aibar/react', '@aibar/devtools'],
      'renderer-dom': ['@aibar/react', '@aibar/devtools', '@aibar/intent'],
      react: ['@aibar/devtools', '@aibar/intent'],
      devtools: ['@aibar/react', '@aibar/renderer-dom', '@aibar/intent'],
    };
    const offenders: string[] = [];
    for (const [pkg, banned] of Object.entries(forbidden)) {
      for (const file of sourceFiles(pkgSrc(pkg))) {
        const raw = readFileSync(file, 'utf8');
        for (const name of banned) {
          if (raw.includes(`from '${name}'`) || raw.includes(`from "${name}"`)) {
            offenders.push(`${file}: ${name}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
