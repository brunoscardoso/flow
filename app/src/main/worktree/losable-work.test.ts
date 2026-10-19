// What deleting a checkout would LOSE — the links and untouched copies every
// checkout is given are the project's own, not the thread's work.
import { countLosableChanges, losableChanges, MAX_COMPARED_BYTES, type LosableWorkFs } from './losable-work'

const CHECKOUT = '/repo-threads/worktree/tidy'
const PROJECT = '/repo'

function fakeFs(links: string[], files: Record<string, string>, reads: string[] = []): LosableWorkFs {
  return {
    isSymlink: async (path) => links.includes(path),
    size: async (path) => (files[path] === undefined ? null : Buffer.byteLength(files[path])),
    readText: async (path) => {
      reads.push(path)
      return files[path] ?? null
    },
  }
}

describe('losableChanges', () => {
  it('sets aside an untracked LINK — deleting a link destroys nothing', async () => {
    const fs = fakeFs([`${CHECKOUT}/.claude`, `${CHECKOUT}/node_modules`], {})
    const porcelain = '?? .claude\n?? node_modules/\n?? important.txt\n M src/app.ts\n'
    expect(await losableChanges(porcelain, CHECKOUT, PROJECT, fs)).toEqual(['?? important.txt', ' M src/app.ts'])
  })

  it('sets aside a copy still identical to the project’s, and keeps an EDITED one', async () => {
    const same = fakeFs([], { [`${CHECKOUT}/.env`]: 'A=1\n', [`${PROJECT}/.env`]: 'A=1\n' })
    expect(await countLosableChanges('?? .env\n', CHECKOUT, PROJECT, same)).toBe(0)
    const edited = fakeFs([], { [`${CHECKOUT}/.env`]: 'A=2\n', [`${PROJECT}/.env`]: 'A=1\n' })
    expect(await countLosableChanges('?? .env\n', CHECKOUT, PROJECT, edited)).toBe(1)
  })

  it('without a project to compare with, only links are set aside', async () => {
    const fs = fakeFs([], { [`${CHECKOUT}/.env`]: 'A=1\n', [`${PROJECT}/.env`]: 'A=1\n' })
    expect(await countLosableChanges('?? .env\n', CHECKOUT, null, fs)).toBe(1)
  })

  it('counts a tracked change whatever it is', async () => {
    const fs = fakeFs([`${CHECKOUT}/.claude`], {})
    expect(await countLosableChanges(' M .claude\n', CHECKOUT, PROJECT, fs)).toBe(1)
  })

  it('reads nothing when the sizes already differ', async () => {
    const reads: string[] = []
    const fs = fakeFs([], { [`${CHECKOUT}/.env`]: 'A=22\n', [`${PROJECT}/.env`]: 'A=1\n' }, reads)
    expect(await countLosableChanges('?? .env\n', CHECKOUT, PROJECT, fs)).toBe(1)
    expect(reads).toEqual([])
  })

  it('counts a copy above the compare cap as work, without reading it', async () => {
    const reads: string[] = []
    const big = 'x'.repeat(MAX_COMPARED_BYTES + 1)
    const fs = fakeFs([], { [`${CHECKOUT}/dump.sql`]: big, [`${PROJECT}/dump.sql`]: big }, reads)
    expect(await countLosableChanges('?? dump.sql\n', CHECKOUT, PROJECT, fs)).toBe(1)
    expect(reads).toEqual([])
  })
})
