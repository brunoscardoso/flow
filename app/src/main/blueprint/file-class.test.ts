// Pure file-class matcher tests (#drift phase 2) — no fs/Electron, so these run
// under plain `npx jest` (node env, ts-jest CJS).

import { classifyFileClass } from './file-class'

describe('classifyFileClass — source', () => {
  it.each([
    'src/app.ts',
    'src/main/index.tsx',
    'lib/util.js',
    'scripts/build.mjs',
    'a/b/c.cjs',
    'server/main.py',
    'pkg/mod.go',
  ])('classifies %s as source', (path) => {
    expect(classifyFileClass(path)).toBe('source')
  })
})

describe('classifyFileClass — dependency', () => {
  it.each(['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'app/package.json'])(
    'classifies %s as dependency',
    (path) => {
      expect(classifyFileClass(path)).toBe('dependency')
    },
  )
})

describe('classifyFileClass — schema', () => {
  it.each([
    'prisma/schema.prisma',
    'db/schema.sql',
    'src/migrations/001_init.ts',
    'prisma/seed.ts',
    'server/migrations/add_users.sql',
  ])('classifies %s as schema', (path) => {
    expect(classifyFileClass(path)).toBe('schema')
  })
})

describe('classifyFileClass — config', () => {
  it.each([
    'tsconfig.json',
    'tsconfig.base.json',
    '.env.example',
    '.github/workflows/ci.yml',
    'vite.config.ts',
    'jest.config.js',
    'next.config.mjs',
    'babel.config.cjs',
  ])('classifies %s as config', (path) => {
    expect(classifyFileClass(path)).toBe('config')
  })

  it('a *.config.ts wins config over the generic source-extension rule', () => {
    // .ts is a source extension, but the config sub-rule must win — otherwise
    // the config list entry for .config.{ts,js,...} would be dead.
    expect(classifyFileClass('playwright.config.ts')).toBe('config')
  })
})

describe('classifyFileClass — other', () => {
  it.each([
    'README.md',
    'docs/guide.mdx',
    'assets/logo.png',
    '.gitignore',
    'data.csv',
    'notes.txt',
  ])('classifies %s as other', (path) => {
    expect(classifyFileClass(path)).toBe('other')
  })

  it('handles backslash (windows) separators for segment matching', () => {
    expect(classifyFileClass('src\\migrations\\001.sql')).toBe('schema')
    expect(classifyFileClass('src\\app.ts')).toBe('source')
  })
})
