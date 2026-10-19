/**
 * A project's sharing id (review R2-M3): minted once, kept in the project's own
 * settings, shared by a project and its worktrees, and never written by a read.
 * Exercised against the REAL settings writer and reader on a temp project.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { promises as fsPromises } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { SHARE_PROJECT_ID_PATTERN } from '../../shared/share-contract'
import { parseFlowconfigText } from '../flow/flow-observer'
import { writeFlowconfig } from '../flow/flowconfig-writer'
import { createProjectIds, mintProjectId, SHARE_PROJECT_ID_KEY } from './share-project-id'

const temps: string[] = []
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flow-share-project-id-'))
  temps.push(dir)
  return dir
}

async function readConfig(flowDir: string): Promise<Record<string, string>> {
  try {
    return parseFlowconfigText(await fsPromises.readFile(join(flowDir, '.flowconfig'), 'utf-8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

function ids(owners: Record<string, string> = {}, mint?: () => string) {
  const writes: string[] = []
  const source = createProjectIds({
    ownerCheckoutFor: (root) => owners[root] ?? null,
    readConfig,
    writeConfig: async (flowDir, updates) => {
      writes.push(flowDir)
      await writeFlowconfig(flowDir, updates)
    },
    ...(mint === undefined ? {} : { mint }),
  })
  return { source, writes }
}

describe('the project sharing id', () => {
  it('is 32 lower-case hex characters of randomness', () => {
    const a = mintProjectId()
    const b = mintProjectId()
    expect(a).toMatch(SHARE_PROJECT_ID_PATTERN)
    expect(b).toMatch(SHARE_PROJECT_ID_PATTERN)
    expect(a).not.toBe(b)
  })

  it('reading never writes: a project that never shared has none', async () => {
    const root = tempRoot()
    mkdirSync(join(root, 'flow'))
    const { source, writes } = ids()
    expect(await source.existing(root)).toBeNull()
    expect(writes).toEqual([])
  })

  it('ensure mints once, keeps every other setting and comment, and answers the same id after', async () => {
    const root = tempRoot()
    mkdirSync(join(root, 'flow'))
    writeFileSync(join(root, 'flow', '.flowconfig'), '# my settings\nautopilot: false\nbranch: main\n')
    const { source, writes } = ids()
    const minted = await source.ensure(root)
    expect(minted).toMatch(SHARE_PROJECT_ID_PATTERN)
    expect(await source.ensure(root)).toBe(minted)
    expect(await source.existing(root)).toBe(minted)
    expect(writes).toHaveLength(1)
    const text = readFileSync(join(root, 'flow', '.flowconfig'), 'utf-8')
    expect(text).toContain('# my settings')
    expect(text).toContain('autopilot: false')
    expect(text).toContain(`${SHARE_PROJECT_ID_KEY}: ${minted}`)
  })

  it('two concurrent first uses agree on one id', async () => {
    const root = tempRoot()
    mkdirSync(join(root, 'flow'))
    let n = 0
    const { source, writes } = ids({}, () => (n++ === 0 ? 'a'.repeat(32) : 'b'.repeat(32)))
    const [one, two] = await Promise.all([source.ensure(root), source.ensure(root)])
    expect(one).toBe(two)
    expect(writes).toHaveLength(1)
  })

  it('a worktree resolves to its owner checkout, so both share one id', async () => {
    const owner = tempRoot()
    const worktree = tempRoot()
    mkdirSync(join(owner, 'flow'))
    mkdirSync(join(worktree, 'flow'))
    const { source } = ids({ [worktree]: owner })
    const fromWorktree = await source.ensure(worktree)
    expect(await source.existing(owner)).toBe(fromWorktree)
    expect(await readConfig(join(worktree, 'flow'))).toEqual({})
  })

  it('a malformed stored value is not an id; ensure replaces it with one', async () => {
    const root = tempRoot()
    mkdirSync(join(root, 'flow'))
    writeFileSync(join(root, 'flow', '.flowconfig'), `${SHARE_PROJECT_ID_KEY}: plan-flow\n`)
    const { source } = ids()
    expect(await source.existing(root)).toBeNull()
    const minted = await source.ensure(root)
    expect(minted).toMatch(SHARE_PROJECT_ID_PATTERN)
    expect((await readConfig(join(root, 'flow')))[SHARE_PROJECT_ID_KEY]).toBe(minted)
  })
})
