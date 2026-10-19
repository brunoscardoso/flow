// Wave side-identity provider (conflict-UX Phase 6) — the plan-flow parallel-agent
// counterpart to git's conflict-context SideIdentityProvider. A git conflict labels
// its two sides by branch/author; an AGENT CLASH labels them by the PLAN PHASE and
// TASK that authored each side. This provider satisfies the SAME
// `SideIdentityProvider` interface git's does, so the SAME IdentityChip renders a
// clash side ("Phase 3 · task-2") exactly as it renders a merge side — one chip,
// one code path (allowed-pattern #14), no clash-specific renderer branch.
//
// Pure and DOM-free (mirrors identity-chip-parts.ts): the label is derived from the
// clash side's phase/task, reusing `phaseLabel` so the "Phase N" wording lives in
// exactly one place. No git, no Electron — unit-testable under plain-Node jest.

import type { AgentClashInfo, AgentClashSide } from '../../shared/ipc-contract'
import type {
  SideIdentity,
  SideIdentityContext,
  SideIdentityProvider,
} from '../../shared/side-identity'
import { phaseLabel } from './review-service'

/**
 * The human label for one clash side — `Phase N · task-M`, or just `Phase N`
 * when the commit omitted `.task-M`. Reuses {@link phaseLabel} for the "Phase N"
 * wording (feeding it the bare `phase-N` id the clash side carries as a number),
 * then appends the task. NEVER emits a stage word (ours/theirs/current/incoming) —
 * a clash has no branch sides, only phase/task authorship.
 */
export function waveSideLabel(side: AgentClashSide): string {
  const base = phaseLabel(`phase-${side.phase}`)
  return side.task !== null ? `${base} · task-${side.task}` : base
}

/**
 * Build a {@link SideIdentity} for one clash side. The phase/task label rides the
 * `branch` field — the first link in identity-chip-parts' primary-label chain — so
 * the chip surfaces "Phase N · task-M". `isCurrentUser` is always false: a phase is
 * an autonomous agent, never the repo's configured user, so the chip never says
 * "you" for a clash side. The side's commit backs `ref`/`hash`/`subject` for the
 * short-hash fallback and diagnostics.
 */
export function waveSideIdentity(kind: 'ours' | 'theirs', side: AgentClashSide): SideIdentity {
  return {
    kind,
    ref: side.commit,
    branch: waveSideLabel(side),
    hash: side.commit,
    subject: side.subject || undefined,
    isCurrentUser: false,
  }
}

/**
 * A {@link SideIdentityProvider} bound to one reconstructed {@link AgentClashInfo}.
 * `identify('ours')` returns side A's identity, `identify('theirs')` side B's — the
 * lower-numbered phase is always side A (mirroring the git-side `ours`/`theirs`
 * stage mapping the resolver already speaks). The `SideIdentityContext` argument is
 * accepted for interface conformance but ignored: a clash's identity comes from the
 * clash data in this closure, not from a git merge state (there is none).
 */
export function createWaveSideIdentityProvider(clash: AgentClashInfo): SideIdentityProvider {
  return {
    identify(side: 'ours' | 'theirs', _ctx: SideIdentityContext): SideIdentity {
      const clashSide = side === 'ours' ? clash.sideA : clash.sideB
      return waveSideIdentity(side, clashSide)
    },
  }
}
