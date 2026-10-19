// PhaseMap + ReviewService tests — attribution by file (not time), grouping,
// and the "Other changes" fallback. Uses a temp flow/.wave-context.jsonl and a
// fake git status (no real git / no subprocess).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { GitStatus } from '../../shared/ipc-contract'
import { matchesGlobToken, readPhaseMap } from './phase-map'
import {
  ReviewService,
  dedupeBarePhases,
  phaseLabel,
  suggestCommitMessage,
  toReviewFile,
  type ReviewGit,
} from './review-service'

function writeWaveContext(root: string, lines: string): void {
  mkdirSync(join(root, 'flow'), { recursive: true })
  writeFileSync(join(root, 'flow', '.wave-context.jsonl'), lines, 'utf8')
}

function writePlan(root: string, name: string, body: string, where: 'plans' | 'archive' = 'plans'): void {
  mkdirSync(join(root, 'flow', where), { recursive: true })
  writeFileSync(join(root, 'flow', where, name), body, 'utf8')
}

function progress(agent: string, files: string[]): string {
  return JSON.stringify({ agent, type: 'progress', data: { task: 1, status: 'done', files_modified: files } })
}

function fakeGit(
  changed: Array<{
    filePath: string
    state: GitStatus['changes'][number]['state']
    staged?: boolean
    worktreeState?: GitStatus['changes'][number]['worktreeState']
  }>,
): ReviewGit {
  const status: GitStatus = {
    rootId: '/repo',
    branch: 'main',
    ahead: 0,
    behind: 0,
    dirty: changed.length > 0,
    changes: changed.map((c) => ({
      filePath: c.filePath,
      state: c.state,
      staged: c.staged ?? false,
      ...(c.worktreeState !== undefined ? { worktreeState: c.worktreeState } : {}),
    })),
  }
  return { status: async () => status, revertFile: async () => undefined }
}

describe('phaseLabel', () => {
  it('renders scoped keys with the feature and bare keys without (#144)', () => {
    expect(phaseLabel('auth#phase-2')).toBe('Phase 2 · auth')
    expect(phaseLabel('rainbow-theme#phase-10')).toBe('Phase 10 · rainbow-theme')
    expect(phaseLabel('phase-2')).toBe('Phase 2')
    expect(phaseLabel('weird')).toBe('weird')
  })
})

describe('matchesGlobToken (#251)', () => {
  it('anchors a directory-scoped glob to its directory, not just the suffix', () => {
    const token = 'app/src/main/review/*.ts'
    expect(matchesGlobToken(token, 'app/src/main/review/review-service.ts')).toBe(true)
    // A .ts file in ANOTHER directory must NOT match (the #251 bug).
    expect(matchesGlobToken(token, 'app/src/main/git/git-manager.ts')).toBe(false)
    // Wrong extension under the right directory is excluded too.
    expect(matchesGlobToken(token, 'app/src/main/review/notes.md')).toBe(false)
  })

  it('treats a leading-* token as a pure repo-wide suffix match', () => {
    expect(matchesGlobToken('*.test.ts', 'app/src/api.test.ts')).toBe(true)
    expect(matchesGlobToken('*.test.ts', 'deep/nested/x.test.ts')).toBe(true)
    expect(matchesGlobToken('*.test.ts', 'app/src/api.ts')).toBe(false)
  })

  it('handles a trailing-* (whole-directory) glob', () => {
    expect(matchesGlobToken('app/src/review/*', 'app/src/review/anything.tsx')).toBe(true)
    expect(matchesGlobToken('app/src/review/*', 'app/src/other/x.ts')).toBe(false)
  })
})

describe('dedupeBarePhases', () => {
  it('drops a bare phase-N when a scoped <feature>#phase-N is present (#144)', () => {
    expect([...dedupeBarePhases(new Set(['phase-2', 'auth#phase-2']))]).toEqual(['auth#phase-2'])
  })
  it('keeps a bare phase-N with no scoped sibling of the same number', () => {
    expect([...dedupeBarePhases(new Set(['phase-1', 'auth#phase-2'])).values()].sort()).toEqual([
      'auth#phase-2',
      'phase-1',
    ])
  })
  it('leaves a set with no scoped keys untouched', () => {
    const set = new Set(['phase-1', 'phase-2'])
    expect(dedupeBarePhases(set)).toBe(set)
  })
})

