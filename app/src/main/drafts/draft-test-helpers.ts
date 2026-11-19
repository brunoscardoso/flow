// Test-only helpers for the drafts suites: a temp project root, and store deps
// over the REAL filesystem of that temp root (never a real project).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

import { nodeDraftFs, type DraftStoreDeps } from './draft-store'
import { createDraftWriteLedger } from './draft-write-ledger'

export interface TempProject {
  root: string
  write(relPath: string, content: string): string
  cleanup(): void
}

export function tempProject(): TempProject {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flow-drafts-test-')))
  return {
    root,
    write(relPath, content) {
      const absPath = join(root, relPath)
      mkdirSync(dirname(absPath), { recursive: true })
      writeFileSync(absPath, content)
      return absPath
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** Store deps with a controllable clock (each call advances one millisecond). */
export function testStore(start = 1_763_400_000_000): DraftStoreDeps & { clock: { at: number } } {
  const clock = { at: start }
  return { fs: nodeDraftFs, ledger: createDraftWriteLedger(), now: () => (clock.at += 1), clock }
}
