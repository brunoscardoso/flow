// Agent-clash tests (conflict-UX Phase 6). Two layers:
//   1. DETECTION (buildClashForFile / detectClashForPath / detectAgentClashes)
//      against INJECTED AgentClashDeps — the grouping/gating/>2-phase/fail-soft
//      logic, no real repo needed (that's why the seams are injectable).
//   2. SYNTHESIS + RECONCILE + openAgentClash against a REAL temp-repo: three
//      divergent blobs reconstructed into marker text the shared conflict-hunks
//      grammar reads, resolved ONE HUNK AT A TIME through the same splice
//      primitive git conflicts use, then written back to the working tree.

import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { parseConflictHunks, spliceConflictHunk } from '../../shared/conflict-hunks'
import type { AgentClashInfo } from '../../shared/ipc-contract'
import type { CommitRef } from './conflict-context'
import {
  buildClashForFile,
  detectAgentClashes,
  detectClashForPath,
  type AgentClashDeps,
} from './agent-clash'
import { GitManager, type GitRootsProvider } from './git-manager'
import { openAgentClash } from './index'

const noopRoots: GitRootsProvider = {
  getRoots: () => [],
  onRootsChanged: () => () => undefined,
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** A commit subject in execute-plan's atomic-commit convention. */
function planSubject(phase: number, task: number): string {
  return `feat(phase-${phase}.task-${task}): edit shared file — my-feature`
}

// ── Detection (injected deps, no real git) ─────────────────────────────────

describe('buildClashForFile — reconstruction + gating (injected deps)', () => {
  const FILE = 'src/shared/f.ts'

  function depsFor(commits: CommitRef[], base: string | null = 'ba5eba5e'): AgentClashDeps {
    return {
      readPhaseMap: async () => new Map([[FILE, new Set(['phase-3', 'phase-4'])]]),
      logFileCommits: async () => commits,
      mergeBase: async () => base,
      // Parents resolve to a stable hash so the M3 parents-based derivation runs;
      // mergeBase ignores its args here, so `base` is what the clash records.
      resolveRev: async () => 'parent00',
    }
  }

  it('reconstructs the two phase sides (lower phase = side A) + base', async () => {
    // Newest first, as `git log` emits: phase-4 then phase-3.
    const deps = depsFor([
      { hash: 'cccc4444', subject: planSubject(4, 1) },
      { hash: 'cccc3333', subject: planSubject(3, 2) },
    ])
    const clash = await buildClashForFile('/root', FILE, deps)
    expect(clash).not.toBeNull()
    expect(clash?.filePath).toBe(FILE)
    expect(clash?.base).toBe('ba5eba5e')
    expect(clash?.sideA).toMatchObject({ phase: 3, task: 2, commit: 'cccc3333' })
    expect(clash?.sideB).toMatchObject({ phase: 4, task: 1, commit: 'cccc4444' })
    expect(clash?.extraPhases).toBeUndefined()
    expect(clash?.note).toBeUndefined()
  })

  it('keeps the NEWEST commit per phase (commits are newest-first)', async () => {
    const deps = depsFor([
      { hash: 'newp3', subject: planSubject(3, 9) }, // newest phase-3 wins
      { hash: 'oldp3', subject: planSubject(3, 1) },
      { hash: 'onlyp4', subject: planSubject(4, 1) },
    ])
    const clash = await buildClashForFile('/root', FILE, deps)
    expect(clash?.sideA.commit).toBe('newp3')
    expect(clash?.sideA.task).toBe(9)
  })

  it('gates to null when fewer than two phase commits touch the file', async () => {
    const deps = depsFor([{ hash: 'onlyp3', subject: planSubject(3, 1) }])
    expect(await buildClashForFile('/root', FILE, deps)).toBeNull()
  })

  it('gates to null when NO commits map to a plan (commit mode off)', async () => {
    const deps = depsFor([
      { hash: 'x', subject: 'chore: unrelated' },
      { hash: 'y', subject: 'wip' },
    ])
    expect(await buildClashForFile('/root', FILE, deps)).toBeNull()
  })

  it('records extraPhases + a note for a >2-phase clash (first two are sides)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const deps = depsFor([
      { hash: 'p5', subject: planSubject(5, 1) },
      { hash: 'p4', subject: planSubject(4, 1) },
      { hash: 'p3', subject: planSubject(3, 1) },
    ])
    const clash = await buildClashForFile('/root', FILE, deps)
    expect(clash?.sideA.phase).toBe(3)
    expect(clash?.sideB.phase).toBe(4)
    expect(clash?.extraPhases).toEqual([5])
    expect(clash?.note).toContain('phase-5')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('fails soft to null when logFileCommits throws', async () => {
    const deps: AgentClashDeps = {
      readPhaseMap: async () => new Map(),
      logFileCommits: async () => {
        throw new Error('git exploded')
      },
      mergeBase: async () => null,
      resolveRev: async () => null,
    }
    expect(await buildClashForFile('/root', FILE, deps)).toBeNull()
  })

  it('tolerates a null merge-base (unrelated histories)', async () => {
    const deps = depsFor(
      [
        { hash: 'p4', subject: planSubject(4, 1) },
        { hash: 'p3', subject: planSubject(3, 1) },
      ],
      null,
    )
    const clash = await buildClashForFile('/root', FILE, deps)
    expect(clash?.base).toBeNull()
  })

  it('M3: derives the base from each side PARENT, not the sides themselves', async () => {
    // The bug: merge-base(sideA, sideB) collapses to sideA in a linear history.
    // The fix: resolve each side's `^` parent and merge-base THOSE — so the base
    // precedes each edit and the 3-way exposes real divergence.
    const mergeBaseArgs: Array<[string, string]> = []
    const deps: AgentClashDeps = {
      readPhaseMap: async () => new Map([[FILE, new Set(['phase-3', 'phase-4'])]]),
      logFileCommits: async () => [
        { hash: 'sideBcommit', subject: planSubject(4, 1) },
        { hash: 'sideAcommit', subject: planSubject(3, 1) },
      ],
      resolveRev: async (_root, rev) => {
        // `<hash>^` → that side's parent hash (linear-history parents).
        if (rev === 'sideAcommit^') return 'parentA'
        if (rev === 'sideBcommit^') return 'parentB'
        return null
      },
      mergeBase: async (_root, a, b) => {
        mergeBaseArgs.push([a, b])
        return 'realbase'
      },
    }
    const clash = await buildClashForFile('/root', FILE, deps)
    expect(clash?.base).toBe('realbase')
    // merge-base ran over the PARENTS — never the side commits.
    expect(mergeBaseArgs).toEqual([['parentA', 'parentB']])
  })

  it('M3: falls back to the side commits when a side has no parent (root commit)', async () => {
    const mergeBaseArgs: Array<[string, string]> = []
    const deps: AgentClashDeps = {
      readPhaseMap: async () => new Map([[FILE, new Set(['phase-3', 'phase-4'])]]),
      logFileCommits: async () => [
        { hash: 'sideBcommit', subject: planSubject(4, 1) },
        { hash: 'sideAcommit', subject: planSubject(3, 1) },
      ],
      // sideA is the ROOT commit — `sideAcommit^` cannot resolve → null.
      resolveRev: async (_root, rev) => (rev === 'sideBcommit^' ? 'parentB' : null),
      mergeBase: async (_root, a, b) => {
        mergeBaseArgs.push([a, b])
        return 'fallbackbase'
      },
    }
    const clash = await buildClashForFile('/root', FILE, deps)
    expect(clash?.base).toBe('fallbackbase')
    // Fell back to today's behavior — merge-base over the side commits.
    expect(mergeBaseArgs).toEqual([['sideAcommit', 'sideBcommit']])
  })
})

