// The autopilot chain's two gates, wired to the bundled CLI: the stage gate
// (did the step before this one leave its proof?) and the publish gate (was
// this run's risk recorded, and is it publishable?).
//
// WHERE THEY LOOK IS THE WHOLE POINT OF THIS MODULE. Both verbs read the
// project's `flow/` — the discovery document, the plan, `.rounds.jsonl` — and
// a thread with its own worktree writes all of those in ITS checkout, whose
// `flow/` is a separate directory from the main one. These gates used to be
// inline in main's bootstrap and asked about `thread.projectRoot`, the main
// checkout, where a worktree thread's documents never are:
//
//   target = main checkout      → "discovery has left no proof" (refused)
//   target = thread's worktree  → "create-plan may run"         (satisfied)
//
// So every chain on a thread with a worktree stopped after discovery, having
// done it perfectly — reproduced live on thread "auto update not working"
// (2026-09-30), and invisible to the suite because the wiring had no test.
// They now ask `sessionRootFor(thread)`, the same answer the agent session's
// cwd, permissions and containment use (allowed-pattern #14).

import { sessionRootFor } from '../project/session-root'
import type { CliRunResult } from '../agent/learn-session'
import { parseCliJson } from '../git/thread-merge'
import type { RiskGateInput, TailStep } from './chain-tail'
import {
  STAGE_UNCHECKED,
  stageGateReason,
  type StageGateInput,
  type StageGateStep,
  type StageRefusalReason,
} from './stage-gate'

export interface ChainGateDeps {
  getThread: (threadId: string) => { projectRoot: string; worktreePath: string | null } | null
  /** Runs the bundled CLI in `cwd` — async and timeout-bounded, never on main's thread. */
  runCli: (cwd: string, args: readonly string[]) => Promise<CliRunResult>
}

const THREAD_GONE = 'This conversation is no longer here.'

/**
 * THE STAGE GATE, BEFORE THE NEXT RUNG IS ISSUED — the seam #1915 shipped
 * without (review C2). One code path with the person's own manual call
 * (allowed-pattern #14): the same verb, spawned async and timeout-bounded,
 * never synchronously on the process every window waits behind
 * (allowed-pattern #19).
 */
export function makeStageCheck(deps: ChainGateDeps): (input: StageGateInput) => Promise<StageGateStep> {
  return async ({ threadId, chainId, feature, stage, previous }) => {
    const thread = deps.getThread(threadId)
    if (thread === null) return { ok: false, detail: THREAD_GONE }
    const root = sessionRootFor(thread)
    const result = await deps.runCli(root, [
      'flow',
      'stage',
      stage,
      '--check',
      '--target',
      root,
      '--feature',
      feature,
      // THE CHAIN ID IS THE ENFORCEMENT. Without it the verb computes the
      // identical verdict and exits 0 — which is right for a person asking,
      // and would make this call a very expensive no-op.
      '--chain',
      chainId,
      '--json',
    ])
    const transcript = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    if (result.ok) {
      // THE VERDICT IS READ, NOT INFERRED FROM THE EXIT CODE (#1915 L1): a
      // clearance has to name THIS run and THIS feature, or it is an answer to
      // somebody else's question.
      const verdict = parseCliJson<{
        stage?: { satisfied?: unknown; chain?: unknown; feature?: unknown }
      }>(transcript)?.stage
      if (verdict?.satisfied === true && verdict.chain === chainId && verdict.feature === feature) {
        return { ok: true, detail: 'The step before this one left what it should have.' }
      }
      return { ok: false, detail: STAGE_UNCHECKED }
    }
    // THE REASON, NOT THE REMEDY (forbidden-pattern #12). The payload names the
    // document, the directory and the module that read it — right for a
    // terminal refusal, and never for something a person reads here. The
    // diagnostic half goes to the log, where it is a developer's business.
    const refusal = parseCliJson<{ refused?: string; message?: string }>(transcript)
    const reason =
      refusal?.refused === 'predecessor-missing' || refusal?.refused === 'predecessor-unreadable'
        ? (refusal.refused as StageRefusalReason)
        : null
    console.warn('[AutopilotChain] a stage was refused by the ladder', {
      threadId,
      stage,
      previous,
      feature,
      root,
      detail: refusal?.message ?? transcript.trim().slice(-400),
    })
    return { ok: false, detail: stageGateReason(reason, { stage, previous }) }
  }
}

/**
 * THE PUBLISH GATE, BEFORE ANYTHING IS PUBLISHED. One code path with the
 * `/execute-plan` skill (allowed-pattern #14): both call the same CLI verb,
 * which reads the risk assessment the run recorded and never judges risk
 * itself. Scoped by the instant the chain began and by its id — only an
 * assessment recorded under this chain can clear this publish (#1915 C1).
 */
export function makeRiskCheck(deps: ChainGateDeps): (input: RiskGateInput) => Promise<TailStep> {
  return async ({ threadId, chainId, since }) => {
    const thread = deps.getThread(threadId)
    if (thread === null) return { ok: false, detail: THREAD_GONE }
    const root = sessionRootFor(thread)
    const result = await deps.runCli(root, [
      'flow',
      'risk',
      '--check',
      '--target',
      root,
      '--since',
      since,
      '--chain',
      chainId,
      '--json',
    ])
    const transcript = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    if (result.ok) {
      // THE IDENTITY IS CHECKED, NOT ASSUMED (#1915 L1): the clearance has to
      // name THIS chain, or it is a held publish, not a silent wrong answer.
      const cleared = parseCliJson<{ risk?: { chain?: unknown; satisfied?: unknown } }>(transcript)?.risk
      if (cleared?.satisfied !== true || cleared.chain !== chainId) {
        return {
          ok: false,
          detail: 'The risk assessment that cleared this work belongs to a different run, so it was not published.',
        }
      }
      return { ok: true, detail: 'This work may be published.' }
    }
    // THE REASON, NOT THE REMEDY (forbidden-pattern #12). The payload's own
    // rationale is the coordinator's sentence about the changeset, so it is the
    // one part of the refusal worth showing.
    const refusal = parseCliJson<{ refused?: string; rationale?: string }>(transcript)
    const reason = typeof refusal?.refused === 'string' ? refusal.refused : null
    const rationale =
      typeof refusal?.rationale === 'string' && refusal.rationale.trim().length > 0 ? ` ${refusal.rationale}` : ''
    return {
      ok: false,
      detail:
        reason === 'risk-high'
          ? `This work was rated high risk, so it was not published — your say-so is needed.${rationale}`
          : 'Nothing recorded how risky this work is, so it was not published.',
    }
  }
}
