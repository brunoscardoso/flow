import type { BlueprintFeatureFolders } from '../../shared/ipc-contract'
import {
  cellFolders,
  detailsRows,
  DETAILS_ROWS,
  folderRowMenu,
  homeRefusalText,
  summaryLinesBeside,
  displayPath,
  folderSlice,
  fullPathText,
  moreText,
  oneLine,
  percentOf,
  rowTitle,
  rowViews,
  PROJECT_ROOT_LABEL,
} from './folder-rows-model'

const folders = (over: Partial<BlueprintFeatureFolders> = {}): BlueprintFeatureFolders => ({
  rows: [
    { path: 'src/components/automations', lines: 900, files: 60, share: 0.72 },
    { path: 'src/app/app/(protected)/automations', lines: 200, files: 8, share: 0.16 },
    { path: '.', lines: 50, files: 1, share: 0.04 },
  ],
  folderCount: 6,
  spread: false,
  pinned: false,
  pinMissing: null,
  files: 70,
  lines: 1250,
  ...over,
})

describe('displayPath', () => {
  it('drops one leading source root', () => {
    expect(displayPath('src/components/automations')).toBe('components/automations')
    expect(displayPath('app/src/renderer/blueprint')).toBe('renderer/blueprint')
    expect(displayPath('lib/utils')).toBe('utils')
    // Only at the start, only once, and never the whole path.
    expect(displayPath('packages/src/x')).toBe('packages/src/x')
    expect(displayPath('src/src/x')).toBe('src/x')
    expect(displayPath('src')).toBe('src')
  })

  it('collapses a deep middle to first/second/…/last', () => {
    expect(
      displayPath('src/components/admin/sections/SemanticLayerSection/SemanticLayerSubSections/DomainModels'),
    ).toBe('components/admin/…/DomainModels')
    expect(displayPath('src/app/app/(protected)/inbox')).toBe('app/app/…/inbox')
    expect(displayPath('src/a/b/c')).toBe('a/b/c')
  })

  it("reads the repository root as the project's name, or project root", () => {
    expect(displayPath('.', 'orbit-app')).toBe('orbit-app')
    expect(displayPath('.')).toBe(PROJECT_ROOT_LABEL)
    expect(displayPath('.', '  ')).toBe(PROJECT_ROOT_LABEL)
    expect(fullPathText('.', 'orbit-app')).toBe('orbit-app')
    expect(fullPathText('src/x/')).toBe('src/x')
  })
})

describe('percent and the full sentence', () => {
  it('rounds the share, clamped', () => {
    expect(percentOf(0.724)).toBe(72)
    expect(percentOf(0.005)).toBe(1)
    expect(percentOf(1.4)).toBe(100)
    expect(percentOf(Number.NaN)).toBe(0)
  })

  it('names the full path, the share of whose code, and the files', () => {
    expect(rowTitle({ path: 'src/components/automations', lines: 900, files: 60, share: 0.72 }, 'Automations')).toBe(
      "src/components/automations — 72% of Automations' code, 60 files",
    )
    expect(rowTitle({ path: '.', lines: 1, files: 1, share: 0.04, pinned: true }, 'Chat', 'web')).toBe(
      "web — 4% of Chat's code, 1 file · chosen as the home",
    )
  })

  it('marks the home row and a pinned row', () => {
    const rows = rowViews(folders({ rows: [{ path: 'src/a', lines: 1, files: 1, share: 0.5, pinned: true }, { path: 'src/b', lines: 1, files: 1, share: 0.5 }], pinned: true }), 'X')
    expect(rows.map((row) => [row.display, row.home, row.pinned])).toEqual([
      ['a', true, true],
      ['b', false, false],
    ])
  })
})

describe('oneLine', () => {
  it('is the home and its share', () => {
    expect(oneLine(folders(), 'Automations')).toMatchObject({
      kind: 'home',
      path: 'components/automations',
      fullPath: 'src/components/automations',
      percent: 72,
      text: 'components/automations 72%',
      pinned: false,
    })
  })

  it('says a spread feature is spread rather than naming a home', () => {
    const line = oneLine(folders({ spread: true, folderCount: 9 }), 'Chats')
    expect(line).toMatchObject({ kind: 'spread', text: 'spread over 9 folders' })
  })

  it('lets a chosen home win over spread', () => {
    const pinned = folders({
      spread: true,
      pinned: true,
      rows: [{ path: 'src/chosen', lines: 10, files: 2, share: 0.1, pinned: true }],
    })
    expect(oneLine(pinned, 'Chats')).toMatchObject({ kind: 'home', path: 'chosen', pinned: true })
  })

  it('is null with no rows — never a guessed folder', () => {
    expect(oneLine(folders({ rows: [] }), 'X')).toBeNull()
    expect(folderSlice(folders({ rows: [] }), 'X')).toBeNull()
    expect(folderSlice(undefined, 'X')).toBeNull()
  })
})

