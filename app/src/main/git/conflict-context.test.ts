// Conflict-context assembler tests (#66; Phase 10). `parsePlanFromCommit` is a
// pure parser, exercised across the atomic-commit grammar's optional slots.
// `assembleConflictContext` is driven entirely through its injectable
// `ConflictContextDeps` — no real repo, no brain — so provenance tiering,
// per-file ours/theirs mapping, and fail-soft degradation are pinned in isolation.

import {
  assembleConflictContext,
  parsePlanFromCommit,
  type CommitRef,
  type ConflictContextDeps,
} from './conflict-context'
import type { GitMergeState } from '../../shared/ipc-contract'
import type { RelevantRoundsEntry } from '../learn/learn-run-triggers'
// Cross-layer import (Phase 7): the DOM-free chip labeller the renderer uses to
// display each side — pulled in here to assert the op-derived identity produces
// the truthful LABEL a user actually sees (not just the raw identity object).
import { sideDisplayLabel } from '../../renderer/editor/identity-chip-parts'

describe('parsePlanFromCommit', () => {
  it('parses the full phase.task + feature convention', () => {
    expect(parsePlanFromCommit('feat(phase-3.task-2): add resolver — merge-conflicts')).toEqual({
      phase: 3,
      task: 2,
      feature: 'merge-conflicts',
    })
  })

  it('tolerates a missing task slot (phase-only)', () => {
    expect(parsePlanFromCommit('feat(phase-7): wire it up — some-feature')).toEqual({
      phase: 7,
      task: null,
      feature: 'some-feature',
    })
  })

  it('tolerates a missing feature suffix', () => {
    expect(parsePlanFromCommit('fix(phase-4.task-1): patch the thing')).toEqual({
      phase: 4,
      task: 1,
      feature: null,
    })
  })

  it('accepts other type prefixes (fix/chore/refactor)', () => {
    expect(parsePlanFromCommit('chore(phase-1): tidy')?.phase).toBe(1)
    expect(parsePlanFromCommit('refactor(phase-2.task-9): extract')?.task).toBe(9)
  })

  it('returns null for a non-conforming subject', () => {
    expect(parsePlanFromCommit('just a normal commit message')).toBeNull()
    expect(parsePlanFromCommit('feat: no phase here')).toBeNull()
  })

  it('does not match a stray "phase-N" mid-message (anchored both ends)', () => {
    expect(parsePlanFromCommit('note about phase-3.task-2 in prose')).toBeNull()
  })

  it('returns null on non-string input', () => {
    expect(parsePlanFromCommit(undefined as unknown as string)).toBeNull()
  })
})

// ── assembleConflictContext ────────────────────────────────────────────────

const PLAN_SUBJECT = 'feat(phase-2.task-1): resolver — feat-x'

/** A merge state with two unmerged files and a MERGE_HEAD present. */
function mergeState(paths: string[]): GitMergeState {
  return { op: 'merge', mergeHead: 'deadbeef', unmergedPaths: paths }
}

/** Deps whose lookups all succeed but return nothing — the neutral baseline.
 *  `currentUser`/`fileAuthors` are stubbed empty so no real git is spawned. */
function emptyDeps(overrides: Partial<ConflictContextDeps> = {}): ConflictContextDeps {
  return {
    logSideCommits: async () => [],
    readRoundsEntries: async () => [],
    queryBlueprint: async () => null,
    currentUser: async () => ({}),
    fileAuthors: async () => new Map(),
    ...overrides,
  }
}

