// Regression guard for #37 — "import references on files are not working".
//
// The editor's tsserver resolves a file's imports using the moduleResolution of
// the tsconfig that owns the file. Classic `Node`/node10 resolution cannot read
// a modern package's `exports` map, so main/preload/shared files importing an
// exports-only dependency showed phantom "Cannot find module" (TS2307/2792)
// errors even though the package was installed and bundled fine by electron-vite.
//
// The fix set tsconfig.node.json to a bundler-aware resolution. This test pins
// that so a future edit can't silently regress the base config back to node10.
// (tsconfig.test.json intentionally stays CommonJS/Node for ts-jest's CJS emit.)

import { readFileSync } from 'fs'
import { join } from 'path'

/** app/ workspace root (this file is app/src/main/lsp/…). */
const APP_ROOT = join(__dirname, '..', '..', '..')

function readTsconfig(name: string): { compilerOptions?: Record<string, unknown> } {
  // tsconfig files allow comments; strip // line comments before parsing.
  const raw = readFileSync(join(APP_ROOT, name), 'utf8')
  const withoutComments = raw.replace(/^\s*\/\/.*$/gm, '')
  return JSON.parse(withoutComments)
}

/** Resolutions that read a package's `exports` map (unlike classic node10). */
const EXPORTS_AWARE = new Set(['bundler', 'node16', 'nodenext'])

/** Modules that imply a bundler-aware resolution when moduleResolution is omitted. */
const BUNDLER_MODULES = new Set(['preserve', 'node16', 'nodenext'])

describe('tsconfig.node.json module resolution (#37 guard)', () => {
  const config = readTsconfig('tsconfig.node.json')
  const options = config.compilerOptions ?? {}
  const moduleResolution = String(options.moduleResolution ?? '').toLowerCase()
  const moduleKind = String(options.module ?? '').toLowerCase()

  it('resolves modern "exports"-only packages (not classic node10)', () => {
    const exportsAware =
      EXPORTS_AWARE.has(moduleResolution) ||
      (moduleResolution === '' && BUNDLER_MODULES.has(moduleKind))
    expect(exportsAware).toBe(true)
  })

  it('does not use classic "node"/"node10" resolution', () => {
    expect(['node', 'node10', 'classic']).not.toContain(moduleResolution)
  })
})

describe('tsconfig.test.json keeps CommonJS emit for ts-jest', () => {
  const config = readTsconfig('tsconfig.test.json')
  const options = config.compilerOptions ?? {}

  it('pins module to CommonJS so Jest (CJS under Electron-as-Node) can run it', () => {
    expect(String(options.module ?? '').toLowerCase()).toBe('commonjs')
  })
})
