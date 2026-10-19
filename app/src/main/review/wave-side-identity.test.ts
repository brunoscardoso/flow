// Wave side-identity tests (conflict-UX Phase 6) — the phase/task-labeled
// SideIdentity provider that lets a plan-flow agent clash render through the
// SAME IdentityChip a git conflict does. Pure logic, no repo.

import type { AgentClashInfo, AgentClashSide } from '../../shared/ipc-contract'
import { identityChipParts } from '../../renderer/editor/identity-chip-parts'
import {
  createWaveSideIdentityProvider,
  waveSideIdentity,
  waveSideLabel,
} from './wave-side-identity'

function side(phase: number, task: number | null): AgentClashSide {
  return {
    phase,
    task,
    feature: 'my-feature',
    commit: `c${phase}${task ?? 'x'}0000`,
    subject: `feat(phase-${phase}.task-${task}): edit — my-feature`,
  }
}

describe('waveSideLabel', () => {
  it('labels a side "Phase N · task-M"', () => {
    expect(waveSideLabel(side(3, 2))).toBe('Phase 3 · task-2')
  })

  it('drops the task suffix when the commit omitted it', () => {
    expect(waveSideLabel(side(4, null))).toBe('Phase 4')
  })

  it('never emits a stage word', () => {
    const label = waveSideLabel(side(7, 1))
    expect(label).not.toMatch(/ours|theirs|current|incoming/i)
  })
})

describe('waveSideIdentity', () => {
  it('carries the phase/task label on `branch` and is never the current user', () => {
    const identity = waveSideIdentity('ours', side(3, 1))
    expect(identity.kind).toBe('ours')
    expect(identity.branch).toBe('Phase 3 · task-1')
    expect(identity.ref).toBe('c310000')
    expect(identity.hash).toBe('c310000')
    expect(identity.isCurrentUser).toBe(false)
  })

  it('renders through the SAME IdentityChip as a git side', () => {
    const parts = identityChipParts(waveSideIdentity('theirs', side(4, 2)), { side: 'b' })
    // The chip's primary label is the phase/task string — no "you", no stage word.
    expect(parts.primary).toBe('Phase 4 · task-2')
    expect(parts.isYou).toBe(false)
    expect(parts.primary).not.toMatch(/theirs|incoming/i)
  })
})

describe('createWaveSideIdentityProvider', () => {
  const clash: AgentClashInfo = {
    filePath: 'src/f.ts',
    base: 'base0000',
    sideA: side(3, 1),
    sideB: side(4, 2),
  }

  it("maps 'ours' → side A and 'theirs' → side B (lower phase is A)", () => {
    const provider = createWaveSideIdentityProvider(clash)
    const ctx = { rootPath: '/root', mergeState: { op: 'none' as const, unmergedPaths: [] } }
    expect(provider.identify('ours', ctx)).toMatchObject({
      kind: 'ours',
      branch: 'Phase 3 · task-1',
    })
    expect(provider.identify('theirs', ctx)).toMatchObject({
      kind: 'theirs',
      branch: 'Phase 4 · task-2',
    })
  })

  it('ignores the merge-state context (a clash has no git merge)', () => {
    const provider = createWaveSideIdentityProvider(clash)
    // A wildly different mergeState must not change the phase-derived identity.
    const ctx = {
      rootPath: '/elsewhere',
      mergeState: { op: 'rebase' as const, unmergedPaths: ['x', 'y'] },
      filePath: 'unrelated.ts',
    }
    expect(provider.identify('ours', ctx)).toMatchObject({ branch: 'Phase 3 · task-1' })
  })
})