describe('detectAgentClashes — only multi-phase files are candidates', () => {
  it('confirms candidates the phase-map claims for >1 phase', async () => {
    const deps: AgentClashDeps = {
      readPhaseMap: async () =>
        new Map([
          ['src/a.ts', new Set(['phase-3', 'phase-4'])], // candidate
          ['src/b.ts', new Set(['phase-3'])], // single phase → skipped
        ]),
      logFileCommits: async (_root, file) =>
        file === 'src/a.ts'
          ? [
              { hash: 'aa4', subject: planSubject(4, 1) },
              { hash: 'aa3', subject: planSubject(3, 1) },
            ]
          : [],
      mergeBase: async () => 'base00',
      resolveRev: async () => 'parent00',
    }
    const clashes = await detectAgentClashes('/root', deps)
    expect(clashes).toHaveLength(1)
    expect(clashes[0].filePath).toBe('src/a.ts')
  })

  it('fails soft to [] when the phase-map read throws', async () => {
    const deps: AgentClashDeps = {
      readPhaseMap: async () => {
        throw new Error('no wave context')
      },
      logFileCommits: async () => [],
      mergeBase: async () => null,
      resolveRev: async () => null,
    }
    expect(await detectAgentClashes('/root', deps)).toEqual([])
  })
})

