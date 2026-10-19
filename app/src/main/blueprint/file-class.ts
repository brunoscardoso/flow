// File-class matchers (#drift phase 2) — a PURE, I/O-free predicate that sorts a
// repo-relative path into one broad class. Drift's Phase 4 panel groups every
// non-`source` class into a single "system changes" bucket (deps, schema, and
// config churn a user rarely reasons about line-by-line), keeping the drift
// list focused on actual source drift.
//
// `source` reuses `isSourceFileName` (basic-derive.ts) — the ONE definition of
// "source file" shared by the module spine, the learn enumerator, and the
// staleness watcher. The system classes are checked BEFORE the source rule so a
// `*.config.ts` resolves to 'config' rather than 'source' (otherwise the config
// list's `.config.{ts,js,mjs,cjs}` entry would be unreachable behind the generic
// source-extension check). No fs, no Electron — unit-testable under plain jest.

import { isSourceFileName } from './basic-derive'

/** The broad class a repo-relative path belongs to. Everything that is not
 *  `source` is drift's "system changes" bucket. */
export type FileClass = 'source' | 'dependency' | 'schema' | 'config' | 'other'

/** Dependency manifests + lockfiles (exact basenames). */
const DEPENDENCY_FILES = new Set([
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
])

/** Normalize to posix separators so path-segment math is platform-stable. */
function toPosix(path: string): string {
  return path.split('\\').join('/')
}

/** True for a dependency manifest / lockfile. */
function isDependencyFile(base: string): boolean {
  return DEPENDENCY_FILES.has(base)
}

/**
 * True for a schema file: a `*.prisma` / `*.sql` file, or any file living under
 * a `migrations/` or `prisma/` directory (DB shape, wherever it sits).
 */
function isSchemaPath(base: string, segments: readonly string[]): boolean {
  if (base.endsWith('.prisma') || base.endsWith('.sql')) {
    return true
  }
  return segments.includes('migrations') || segments.includes('prisma')
}

/** `*.config.{ts,js,mjs,cjs}` — e.g. vite.config.ts, jest.config.mjs. */
const CONFIG_SUFFIX_PATTERN = /\.config\.(ts|js|mjs|cjs)$/

/**
 * True for a config file: a `tsconfig*.json`, the `.env.example` template, a
 * `.github/workflows/*` CI file, or a `*.config.{ts,js,mjs,cjs}` file.
 */
function isConfigPath(base: string, posix: string): boolean {
  if (base.startsWith('tsconfig') && base.endsWith('.json')) {
    return true
  }
  if (base === '.env.example') {
    return true
  }
  if (posix.includes('.github/workflows/')) {
    return true
  }
  return CONFIG_SUFFIX_PATTERN.test(base)
}

/**
 * Classify a repo-relative path into its broad `FileClass`. System-file classes
 * (dependency, schema, config) are matched BEFORE the generic source-extension
 * rule so a `*.config.ts` is 'config', not 'source'. Anything unrecognized is
 * 'other'.
 */
export function classifyFileClass(path: string): FileClass {
  const posix = toPosix(path)
  const base = posix.slice(posix.lastIndexOf('/') + 1)
  const segments = posix.split('/')

  if (isDependencyFile(base)) {
    return 'dependency'
  }
  if (isSchemaPath(base, segments)) {
    return 'schema'
  }
  if (isConfigPath(base, posix)) {
    return 'config'
  }
  if (isSourceFileName(base)) {
    return 'source'
  }
  return 'other'
}