describe('readPhaseMap', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'flow-phasemap-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('returns an empty map when there is no wave-context file', async () => {
    expect((await readPhaseMap(root)).size).toBe(0)
  })

  it('maps files to their phase from progress entries and skips malformed lines', async () => {
    writeWaveContext(
      root,
      [
        progress('phase-1', ['src/a.ts']),
        '{ not json',
        JSON.stringify({ agent: 'phase-2', type: 'decision', data: {} }), // not progress
        progress('phase-2', ['src/b.ts', 'src/shared.ts']),
        progress('phase-3', ['src/shared.ts']), // shared across phases
      ].join('\n'),
    )
    const map = await readPhaseMap(root)
    expect([...(map.get('src/a.ts') ?? [])]).toEqual(['phase-1'])
    expect([...(map.get('src/b.ts') ?? [])]).toEqual(['phase-2'])
    expect([...(map.get('src/shared.ts') ?? [])].sort()).toEqual(['phase-2', 'phase-3'])
  })
})

describe('ReviewService.list', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'flow-review-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('groups changes by phase, sorts phases numerically, and puts unmapped in "Other changes" last', async () => {
    writeWaveContext(root, [progress('phase-2', ['src/b.ts']), progress('phase-10', ['src/j.ts'])].join('\n'))
    const git = fakeGit([
      { filePath: 'src/b.ts', state: 'modified', staged: false },
      { filePath: 'src/j.ts', state: 'modified', staged: false },
      { filePath: 'README.md', state: 'modified', staged: false }, // no phase → Other
    ])
    const service = new ReviewService(git)

    const { groups } = await service.list(root)
    expect(groups.map((g) => g.label)).toEqual(['Phase 2', 'Phase 10', 'Other changes'])
    expect(groups[0].files.map((f) => f.filePath)).toEqual(['src/b.ts'])
    expect(groups[2].phase).toBeNull()
    expect(groups[2].files.map((f) => f.filePath)).toEqual(['README.md'])
  })

  it('a file claimed by multiple phases appears under each', async () => {
    writeWaveContext(root, [progress('phase-1', ['src/x.ts']), progress('phase-2', ['src/x.ts'])].join('\n'))
    const service = new ReviewService(fakeGit([{ filePath: 'src/x.ts', state: 'modified', staged: false }]))
    const { groups } = await service.list(root)
    expect(groups.map((g) => g.label)).toEqual(['Phase 1', 'Phase 2'])
    expect(groups.every((g) => g.files[0].filePath === 'src/x.ts')).toBe(true)
  })

  it('groups by an ARCHIVED plan\'s multi-line Files list when wave-context is gone', async () => {
    // Real-world shape: plan archived on completion + the standard template's
    // `**Files**:` header followed by a bulleted list (my two original bugs).
    writePlan(
      root,
      'plan_demo_v1.md',
      [
        '### Phase 1 — Types',
        '**Files**:',
        '- `app/src/types.ts`',
        '- `app/src/util/`',
        '',
        '**Tasks**:',
        '- do a thing',
        '',
        '### Phase 2 — API',
        '**Files**:',
        '- `app/src/api.ts`',
        '- `*.test.ts`',
      ].join('\n'),
      'archive',
    )
    const git = fakeGit([
      { filePath: 'app/src/types.ts', state: 'modified', staged: false }, // Phase 1 (exact)
      { filePath: 'app/src/util/helpers.ts', state: 'modified', staged: false }, // Phase 1 (dir)
      { filePath: 'app/src/api.ts', state: 'modified', staged: false }, // Phase 2 (exact)
      { filePath: 'app/src/api.test.ts', state: 'added', staged: false }, // Phase 2 (glob)
      { filePath: 'README.md', state: 'modified', staged: false }, // Other
    ])
    const { groups } = await new ReviewService(git).list(root)
    const byLabel = new Map(groups.map((g) => [g.label, g.files.map((f) => f.filePath)]))
    // Plan-scoped labels carry the feature slug so two plans' phases are distinct (#144).
    expect(byLabel.get('Phase 1 · demo')?.sort()).toEqual(['app/src/types.ts', 'app/src/util/helpers.ts'])
    expect(byLabel.get('Phase 2 · demo')?.sort()).toEqual(['app/src/api.test.ts', 'app/src/api.ts'])
    expect(byLabel.get('Other changes')).toEqual(['README.md'])
    // Suggested commit messages come from the phase title + plan feature slug.
    expect(groups.find((g) => g.label === 'Phase 1 · demo')?.suggestedMessage).toBe('feat(demo): types')
  })

  it('does NOT collide phase-2 across two archived plans — each keeps its own files + message (#144)', async () => {
    // Archived plan A: phase-2 declares authService.ts (feature "auth").
    writePlan(
      root,
      'plan_auth_v1.md',
      ['### Phase 2 — Auth API', '**Files**:', '- `app/src/authService.ts`'].join('\n'),
      'archive',
    )
    // Active plan B: its OWN phase-2 declares theme.ts (feature "rainbow-theme").
    writePlan(
      root,
      'plan_rainbow_theme_v1.md',
      ['### Phase 2 — Rainbow theme', '**Files**:', '- `app/src/theme.ts`'].join('\n'),
    )
    const git = fakeGit([
      { filePath: 'app/src/authService.ts', state: 'modified', staged: false },
      { filePath: 'app/src/theme.ts', state: 'modified', staged: false },
    ])
    const { groups } = await new ReviewService(git).list(root)
    const byLabel = new Map(groups.map((g) => [g.label, g]))
    // Two DISTINCT groups, not one merged "Phase 2".
    expect(byLabel.get('Phase 2 · auth')?.files.map((f) => f.filePath)).toEqual(['app/src/authService.ts'])
    expect(byLabel.get('Phase 2 · rainbow-theme')?.files.map((f) => f.filePath)).toEqual(['app/src/theme.ts'])
    // Each group's suggested scope belongs to ITS plan (no first-read-wins bleed).
    expect(byLabel.get('Phase 2 · auth')?.suggestedMessage).toBe('feat(auth): auth api')
    expect(byLabel.get('Phase 2 · rainbow-theme')?.suggestedMessage).toBe('feat(rainbow-theme): rainbow theme')
  })

  it('does not double-group a file attributed by BOTH wave-context and its active plan (#144)', async () => {
    // During a run: wave-context emits a bare phase-2; the active plan declares
    // the same file under its scoped phase-2. Expect ONE group (the scoped one).
    writeWaveContext(root, progress('phase-2', ['app/src/theme.ts']))
    writePlan(
      root,
      'plan_rainbow_theme_v1.md',
      ['### Phase 2 — Rainbow theme', '**Files**:', '- `app/src/theme.ts`'].join('\n'),
    )
    const { groups } = await new ReviewService(fakeGit([{ filePath: 'app/src/theme.ts', state: 'modified', staged: false }])).list(root)
    expect(groups.map((g) => g.label)).toEqual(['Phase 2 · rainbow-theme'])
    expect(groups[0].files.map((f) => f.filePath)).toEqual(['app/src/theme.ts'])
  })

  it('a directory-scoped Files glob does not attribute files from OTHER directories (#251)', async () => {
    writePlan(
      root,
      'plan_demo_v1.md',
      ['### Phase 2 — Review service', '**Files**:', '- `app/src/main/review/*.ts`'].join('\n'),
      'archive',
    )
    const { groups } = await new ReviewService(
      fakeGit([
        { filePath: 'app/src/main/review/review-service.ts', state: 'modified', staged: false }, // in scope
        { filePath: 'app/src/main/git/git-manager.ts', state: 'modified', staged: false }, // .ts elsewhere
      ]),
    ).list(root)
    const byLabel = new Map(groups.map((g) => [g.label, g.files.map((f) => f.filePath)]))
    // Only the review/ file lands in Phase 2; git-manager.ts is Other changes.
    expect(byLabel.get('Phase 2 · demo')).toEqual(['app/src/main/review/review-service.ts'])
    expect(byLabel.get('Other changes')).toEqual(['app/src/main/git/git-manager.ts'])
  })

  it('drops a stale phase attribution once the file leaves git status, so an unrelated re-edit is Other changes (#250)', async () => {
    // A mutable git so the same ReviewService (which accumulates the snapshot)
    // sees the file committed, then re-edited.
    let changed: Array<{ filePath: string; state: GitStatus['changes'][number]['state']; staged?: boolean }> = [
      { filePath: 'src/config.ts', state: 'modified', staged: false },
    ]
    const git: ReviewGit = {
      status: async () => ({
        rootId: '/repo',
        branch: 'main',
        ahead: 0,
        behind: 0,
        dirty: changed.length > 0,
        changes: changed.map((c) => ({ filePath: c.filePath, state: c.state, staged: c.staged ?? false })),
      }),
      revertFile: async () => undefined,
    }
    const service = new ReviewService(git)

    // 1) During the run: wave-context attributes config.ts to phase-1.
    writeWaveContext(root, progress('phase-1', ['src/config.ts']))
    const during = await service.list(root)
    expect(during.groups.map((g) => g.label)).toContain('Phase 1')

    // 2) Plan done: wave-context deleted, config.ts committed (leaves git status).
    rmSync(join(root, 'flow', '.wave-context.jsonl'))
    changed = []
    await service.list(root) // prunes the now-stale snapshot entry

    // 3) Unrelated re-edit of config.ts, no plan running.
    changed = [{ filePath: 'src/config.ts', state: 'modified', staged: false }]
    const { groups } = await service.list(root)
    const byLabel = new Map(groups.map((g) => [g.label, g.files.map((f) => f.filePath)]))
    expect(byLabel.get('Phase 1')).toBeUndefined() // not under the old phase anymore
    expect(byLabel.get('Other changes')).toEqual(['src/config.ts'])
  })

  it('flags a staged file whose worktree moved on as unreviewedSinceApproval (#1052)', async () => {
    writeWaveContext(root, progress('phase-1', ['src/a.ts', 'src/b.ts']))
    const git = fakeGit([
      // Approved, then rewritten by the agent — porcelain `MM`.
      { filePath: 'src/a.ts', state: 'modified', staged: true, worktreeState: 'modified' },
      // Approved and untouched since — porcelain `M.`.
      { filePath: 'src/b.ts', state: 'modified', staged: true, worktreeState: null },
    ])
    const { groups } = await new ReviewService(git).list(root)
    const files = new Map(groups[0].files.map((f) => [f.filePath, f]))
    expect(files.get('src/a.ts')?.unreviewedSinceApproval).toBe(true)
    expect(files.get('src/b.ts')?.unreviewedSinceApproval).toBeUndefined()
  })

  describe('toReviewFile (#1052)', () => {
    it('flags staged + worktree-diverged, and only that', () => {
      expect(
        toReviewFile({ filePath: 'a.ts', state: 'modified', staged: true, worktreeState: 'modified' }),
      ).toEqual({ filePath: 'a.ts', state: 'modified', staged: true, unreviewedSinceApproval: true })
      // Staged only (index matches what was approved) — fresh.
      expect(
        toReviewFile({ filePath: 'a.ts', state: 'modified', staged: true, worktreeState: null }),
      ).toEqual({ filePath: 'a.ts', state: 'modified', staged: true })
      // Unstaged worktree change — never approved, nothing to invalidate.
      expect(
        toReviewFile({ filePath: 'a.ts', state: 'modified', staged: false, worktreeState: 'modified' }),
      ).toEqual({ filePath: 'a.ts', state: 'modified', staged: false })
    })

    it('never flags conflicted or sub-state-less legacy entries', () => {
      // Conflicted entries carry staged: false + null sub-states.
      expect(
        toReviewFile({ filePath: 'a.ts', state: 'conflicted', staged: false, indexState: null, worktreeState: null }),
      ).toEqual({ filePath: 'a.ts', state: 'conflicted', staged: false })
      // A status source that omits the optional sub-states cannot prove divergence.
      expect(toReviewFile({ filePath: 'a.ts', state: 'modified', staged: true })).toEqual({
        filePath: 'a.ts',
        state: 'modified',
        staged: true,
      })
    })
  })

  describe('suggestCommitMessage', () => {
    it('builds a conventional message from the phase title + feature', () => {
      expect(
        suggestCommitMessage('phase-2', [{ filePath: 'src/x.css', state: 'modified', staged: false }], {
          title: 'CSS Rainbow Palette',
          feature: 'rainbow-theme',
        }),
      ).toBe('feat(rainbow-theme): css rainbow palette')
    })

    it('uses the test type for a tests phase', () => {
      expect(
        suggestCommitMessage('phase-6', [{ filePath: 'a.test.ts', state: 'added', staged: false }], {
          title: 'Tests',
          feature: 'rainbow-theme',
        }),
      ).toBe('test(rainbow-theme): add tests')
    })

    it('gives "Other changes" a neutral message', () => {
      expect(
        suggestCommitMessage(null, [{ filePath: 'README.md', state: 'modified', staged: false }], undefined),
      ).toBe('docs: update files')
    })
  })

  it('reject delegates the revert to git for the given file', async () => {
    const reverted: string[] = []
    const git: ReviewGit = {
      status: async () => null,
      revertFile: async (_root, filePath) => {
        reverted.push(filePath)
      },
    }
    await new ReviewService(git).reject(root, 'src/x.ts')
    expect(reverted).toEqual(['src/x.ts'])
  })

  it('remembers phase attribution after wave-context is deleted (snapshot)', async () => {
    writeWaveContext(root, progress('phase-1', ['src/a.ts']))
    const service = new ReviewService(fakeGit([{ filePath: 'src/a.ts', state: 'modified', staged: false }]))
    await service.list(root) // snapshot taken
    rmSync(join(root, 'flow', '.wave-context.jsonl')) // plan-flow cleans up

    const { groups } = await service.list(root)
    expect(groups.map((g) => g.label)).toEqual(['Phase 1'])
  })
})
