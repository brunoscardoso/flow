import {
  activeEditorFileFrom,
  activeFileChip,
  activeFileReference,
  dismissActiveFile,
  focusActiveFile,
  NO_ACTIVE_FILE,
  type ChipRoot,
} from './active-file-chip'
import { contextChipId, serializeContextChips, type ContextChipRef } from './context-chips'

const PROJECT: ChipRoot = { rootPath: '/repo/app', name: 'app', primary: true }
const ATTACHED: ChipRoot = { rootPath: '/repo/lib/', name: 'lib', primary: false }
const roots = [PROJECT, ATTACHED]

const focus = (rootPath: string, relPath: string) => focusActiveFile(NO_ACTIVE_FILE, { rootPath, relPath })

describe('focusActiveFile / dismissActiveFile — the dismissal rule', () => {
  it('shows the focused file', () => {
    expect(activeFileChip(focus('/repo/app', 'src/a.ts'), roots, [])).toEqual({
      absolutePath: '/repo/app/src/a.ts',
      label: 'a.ts',
      title: 'src/a.ts',
      promptPath: 'src/a.ts',
    })
  })

  it('hides it once dismissed, and keeps it hidden while the same file is re-announced', () => {
    const shown = focus('/repo/app', 'src/a.ts')
    const dismissed = dismissActiveFile(shown)
    expect(activeFileChip(shown, roots, [])).not.toBeNull()
    expect(activeFileChip(dismissed, roots, [])).toBeNull()
    const again = focusActiveFile(dismissed, { rootPath: '/repo/app/', relPath: 'src/a.ts' })
    expect(again).toBe(dismissed)
  })

  it('a different file clears the dismissal, and so does coming back later', () => {
    const dismissed = dismissActiveFile(focus('/repo/app', 'src/a.ts'))
    const other = focusActiveFile(dismissed, { rootPath: '/repo/app', relPath: 'src/b.ts' })
    expect(activeFileChip(other, roots, [])?.label).toBe('b.ts')
    const back = focusActiveFile(other, { rootPath: '/repo/app', relPath: 'src/a.ts' })
    expect(activeFileChip(back, roots, [])?.label).toBe('a.ts')
  })

  it('no editor file (all tabs closed) → no chip, and a later file is not dismissed', () => {
    const dismissed = dismissActiveFile(focus('/repo/app', 'src/a.ts'))
    const closed = focusActiveFile(dismissed, null)
    expect(closed).toEqual(NO_ACTIVE_FILE)
    expect(activeFileChip(closed, roots, [])).toBeNull()
    expect(dismissActiveFile(closed)).toBe(closed)
  })
})

describe('activeFileChip — which roots', () => {
  it('names an attached project in the tooltip and tells the agent its absolute path', () => {
    expect(activeFileChip(focus('/repo/lib', 'index.ts'), roots, [])).toEqual({
      absolutePath: '/repo/lib/index.ts',
      label: 'index.ts',
      title: 'lib/index.ts',
      promptPath: '/repo/lib/index.ts',
    })
  })

  it('offers nothing for a file outside every root, including a sibling with a shared prefix', () => {
    expect(activeFileChip(focus('/elsewhere', 'a.ts'), roots, [])).toBeNull()
    expect(activeFileChip(focus('/repo/app-other', 'a.ts'), roots, [])).toBeNull()
    expect(activeFileChip(focus('/repo/app', 'a.ts'), [], [])).toBeNull()
  })

  it('a file opened from a parent folder still resolves into the nearest root', () => {
    const nested: ChipRoot[] = [
      { rootPath: '/repo', name: 'repo', primary: false },
      { rootPath: '/repo/app', name: 'app', primary: true },
    ]
    expect(activeFileChip(focus('/repo', 'app/src/a.ts'), nested, [])?.promptPath).toBe('src/a.ts')
  })
})

describe('activeFileChip — no duplicate of a ⌘L selection', () => {
  const selection = (filePath?: string): ContextChipRef => ({
    id: contextChipId('file', 'const x = 1'),
    source: 'file',
    label: 'a.ts',
    text: 'const x = 1',
    ...(filePath !== undefined ? { filePath } : {}),
  })

  it('hides when a selection from the same file is attached', () => {
    expect(activeFileChip(focus('/repo/app', 'src/a.ts'), roots, [selection('/repo/app/src/a.ts')])).toBeNull()
  })

  it('stays for a selection from another file, or one with no known path', () => {
    const state = focus('/repo/app', 'src/a.ts')
    expect(activeFileChip(state, roots, [selection('/repo/app/src/b.ts')])).not.toBeNull()
    expect(activeFileChip(state, roots, [selection()])).not.toBeNull()
  })
})

describe('activeFileReference — serialized through the context-chip path', () => {
  it('sends the path only, on one line, before the selections and the text', () => {
    const chip = activeFileChip(focus('/repo/app', 'src/a.ts'), roots, [])
    if (chip === null) throw new Error('expected a chip')
    const terminal: ContextChipRef = { id: 't', source: 'terminal', label: 'Terminal', text: 'boom' }
    const content = serializeContextChips([activeFileReference(chip), terminal], 'why?')
    expect(content).toBe(
      'Open in the editor (path only, not attached): src/a.ts\n\n' +
        'Context from Terminal:\n```\nboom\n```\n\nwhy?',
    )
  })
})

describe('activeEditorFileFrom', () => {
  it('accepts a well-formed detail and rejects everything else', () => {
    expect(activeEditorFileFrom({ rootPath: '/r', relPath: 'a' })).toEqual({ rootPath: '/r', relPath: 'a' })
    expect(activeEditorFileFrom(null)).toBeNull()
    expect(activeEditorFileFrom({ rootPath: '', relPath: 'a' })).toBeNull()
    expect(activeEditorFileFrom({ rootPath: '/r', relPath: 3 })).toBeNull()
    expect(activeEditorFileFrom('x')).toBeNull()
  })
})
