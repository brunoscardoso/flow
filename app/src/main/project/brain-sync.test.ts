// brain-sync tests (team-knowledge-sharing Phase 4) — pure decision + pointer
// parse + the injected-git clone/pull/push sequence, on real temp dirs. No
// better-sqlite3, so it runs under the app's jest here.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  readBrainPointerFromGitignore,
  flowIsCloned,
  decideBrainSync,
  syncBrainOnOpen,
  pushBrain,
  readBrainPointer,
  inspectFlowFolder,
  type GitRun,
} from './brain-sync'

function recordingGit(): { git: GitRun; calls: string[][] } {
  const calls: string[][] = []
  const git: GitRun = async (args) => {
    calls.push(args)
  }
  return { git, calls }
}

describe('readBrainPointerFromGitignore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pf-bs-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('parses url + branch', () => {
    writeFileSync(join(dir, '.gitignore'), '# >>> plan-flow\n# Brain repo: git@example.com:brain.git main\n# <<< plan-flow\n')
    expect(readBrainPointerFromGitignore(dir)).toEqual({ url: 'git@example.com:brain.git', branch: 'main' })
  })

  it('parses url-only and returns null when absent', () => {
    writeFileSync(join(dir, '.gitignore'), '# Brain repo: https://x/y.git\n')
    expect(readBrainPointerFromGitignore(dir)).toEqual({ url: 'https://x/y.git' })
    writeFileSync(join(dir, '.gitignore'), '/flow\n')
    expect(readBrainPointerFromGitignore(dir)).toBeNull()
  })
})

describe('decideBrainSync', () => {
  it('none without a pointer', () => {
    expect(decideBrainSync(null, false)).toBe('none')
    expect(decideBrainSync(null, true)).toBe('none')
  })
  it('clone when a pointer exists and flow/ is not yet cloned', () => {
    expect(decideBrainSync({ url: 'u' }, false)).toBe('clone')
  })
  it('pull when a pointer exists and flow/ is already cloned', () => {
    expect(decideBrainSync({ url: 'u' }, true)).toBe('pull')
  })
})

describe('flowIsCloned', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pf-bs-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  it('true when flow/.git exists; false when flow/ absent', () => {
    expect(flowIsCloned(dir)).toBe(false)
    mkdirSync(join(dir, 'flow', '.git'), { recursive: true })
    expect(flowIsCloned(dir)).toBe(true)
  })
})

describe('syncBrainOnOpen', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pf-bs-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('clones (with branch) then materializes rules when a pointer is set and flow/ absent', async () => {
    writeFileSync(join(dir, '.gitignore'), '# Brain repo: git@example.com:brain.git main\n')
    const { git, calls } = recordingGit()
    let materialized = false
    const result = await syncBrainOnOpen(dir, { git, materializeRules: () => { materialized = true } })
    expect(result.ok).toBe(true)
    expect(result.action).toBe('clone')
    expect(calls).toEqual([['clone', '--branch', 'main', '--', 'git@example.com:brain.git', 'flow']])
    expect(materialized).toBe(true)
  })

  it('refuses a committed pointer the shared address grammar refuses — no git at all', async () => {
    for (const line of ['# Brain repo: --upload-pack=touch%20/tmp/x', '# Brain repo: ext::sh', '# Brain repo: git@example.com:brain.git -x']) {
      writeFileSync(join(dir, '.gitignore'), `${line}\n`)
      const { git, calls } = recordingGit()
      // POSITIVE FIRST: the line IS read as a pointer…
      expect(readBrainPointerFromGitignore(dir)).not.toBeNull()
      const result = await syncBrainOnOpen(dir, { git })
      // …and refused before git.
      expect(result).toMatchObject({ action: 'none', ok: false })
      expect(calls).toEqual([])
    }
  })

  it('pulls when flow/ is already a clone', async () => {
    writeFileSync(join(dir, '.gitignore'), '# Brain repo: git@example.com:brain.git\n')
    mkdirSync(join(dir, 'flow', '.git'), { recursive: true })
    const { git, calls } = recordingGit()
    const result = await syncBrainOnOpen(dir, { git })
    expect(result.action).toBe('pull')
    expect(calls).toEqual([['pull', '--ff-only']])
  })

  it('does nothing (no git) when there is no pointer', async () => {
    writeFileSync(join(dir, '.gitignore'), '/flow\n')
    const { git, calls } = recordingGit()
    const result = await syncBrainOnOpen(dir, { git })
    expect(result.action).toBe('none')
    expect(calls).toEqual([])
  })

  it('is fail-soft when git rejects', async () => {
    writeFileSync(join(dir, '.gitignore'), '# Brain repo: git@example.com:brain.git\n')
    const failing: GitRun = async () => {
      throw new Error('network down')
    }
    const result = await syncBrainOnOpen(dir, { git: failing })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('network down')
  })
})

describe('pushBrain', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pf-bs-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  it('pushes when flow/ is a clone; no-op otherwise', async () => {
    const { git, calls } = recordingGit()
    expect((await pushBrain(dir, { git })).ran).toEqual([]) // no flow/ yet
    mkdirSync(join(dir, 'flow', '.git'), { recursive: true })
    const result = await pushBrain(dir, { git })
    expect(result.ok).toBe(true)
    expect(calls).toEqual([['push']])
  })
})

describe('readBrainPointer — the committed pointer is judged before anyone acts on it', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pf-bs-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('no ignore file, or no pointer line: no pointer', async () => {
    expect(await readBrainPointer(dir)).toBeNull()
    writeFileSync(join(dir, '.gitignore'), '/flow\n')
    expect(await readBrainPointer(dir)).toBeNull()
  })

  it('a valid address and branch are valid, on any host', async () => {
    writeFileSync(join(dir, '.gitignore'), '# Brain repo: https://dev.azure.com/acme/Orbit/_git/notes main\n')
    expect(await readBrainPointer(dir)).toEqual({ valid: true, url: 'https://dev.azure.com/acme/Orbit/_git/notes', branch: 'main' })
  })

  it('an option-shaped address, a transport helper, plain http or an option-shaped branch is invalid', async () => {
    const cases: Array<[string, string]> = [
      ['--upload-pack=touch%20/tmp/x', 'invalid-remote'],
      ['ext::sh', 'invalid-remote'],
      ['http://github.com/a/b', 'insecure-remote'],
      ['https://a:b@github.com/a/b', 'credentials-in-url'],
      ['https://github.com/a/b --upload-pack=x', 'invalid-branch'],
    ]
    for (const [pointer, reason] of cases) {
      writeFileSync(join(dir, '.gitignore'), `# Brain repo: ${pointer}\n`)
      expect(await readBrainPointer(dir)).toEqual({ valid: false, reason })
    }
  })
})

describe('inspectFlowFolder', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pf-bs-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('tells a vault link apart from a folder in the way', async () => {
    expect(await inspectFlowFolder(dir)).toBe('absent')
    const vault = join(dir, 'vault-flow')
    mkdirSync(join(vault, 'brain'), { recursive: true })
    symlinkSync(vault, join(dir, 'flow'))
    expect(await inspectFlowFolder(dir)).toBe('link')
    rmSync(join(dir, 'flow'))
    mkdirSync(join(dir, 'flow', 'brain'), { recursive: true })
    expect(await inspectFlowFolder(dir)).toBe('occupied')
    mkdirSync(join(dir, 'flow', '.git'))
    expect(await inspectFlowFolder(dir)).toBe('repo')
  })
})