// ── Synthesis + reconcile + openAgentClash (real temp repo) ─────────────────

describe('synthesizeClashConflict — real 3-way reconstruction', () => {
  let repo: string
  let manager: GitManager
  let baseHash: string
  let sideAHash: string
  let sideBHash: string

  // Two conflict regions after synthesis: BOTH sides edit region 1 AND region 2
  // differently from the base, spaced 8 filler lines apart so git keeps them as
  // two distinct hunks rather than coalescing them into one.
  const gap = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8']
  const baseText = ['top', 'R1-BASE', ...gap, 'R2-BASE', 'bottom'].join('\n') + '\n'
  const sideAText = ['top', 'R1-A', ...gap, 'R2-A', 'bottom'].join('\n') + '\n'
  const sideBText = ['top', 'R1-B', ...gap, 'R2-B', 'bottom'].join('\n') + '\n'

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-agent-clash-'))
    git(repo, 'init')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'checkout', '-b', 'main')

    writeFileSync(join(repo, 'f.txt'), baseText, 'utf8')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'wave-start base')
    baseHash = git(repo, 'rev-parse', 'HEAD').trim()

    writeFileSync(join(repo, 'f.txt'), sideAText, 'utf8')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', planSubject(3, 1))
    sideAHash = git(repo, 'rev-parse', 'HEAD').trim()

    writeFileSync(join(repo, 'f.txt'), sideBText, 'utf8')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', planSubject(4, 2))
    sideBHash = git(repo, 'rev-parse', 'HEAD').trim()

    manager = new GitManager(noopRoots)
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('reconstructs marker text with TWO hunks + phase-id labels', async () => {
    const result = await manager.synthesizeClashConflict(repo, {
      filePath: 'f.txt',
      baseCommit: baseHash,
      sideACommit: sideAHash,
      sideBCommit: sideBHash,
      sideALabel: 'phase-3',
      sideBLabel: 'phase-4',
    })
    if ('oversize' in result) throw new Error('unexpected oversize')

    expect(result.ours).toContain('R1-A')
    expect(result.theirs).toContain('R1-B')
    expect(result.base).toContain('R1-BASE')
    expect(result.conflictType).toBe('both-modified')
    expect(result.basePresent).toBe(true)

    const hunks = parseConflictHunks(result.markered)
    expect(hunks).toHaveLength(2)
    // Marker labels carry the phase ids (side A = phase A, side B = phase B).
    expect(result.markered).toContain('<<<<<<< phase-3')
    expect(result.markered).toContain('>>>>>>> phase-4')
    // --diff3 kept the base section.
    expect(result.markered).toContain('||||||| base')
  })

  it('M3 (real repo): a linear-history clash derives a real base, not side A', async () => {
    // History here is strictly linear: base → phase-3 (side A) → phase-4 (side B),
    // so the OLD merge-base(sideA, sideB) collapsed to the phase-3 commit itself
    // (side A), making ours == base and yielding a SILENT zero-hunk resolver. The
    // parents-based derivation (merge-base(sideA^, sideB^)) restores the wave-start
    // base, so the reconstructed 3-way exposes both edits as real conflict hunks.
    const clash = await detectClashForPath(repo, 'f.txt')
    expect(clash).not.toBeNull()
    // The base PRECEDES each side's edit — the wave-start base, never side A itself.
    expect(clash?.base).toBe(baseHash)
    expect(clash?.base).not.toBe(sideAHash)

    const opened = await openAgentClash(manager, repo, 'f.txt')
    expect(opened).not.toBeNull()
    if (!opened || 'oversize' in opened) throw new Error('unexpected result')
    const hunks = parseConflictHunks(opened.file.markered)
    expect(hunks.length).toBeGreaterThan(0)
    expect(opened.file.markered).toContain('<<<<<<< phase-3')
  })

  it('resolves ONE HUNK AT A TIME via the shared splice primitive', async () => {
    const result = await manager.synthesizeClashConflict(repo, {
      filePath: 'f.txt',
      baseCommit: baseHash,
      sideACommit: sideAHash,
      sideBCommit: sideBHash,
      sideALabel: 'phase-3',
      sideBLabel: 'phase-4',
    })
    if ('oversize' in result) throw new Error('unexpected oversize')

    const ids = parseConflictHunks(result.markered).map((h) => h.hunkId)
    expect(ids).toHaveLength(2)

    // Resolve the first hunk (keep side A) — the sibling stays conflicted.
    const first = spliceConflictHunk(result.markered, ids[0], 'ours')
    expect(first.matched).toBe(true)
    expect(first.remainingConflicts).toBe(1)
    expect(first.text).toContain('<<<<<<<')

    // Resolve the second hunk (keep side B) — now fully clean.
    const secondId = parseConflictHunks(first.text).map((h) => h.hunkId)[0]
    const second = spliceConflictHunk(first.text, secondId, 'theirs')
    expect(second.remainingConflicts).toBe(0)
    expect(second.text).not.toContain('<<<<<<<')

    // Reconcile: write the resolved content to the working tree deterministically.
    await manager.reconcileClash(repo, 'f.txt', second.text)
    const onDisk = readFileSync(join(repo, 'f.txt'), 'utf8')
    expect(onDisk).toContain('R1-A') // side A won region 1
    expect(onDisk).toContain('R2-B') // side B won region 2
    expect(onDisk).not.toContain('<<<<<<<')
    // Staged (best-effort) — the reconciled file is no longer "modified" unstaged.
    const porcelain = git(repo, 'status', '--porcelain', 'f.txt')
    expect(porcelain.trim().startsWith('M ')).toBe(true)
  })

  it('treats a null base as an add/add-style clash (empty base blob)', async () => {
    const result = await manager.synthesizeClashConflict(repo, {
      filePath: 'f.txt',
      baseCommit: null,
      sideACommit: sideAHash,
      sideBCommit: sideBHash,
    })
    if ('oversize' in result) throw new Error('unexpected oversize')
    expect(result.basePresent).toBe(false)
    expect(result.base).toBe('')
    expect(result.conflictType).toBe('both-added')
    expect(result.markered).toContain('<<<<<<<')
  })

  it('rejects an invalid side commit (SEC-2)', async () => {
    await expect(
      manager.synthesizeClashConflict(repo, {
        filePath: 'f.txt',
        baseCommit: baseHash,
        sideACommit: '--output=/tmp/pwned',
        sideBCommit: sideBHash,
      }),
    ).rejects.toThrow(/valid side commits/)
  })

  it('openAgentClash overlays phase/task identities on the synthesized file', async () => {
    const clash: AgentClashInfo = {
      filePath: 'f.txt',
      base: baseHash,
      sideA: { phase: 3, task: 1, feature: 'my-feature', commit: sideAHash, subject: planSubject(3, 1) },
      sideB: { phase: 4, task: 2, feature: 'my-feature', commit: sideBHash, subject: planSubject(4, 2) },
    }
    // Inject detection so the reconstruction uses the divergent branch commits.
    const opened = await openAgentClash(manager, repo, 'f.txt', async () => clash)
    expect(opened).not.toBeNull()
    if (!opened || 'oversize' in opened) throw new Error('unexpected result')

    expect(opened.clash.sideA.phase).toBe(3)
    expect(opened.file.markered).toContain('<<<<<<<')
    // The SAME IdentityChip renders these — labeled by phase/task, never a stage word.
    expect(opened.file.oursIdentity?.branch).toBe('Phase 3 · task-1')
    expect(opened.file.theirsIdentity?.branch).toBe('Phase 4 · task-2')
    expect(opened.file.oursIdentity?.isCurrentUser).toBe(false)
  })

  it('openAgentClash returns null when the path is not a clash (fail-soft)', async () => {
    const opened = await openAgentClash(manager, repo, 'f.txt', async () => null)
    expect(opened).toBeNull()
  })
})

describe('detectClashForPath — real repo, no live phase-map needed', () => {
  it('fails soft to null outside a git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-agent-clash-none-'))
    try {
      expect(await detectClashForPath(dir, 'f.txt')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