describe('assembleConflictContext', () => {
  it('returns [] when there are no unmerged paths', async () => {
    const result = await assembleConflictContext('/root', mergeState([]), emptyDeps())
    expect(result).toEqual([])
  })

  it('recovers plan provenance when the newest commit maps to the convention', async () => {
    const deps = emptyDeps({
      logSideCommits: async (_root, includeRef) =>
        includeRef === 'HEAD'
          ? [{ hash: 'a1', subject: PLAN_SUBJECT }]
          : [{ hash: 'b1', subject: 'their plain change' }],
    })
    const [ctx] = await assembleConflictContext('/root', mergeState(['src/a.ts']), deps)
    expect(ctx.file).toBe('src/a.ts')
    expect(ctx.ours.source).toBe('plan')
    expect(ctx.ours.plan).toEqual({ phase: 2, task: 1, feature: 'feat-x' })
    expect(ctx.theirs.source).toBe('commit')
    expect(ctx.theirs.plan).toBeNull()
  })

  it('degrades a side with no commits to the diff tier', async () => {
    const deps = emptyDeps({
      logSideCommits: async (_root, includeRef) =>
        includeRef === 'HEAD' ? [{ hash: 'a1', subject: PLAN_SUBJECT }] : [],
    })
    const [ctx] = await assembleConflictContext('/root', mergeState(['src/a.ts']), deps)
    expect(ctx.theirs.source).toBe('diff')
    expect(ctx.theirs.commits).toEqual([])
  })

  it('maps ours=HEAD/theirs=MERGE_HEAD per file with the right exclusions', async () => {
    const calls: Array<{ includeRef: string; excludeRef: string | null; file: string }> = []
    const deps = emptyDeps({
      logSideCommits: async (_root, includeRef, excludeRef, file) => {
        calls.push({ includeRef, excludeRef, file })
        return []
      },
    })
    await assembleConflictContext('/root', mergeState(['src/a.ts']), deps)
    expect(calls).toContainEqual({ includeRef: 'HEAD', excludeRef: 'MERGE_HEAD', file: 'src/a.ts' })
    expect(calls).toContainEqual({ includeRef: 'MERGE_HEAD', excludeRef: 'HEAD', file: 'src/a.ts' })
  })

  it('assembles a context object per unmerged file', async () => {
    const result = await assembleConflictContext('/root', mergeState(['a.ts', 'b.ts']), emptyDeps())
    expect(result.map((c) => c.file)).toEqual(['a.ts', 'b.ts'])
  })

  it('uses the brain blueprint hit when one is returned', async () => {
    const deps = emptyDeps({ queryBlueprint: async (_root, file) => `note for ${file}` })
    const [ctx] = await assembleConflictContext('/root', mergeState(['src/a.ts']), deps)
    expect(ctx.blueprint).toBe('note for src/a.ts')
  })

  it('falls back to a rounds phase_result run-id when brain has no hit', async () => {
    const rounds: RelevantRoundsEntry[] = [
      { type: 'phase_result', run_id: 'run-42', moduleAnchors: ['src/'] },
    ]
    const deps = emptyDeps({ readRoundsEntries: async () => rounds })
    const [ctx] = await assembleConflictContext('/root', mergeState(['src/a.ts']), deps)
    expect(ctx.blueprint).toBe('Touched by plan run run-42')
  })

  it('degrades the theirs side to diff for a non-merge op (no MERGE_HEAD)', async () => {
    const rebase: GitMergeState = { op: 'rebase', unmergedPaths: ['src/a.ts'] }
    const deps = emptyDeps({
      logSideCommits: async (_root, includeRef) =>
        includeRef === 'HEAD' ? [{ hash: 'a1', subject: 'ours only' }] : [],
    })
    const [ctx] = await assembleConflictContext('/root', rebase, deps)
    expect(ctx.ours.source).toBe('commit')
    expect(ctx.theirs.source).toBe('diff')
    expect(ctx.theirs.commits).toEqual([])
  })

  it('is fail-soft when logSideCommits throws (degrades that side, never throws)', async () => {
    const deps = emptyDeps({
      logSideCommits: async () => {
        throw new Error('git blew up')
      },
    })
    const result = await assembleConflictContext('/root', mergeState(['src/a.ts']), deps)
    expect(result[0].ours.source).toBe('diff')
    expect(result[0].theirs.source).toBe('diff')
  })

  it('is fail-soft when queryBlueprint throws (blueprint degrades to null)', async () => {
    const deps = emptyDeps({
      queryBlueprint: async () => {
        throw new Error('brain down')
      },
    })
    const [ctx] = await assembleConflictContext('/root', mergeState(['src/a.ts']), deps)
    expect(ctx.blueprint).toBeNull()
  })

  it('is fail-soft when readRoundsEntries throws (assembly still completes)', async () => {
    const deps = emptyDeps({
      readRoundsEntries: async () => {
        throw new Error('rounds unreadable')
      },
    })
    const result = await assembleConflictContext('/root', mergeState(['src/a.ts']), deps)
    expect(result).toHaveLength(1)
    expect(result[0].blueprint).toBeNull()
  })

  it('INVERTS the rebase mapping: ours logs from HEAD, theirs from the replayed tip (rebaseHead)', async () => {
    const rebase: GitMergeState = {
      op: 'rebase',
      ontoBranch: 'feature',
      incomingRef: 'abc123', // onto base (ours-side exclude)
      rebaseHead: 'def456', // replayed branch tip (theirs ref)
      unmergedPaths: ['src/a.ts'],
    }
    const calls: Array<{ includeRef: string; excludeRef: string | null }> = []
    const deps = emptyDeps({
      logSideCommits: async (_root, includeRef, excludeRef) => {
        calls.push({ includeRef, excludeRef })
        return []
      },
    })
    const [ctx] = await assembleConflictContext('/root', rebase, deps)
    // ours = HEAD (onto lineage), theirs = the replayed commit — NOT MERGE_HEAD.
    expect(calls).toContainEqual({ includeRef: 'HEAD', excludeRef: 'def456' })
    expect(calls).toContainEqual({ includeRef: 'def456', excludeRef: 'abc123' })
    // The branch being replayed surfaces on the THEIRS identity (the inversion).
    expect(ctx.theirsIdentity?.kind).toBe('theirs')
    expect(ctx.theirsIdentity?.branch).toBe('feature')
    expect(ctx.oursIdentity?.kind).toBe('ours')
    expect(ctx.oursIdentity?.ref).toBe('HEAD')
  })

  it('maps a cherry-pick to CHERRY_PICK_HEAD for the theirs side', async () => {
    const cherry: GitMergeState = {
      op: 'cherry-pick',
      cherryPickHead: 'cafe01',
      incomingRef: 'cafe01',
      unmergedPaths: ['src/a.ts'],
    }
    const calls: Array<{ includeRef: string; excludeRef: string | null }> = []
    const deps = emptyDeps({
      logSideCommits: async (_root, includeRef, excludeRef) => {
        calls.push({ includeRef, excludeRef })
        return []
      },
    })
    await assembleConflictContext('/root', cherry, deps)
    expect(calls).toContainEqual({ includeRef: 'HEAD', excludeRef: 'CHERRY_PICK_HEAD' })
    expect(calls).toContainEqual({ includeRef: 'CHERRY_PICK_HEAD', excludeRef: 'HEAD' })
  })

  it('flags isCurrentUser when a side author matches the configured user (by email)', async () => {
    const deps = emptyDeps({
      currentUser: async () => ({ name: 'Me', email: 'me@example.com' }),
      logSideCommits: async (_root, includeRef) =>
        includeRef === 'HEAD'
          ? [{ hash: 'a1', subject: 'mine', author: 'Me', email: 'me@example.com', when: '2026-07-21' }]
          : [{ hash: 'b1', subject: 'theirs', author: 'Other', email: 'other@example.com' }],
    })
    const [ctx] = await assembleConflictContext('/root', mergeState(['src/a.ts']), deps)
    expect(ctx.oursIdentity?.author).toBe('Me')
    expect(ctx.oursIdentity?.isCurrentUser).toBe(true)
    expect(ctx.oursIdentity?.when).toBe('2026-07-21')
    expect(ctx.theirsIdentity?.author).toBe('Other')
    expect(ctx.theirsIdentity?.isCurrentUser).toBe(false)
  })

  it('falls back to the HEAD file author for the ours identity when no side commits', async () => {
    const deps = emptyDeps({
      currentUser: async () => ({ name: 'Me', email: 'me@example.com' }),
      fileAuthors: async () =>
        new Map([['src/a.ts', { author: 'Me', email: 'me@example.com', hash: 'h1', date: '2026-01-01' }]]),
    })
    const [ctx] = await assembleConflictContext('/root', mergeState(['src/a.ts']), deps)
    expect(ctx.oursIdentity?.author).toBe('Me')
    expect(ctx.oursIdentity?.isCurrentUser).toBe(true)
    expect(ctx.oursIdentity?.hash).toBe('h1')
  })

  it('classifies as commit (not plan) when the newest commit is not a plan commit', async () => {
    const commits: CommitRef[] = [
      { hash: 'a1', subject: 'random work' },
      { hash: 'a2', subject: PLAN_SUBJECT }, // older — must NOT be used
    ]
    const deps = emptyDeps({
      logSideCommits: async (_root, includeRef) => (includeRef === 'HEAD' ? commits : []),
    })
    const [ctx] = await assembleConflictContext('/root', mergeState(['src/a.ts']), deps)
    expect(ctx.ours.source).toBe('commit')
    expect(ctx.ours.plan).toBeNull()
  })
})

