/**
 * THE AGENT'S LAUNCHPAD SCRIPTS, BETWEEN ARRIVING AND BEING SHOWN.
 *
 * "Fix with the agent" sends one message and waits. The agent answers with
 * the `launchpad_set_script` tool, and main hands the script to this window
 * for one conversation. Two facts have to outlive the Launchpad page:
 *   - WAITING: which action of which conversation is waiting, and what it held
 *     when the person pressed the button (to tell whether they typed since);
 *   - PENDING: a script that arrived while the page was closed — it is shown
 *     the next time the page opens for that conversation.
 *
 * And one decision, made the same way whenever a script arrives: which action
 * it is for, and whether it replaces the draft or is only offered.
 *
 * DOM-free and tested. Nothing here saves or runs anything.
 */
import type { RunBody, RunScriptProposal } from '../../shared/run-setup'
import type { DraftStep, RunSetupDraft } from './run-setup-model'

/** One action waiting for the agent, and what it held at the press. */
export interface AgentScriptWait {
  stepId: string
  /** The action name the message used. */
  action: string
  body: RunBody
  script: string
  command: string
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

export class ScriptProposalStore {
  readonly #waiting = new Map<string, AgentScriptWait[]>()
  readonly #pending = new Map<string, RunScriptProposal[]>()

  /** The person pressed the button: this action waits (a second press replaces the first). */
  wait(threadId: string, wait: AgentScriptWait): void {
    const list = (this.#waiting.get(threadId) ?? []).filter((entry) => entry.stepId !== wait.stepId)
    list.push(wait)
    this.#waiting.set(threadId, list)
  }

  /** "Stop waiting", or the script arrived: the action no longer waits. */
  stopWaiting(threadId: string, stepId: string): void {
    const list = (this.#waiting.get(threadId) ?? []).filter((entry) => entry.stepId !== stepId)
    if (list.length === 0) this.#waiting.delete(threadId)
    else this.#waiting.set(threadId, list)
  }

  waitingFor(threadId: string, stepId: string): AgentScriptWait | null {
    return this.#waiting.get(threadId)?.find((entry) => entry.stepId === stepId) ?? null
  }

  waits(threadId: string): AgentScriptWait[] {
    return [...(this.#waiting.get(threadId) ?? [])]
  }

  /** A script arrived while the page was closed: keep it (a newer one for the same action replaces it). */
  keep(proposal: RunScriptProposal): void {
    const list = (this.#pending.get(proposal.threadId) ?? []).filter((entry) => !sameName(entry.action, proposal.action))
    list.push(proposal)
    this.#pending.set(proposal.threadId, list)
  }

  /** The kept scripts of one conversation, handed over once. */
  take(threadId: string): RunScriptProposal[] {
    const list = this.#pending.get(threadId) ?? []
    this.#pending.delete(threadId)
    return list
  }
}

/** The one store of this window. */
export const scriptProposals = new ScriptProposalStore()

/**
 * What an arriving script does to the draft:
 *   - `replace` — the person did not type in that action since pressing (or,
 *     with no press on record, the action is as it was saved): the script
 *     goes into the editor;
 *   - `offer` — they typed meanwhile: their text stays, the script is offered;
 *   - `add` — no one-time action has that name: a new one is added holding it.
 */
export type ProposalOutcome =
  | { kind: 'replace'; stepId: string }
  | { kind: 'offer'; stepId: string }
  | { kind: 'add' }

function untouchedSince(step: DraftStep, was: Pick<AgentScriptWait, 'body' | 'script' | 'command'>): boolean {
  return step.body === was.body && step.script === was.script && step.command === was.command
}

export function proposalOutcome(
  draft: Pick<RunSetupDraft, 'steps' | 'original'>,
  proposal: Pick<RunScriptProposal, 'action'>,
  waits: readonly AgentScriptWait[],
): ProposalOutcome {
  const actions = draft.steps.filter((step) => step.kind === 'once')
  // The action that was pressed wins, even when it was renamed since.
  for (const wait of waits) {
    if (!sameName(wait.action, proposal.action)) continue
    const step = actions.find((candidate) => candidate.id === wait.stepId)
    if (step !== undefined) return { kind: untouchedSince(step, wait) ? 'replace' : 'offer', stepId: step.id }
  }
  const step = actions.find((candidate) => sameName(candidate.name, proposal.action))
  if (step === undefined) return { kind: 'add' }
  const wait = waits.find((candidate) => candidate.stepId === step.id)
  if (wait !== undefined) return { kind: untouchedSince(step, wait) ? 'replace' : 'offer', stepId: step.id }
  const saved = draft.original.find((candidate) => candidate.id === step.id)
  const untouched = saved === undefined ? step.script.trim() === '' && step.command.trim() === '' : untouchedSince(step, saved)
  return { kind: untouched ? 'replace' : 'offer', stepId: step.id }
}
