/**
 * Tests for tsconfig path-alias resolution — the pure `resolveImportSpecifier`
 * and the fail-soft `loadAliasConfig` (JSONC-tolerant tsconfig reader).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EMPTY_ALIAS_CONFIG,
  loadAliasConfig,
  resolveImportSpecifier,
  type AliasConfig,
} from './tsconfig-paths.js';

describe('resolveImportSpecifier', () => {
  const aliased: AliasConfig = {
    baseUrl: '.',
    paths: {
      '@/*': ['src/*'],
      '@components/*': ['./src/components/*'],
      '@/lib/*': ['src/lib/*'],
      '@utils': ['src/utils/index.ts'],
    },
  };

  it('resolves relative specifiers against the importing file (prior behavior)', () => {
    expect(resolveImportSpecifier('../lib/mailer', 'src/api/server.ts', EMPTY_ALIAS_CONFIG)).toBe(
      'src/lib/mailer',
    );
    expect(resolveImportSpecifier('./helper.js', 'src/lib/index.ts', EMPTY_ALIAS_CONFIG)).toBe(
      'src/lib/helper.js',
    );
  });

  it('returns null for relative specifiers that escape the repo root', () => {
    expect(resolveImportSpecifier('../../outside', 'src/a.ts', EMPTY_ALIAS_CONFIG)).toBeNull();
  });

  it('resolves a `@/*` alias to its baseUrl-relative target', () => {
    expect(resolveImportSpecifier('@/lib/mailer', 'src/api/server.ts', aliased)).toBe(
      'src/lib/mailer',
    );
  });

  it('resolves `./`-prefixed alias targets cleanly', () => {
    expect(resolveImportSpecifier('@components/Button', 'src/pages/home.tsx', aliased)).toBe(
      'src/components/Button',
    );
  });

  it('prefers the longest static prefix among competing `*` patterns', () => {
    // `@/lib/*` (prefix `@/lib/`) must win over `@/*` (prefix `@/`).
    expect(resolveImportSpecifier('@/lib/mailer', 'src/x.ts', aliased)).toBe('src/lib/mailer');
  });

  it('resolves an exact (starless) alias', () => {
    expect(resolveImportSpecifier('@utils', 'src/x.ts', aliased)).toBe('src/utils/index.ts');
  });

  it('honors a non-root baseUrl for aliases and bare imports', () => {
    const config: AliasConfig = { baseUrl: 'src', paths: { '@/*': ['lib/*'] } };
    expect(resolveImportSpecifier('@/mailer', 'src/api.ts', config)).toBe('src/lib/mailer');
    expect(resolveImportSpecifier('components/Button', 'src/api.ts', config)).toBe(
      'src/components/Button',
    );
  });

  it('returns null for a bare package import when no baseUrl is configured', () => {
    expect(resolveImportSpecifier('react', 'src/app.tsx', EMPTY_ALIAS_CONFIG)).toBeNull();
    expect(resolveImportSpecifier('lodash/merge', 'src/app.tsx', EMPTY_ALIAS_CONFIG)).toBeNull();
  });

  it('returns null for an unmatched scoped package even under a baseUrl', () => {
    expect(resolveImportSpecifier('@tanstack/react-query', 'src/app.tsx', aliased)).toBeNull();
  });

  it('returns a candidate for a bare import under baseUrl (moduleOf filters non-local)', () => {
    // With baseUrl set, `react` resolves to the candidate `react`; the caller's
    // moduleOf existence check drops it because no module directory is named `react`.
    expect(resolveImportSpecifier('react', 'src/app.tsx', aliased)).toBe('react');
  });
});

describe('loadAliasConfig', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'tsconfig-paths-test-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('returns the empty config when no tsconfig.json exists', () => {
    expect(loadAliasConfig(repoRoot)).toEqual(EMPTY_ALIAS_CONFIG);
  });

  it('reads baseUrl and paths from compilerOptions', () => {
    writeFileSync(
      join(repoRoot, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'utf-8',
    );
    expect(loadAliasConfig(repoRoot)).toEqual({ baseUrl: '.', paths: { '@/*': ['src/*'] } });
  });

  it('tolerates JSONC comments and trailing commas', () => {
    writeFileSync(
      join(repoRoot, 'tsconfig.json'),
      [
        '{',
        '  // project config',
        '  "compilerOptions": {',
        '    "baseUrl": ".",',
        '    /* alias map */',
        '    "paths": { "@/*": ["src/*"], },',
        '  },',
        '}',
      ].join('\n'),
      'utf-8',
    );
    expect(loadAliasConfig(repoRoot)).toEqual({ baseUrl: '.', paths: { '@/*': ['src/*'] } });
  });

  it('fails soft to the empty config on unparseable content', () => {
    writeFileSync(join(repoRoot, 'tsconfig.json'), 'this is not json {{{', 'utf-8');
    expect(loadAliasConfig(repoRoot)).toEqual(EMPTY_ALIAS_CONFIG);
  });

  it('drops non-string and empty path targets', () => {
    writeFileSync(
      join(repoRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { paths: { '@/*': ['src/*'], '@bad/*': [], '@num/*': [42] } },
      }),
      'utf-8',
    );
    expect(loadAliasConfig(repoRoot)).toEqual({ baseUrl: null, paths: { '@/*': ['src/*'] } });
  });
});