// ── Cross-cutting (Phase 7): resolved identity → chip LABEL, per operation ─────
//
// The conflict-context tests above pin the ref MAPPING and the raw identity
// objects. This block closes the remaining gap: it drives assembleConflictContext's
// op-derived `oursIdentity`/`theirsIdentity` through the DOM-free chip labeller
// (`sideDisplayLabel`, the exact function the merge-editor + keep-controls render)
// and asserts the LABEL a user actually sees. It proves the merge↔rebase inversion
// at the label level, that each operation surfaces the RIGHT side-B branch/ref, and
// — the redesign's core invariant — that no rendered side label leaks a stage word.

/** The four words the identity redesign must never surface (they invert per op). */
const STAGE_WORD = /\b(ours|theirs|current|incoming)\b/i

/** Deps handing one labelled commit to each side: the HEAD (ours) side and,
 *  for whatever the operation's theirs ref is, the incoming side. Lets the
 *  resolved theirs identity carry a real author/subject to label. */
function twoSidedDeps(): ConflictContextDeps {
  return emptyDeps({
    logSideCommits: async (_root, includeRef) =>
      includeRef === 'HEAD'
        ? [{ hash: 'aaaaaaa', subject: 'ours work', author: 'Ada', email: 'ada@x.io', when: '2026-07-20' }]
        : [{ hash: 'bbbbbbb', subject: 'their work', author: 'Bo', email: 'bo@x.io', when: '2026-07-20' }],
  })
}