describe('moreText and the cell tiers', () => {
  it('counts the folders the rows did not list', () => {
    expect(moreText({ folderCount: 6 }, 2)).toBe('4 more folders')
    expect(moreText({ folderCount: 3 }, 2)).toBe('1 more folder')
    expect(moreText({ folderCount: 3 }, 3)).toBeNull()
  })

  it('prints rows, the line, or nothing, and always carries the whole slice', () => {
    const slice = folderSlice(folders(), 'Automations')
    const rows = cellFolders(slice, 'rows', 2)
    expect(rows?.shown.map((row) => row.display)).toEqual(['components/automations', 'app/app/…/automations'])
    expect(rows?.more).toBe('4 more folders')
    expect(rows?.moreAll).toBe('3 more folders')
    const line = cellFolders(slice, 'line', 0)
    expect(line?.shown).toEqual([])
    expect(line?.more).toBeNull()
    expect(line?.line.text).toBe('components/automations 72%')
    const none = cellFolders(slice, null, 0)
    expect(none?.tier).toBeNull()
    expect(none?.rows).toHaveLength(3)
    expect(cellFolders(null, 'rows', 3)).toBeNull()
  })

  it('names no command, config key or Flow path in any text', () => {
    const slice = folderSlice(folders({ spread: true }), 'Automations', 'orbit-app')
    const texts = [slice?.line.text, slice?.line.title, ...(slice?.rows ?? []).flatMap((row) => [row.display, row.title])]
    for (const text of texts) expect(text).not.toMatch(/planflow|flow\/|\.flowconfig|home:/)
  })
})

describe('a row menu', () => {
  it('always offers the file tree, and the home only where it can be written', () => {
    expect(folderRowMenu({ path: 'src/a', pinned: false }, false).map((item) => item.label)).toEqual(['Open in file tree'])
    expect(folderRowMenu({ path: 'src/a', pinned: false }, true).map((item) => item.id)).toEqual(['reveal', 'home'])
    expect(folderRowMenu({ path: 'src/a', pinned: true }, true)).toEqual([
      { id: 'reveal', label: 'Open in file tree' },
      { id: 'unhome', label: 'Stop using this as the home' },
    ])
  })

  it('never offers the project root as a home', () => {
    expect(folderRowMenu({ path: '.', pinned: false }, true).map((item) => item.id)).toEqual(['reveal'])
  })
})

describe('summaryLinesBeside', () => {
  it('gives the description what the rows leave, whole lines only, at most four', () => {
    // 46px of chrome, rows block 4 + 2*16 = 36 → 200 - 82 = 118 → 8 lines → 4
    expect(summaryLinesBeside(200, 2, false)).toBe(4)
    // 120 - 46 - 36 = 38 → 2 lines
    expect(summaryLinesBeside(120, 2, false)).toBe(2)
    // with "N more folders": 120 - 46 - 50 = 24 → 1 line
    expect(summaryLinesBeside(120, 2, true)).toBe(1)
    // the rows tier's floor holds the rows and no description
    expect(summaryLinesBeside(92, 2, false)).toBe(0)
    // no rows: the old arithmetic (100 → 3 lines here, 4 from 102)
    expect(summaryLinesBeside(102, 0, false)).toBe(4)
    expect(summaryLinesBeside(Number.NaN, 0, false)).toBe(0)
  })
})

describe('homeRefusalText', () => {
  it('names the folder and never a flag', () => {
    expect(homeRefusalText('missing-folder', 'src/old')).toBe('src/old is no longer a folder of this project.')
    expect(homeRefusalText('not-a-folder', 'src/a.ts')).toBe('src/a.ts is a file, not a folder.')
    expect(homeRefusalText('outside-project', '.')).toMatch(/project itself/)
    expect(homeRefusalText('arguments', 'src/a')).toBe("Flow couldn't save the home. Nothing was changed.")
    for (const reason of ['missing-folder', 'not-a-folder', 'outside-project', 'unknown-feature', 'unknown root', 'timed out', 'x']) {
      expect(homeRefusalText(reason, 'src/a')).not.toMatch(/--|planflow|\.flowconfig|flow\//)
    }
  })
})

describe('detailsRows — what the details of a hover print (2026-10-08)', () => {
  it('the top three rows, home first, and the folders left out counted', () => {
    const slice = folderSlice(
      folders({
        rows: [
          { path: 'src/a', lines: 40, files: 4, share: 0.4 },
          { path: 'src/b', lines: 30, files: 3, share: 0.3 },
          { path: 'src/c', lines: 20, files: 2, share: 0.2 },
          { path: 'src/d', lines: 10, files: 1, share: 0.1 },
        ],
        folderCount: 6,
      }),
      'X',
    )
    expect(slice).not.toBeNull()
    const top = detailsRows(slice!)
    expect(DETAILS_ROWS).toBe(3)
    expect(top.rows.map((row) => row.display)).toEqual(['a', 'b', 'c'])
    expect(top.rows[0]?.home).toBe(true)
    expect(top.more).toBe('3 more folders')
  })
  it('no "more" when every folder is a row', () => {
    expect(detailsRows({ rows: [], folderCount: 0 })).toEqual({ rows: [], more: null })
  })
})