describe('resolved identity renders truthful, stage-word-free side labels per op (Phase 7)', () => {
  it('merge: side B labels the INCOMING branch, side A the HEAD ref — no stage words', async () => {
    const state: GitMergeState = {
      op: 'merge',
      mergeHead: 'deadbeef',
      incomingBranch: 'feature-blue',
      unmergedPaths: ['src/a.ts'],
    }
    const [ctx] = await assembleConflictContext('/root', state, twoSidedDeps())
    const a = sideDisplayLabel(ctx.oursIdentity, { side: 'a' })
    const b = sideDisplayLabel(ctx.theirsIdentity, { side: 'b' })
    expect(a).toBe('HEAD')
    expect(b).toBe('feature-blue')
    expect(a).not.toMatch(STAGE_WORD)
    expect(b).not.toMatch(STAGE_WORD)
  })

  it('rebase INVERSION: side B labels the REPLAYED branch (head-name), never the onto base', async () => {
    const state: GitMergeState = {
      op: 'rebase',
      ontoBranch: 'my-feature', // the branch being replayed = the THEIRS side
      incomingRef: 'abc123', // onto base (ours-side exclude)
      rebaseHead: 'def456', // replayed tip (theirs ref)
      unmergedPaths: ['src/a.ts'],
    }
    const [ctx] = await assembleConflictContext('/root', state, twoSidedDeps())
    // Side A (ours) surfaces the onto base — the ours-side ref during a rebase —
    // as its display label (L3), never a bare stage word.
    expect(sideDisplayLabel(ctx.oursIdentity, { side: 'a' })).toBe('abc123')
    expect(sideDisplayLabel(ctx.oursIdentity, { side: 'a' })).not.toMatch(STAGE_WORD)
    // The inversion, at the label: the replayed branch is THEIRS, not ours.
    expect(sideDisplayLabel(ctx.theirsIdentity, { side: 'b' })).toBe('my-feature')
    expect(sideDisplayLabel(ctx.theirsIdentity, { side: 'b' })).not.toMatch(STAGE_WORD)
  })

  it('cherry-pick: side B labels the CHERRY_PICK_HEAD ref (no branch) — still no stage word', async () => {
    const state: GitMergeState = {
      op: 'cherry-pick',
      cherryPickHead: 'cafe01',
      incomingRef: 'cafe01',
      unmergedPaths: ['src/a.ts'],
    }
    const [ctx] = await assembleConflictContext('/root', state, twoSidedDeps())
    const b = sideDisplayLabel(ctx.theirsIdentity, { side: 'b' })
    expect(b).toBe('CHERRY_PICK_HEAD')
    expect(b).not.toMatch(STAGE_WORD)
  })

  it('the three operations yield DISTINCT side-B labels (op-aware mapping, not hardcoded)', async () => {
    const [merge] = await assembleConflictContext(
      '/root',
      { op: 'merge', mergeHead: 'd', incomingBranch: 'feature-blue', unmergedPaths: ['a'] },
      twoSidedDeps(),
    )
    const [rebase] = await assembleConflictContext(
      '/root',
      { op: 'rebase', ontoBranch: 'my-feature', incomingRef: 'abc', rebaseHead: 'def', unmergedPaths: ['a'] },
      twoSidedDeps(),
    )
    const [cherry] = await assembleConflictContext(
      '/root',
      { op: 'cherry-pick', cherryPickHead: 'cafe01', incomingRef: 'cafe01', unmergedPaths: ['a'] },
      twoSidedDeps(),
    )
    const labels = [merge, rebase, cherry].map((ctx) =>
      sideDisplayLabel(ctx.theirsIdentity, { side: 'b' }),
    )
    // Three operations, three different truthful labels — a hardcoded "theirs"
    // would have collapsed them to one.
    expect(new Set(labels).size).toBe(3)
    for (const label of labels) expect(label).not.toMatch(STAGE_WORD)
  })
})
