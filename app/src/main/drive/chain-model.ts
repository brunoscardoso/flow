// WHAT THE AUTOPILOT CHAIN DOES NEXT — the pure half.
//
// Autopilot has always been PROSE: a key in the project's config, plus an
// "AUTOPILOT MODE CHECK" block pasted into four command files asking the model
// to please run the next thing. Nothing executed the chain, so whether it
// happened was the model's choice — which is the complaint, and it is accurate.
// This module is the decision that replaces the asking: given what stage a
// thread is on and what its last turn did, it says what to issue now.
//
// THE LADDER IS MIRRORED, NOT IMPORTED, and that is a fact about the repo
// rather than a preference: `app/` is a separate package from the root
// `src/cli/` and does not import from it — the CLI is reached by spawning the
// bundled binary. `src/cli/state/workflow-stages.ts` holds the same four rungs
// in the same order for the refusal verb; the two are kept in step by the order
// being the feature's whole contract and by both being four lines long. Anything
// that grows beyond the order itself — what PROVES a stage ran — lives on the
// CLI side only, and is read there, because proofs are files and this process
// must not go looking at them on the main thread.
//
// DECIDED FROM OBSERVABLE STATE, NEVER FROM A REPORT. The inputs below are the
// thread's stored stage, its status, and whether its last turn ended cleanly.
// Nothing here reads a transcript, and nothing here may: "the model said it
// finished" is exactly the evidence this feature exists to stop trusting.
//
// Pure — no store, no IPC, no clock, no filesystem.

import type { ThreadStatus } from '../store/thread-store'

/** One rung of the chain. Mirrors `src/cli/state/workflow-stages.ts`. */
export type WorkflowStage = 'discovery' | 'create-plan' | 'execute-plan' | 'review-code'

/**
 * The ladder, in order. This tuple IS the order — `nextStage` derives from it,
 * so a fifth rung is one edit here (and its twin on the CLI side).
 */
export const WORKFLOW_STAGES = [
  'discovery',
  'create-plan',
  'execute-plan',
  'review-code',
] as const satisfies readonly WorkflowStage[]

/** The rung after `stage`, or null when the last one is done. */
export function nextStage(stage: WorkflowStage | null): WorkflowStage | null {
  if (stage === null) return WORKFLOW_STAGES[0]
  const index = WORKFLOW_STAGES.indexOf(stage)
  if (index < 0) return WORKFLOW_STAGES[0]
  return WORKFLOW_STAGES[index + 1] ?? null
}

/** The slash command that runs a rung. Internal — never shown to a person. */
const STAGE_COMMAND: { readonly [S in WorkflowStage]: string } = {
  discovery: '/discovery-plan',
  'create-plan': '/create-plan',
  'execute-plan': '/execute-plan',
  'review-code': '/review-code',
}

/**
 * What a rung is called in a sentence somebody reads.
 *
 * NOT THE COMMAND. A person watching a chain run is told what is happening, not
 * which slash command is being typed on their behalf (forbidden-pattern #12);
 * the command names are internal and stay in `STAGE_COMMAND`.
 */
const STAGE_LABEL: { readonly [S in WorkflowStage]: string } = {
  discovery: 'Working out what is needed',
  'create-plan': 'Planning the work',
  'execute-plan': 'Building it',
  'review-code': 'Reviewing what was built',
}

/** The sentence a surface shows for a stage. */
export function stageLabel(stage: WorkflowStage): string {
  return STAGE_LABEL[stage]
}

/** What the runner should do now. */
export type ChainStep =
  | { kind: 'issue'; stage: WorkflowStage }
  /** Everything is built and reviewed — publish it, if the project says so. */
  | { kind: 'tail' }
  | { kind: 'wait'; reason: string }
  | { kind: 'stop'; reason: string }

/** Everything the decision is allowed to see. All of it is observable state. */
export interface ChainState {
  /** The rung last issued, or null before the chain has issued anything. */
  stage: WorkflowStage | null
  /** The rung the chain starts from. `discovery` unless a caller says otherwise. */
  startAt: WorkflowStage
  /** The thread's status, as the store holds it. */
  threadStatus: ThreadStatus
  /**
   * Did the last turn end cleanly? `null` before the chain has issued anything,
   * which is the only state in which no turn has happened yet.
   */
  lastTurnSucceeded: boolean | null
  /** Has the git tail already run for this chain? */
  tailDone: boolean
  /**
   * Did it publish? `null` until it has run.
   *
   * A TAIL THAT WAS REFUSED IS NOT A CHAIN THAT FINISHED. The gate withholds the
   * publish when the work was rated `high` risk or was never rated, and the
   * verb refuses an unbound branch — in both cases the rungs all ran and the
   * work is sitting committed and unpublished, which is a different ending from
   * "everything on the list is done" and must not be reported as that one.
   */
  tailPublished: boolean | null
}

/** The reason a chain holds while somebody is being asked something. */
export const WAITING_ON_YOU = 'Waiting for your answer.'
/** The reason a chain stops itself when a step did not finish cleanly. */
export const STEP_DID_NOT_FINISH =
  'The last step did not finish, so nothing more was started. Pick it up when you are ready.'
/** The reason a chain stops itself at the end, having done everything. */
export const CHAIN_FINISHED = 'Everything on the list is done.'
/**
 * The reason a chain stops when the work was built and reviewed but not
 * published — a pause was honoured at the last step.
 *
 * NO COMMAND, PATH OR CONFIG KEY (forbidden-pattern #12): the sentence the gate
 * or the verb produced is carried separately, and it is already written for a
 * person.
 */
export const CHAIN_NOT_PUBLISHED =
  'The work is built and reviewed, and it was not published.'

/**
 * The next thing to do, given only what can be observed.
 *
 * THE FOUR ANSWERS ARE DIFFERENT AND MUST STAY THAT WAY:
 *
 *  · `issue` — run this rung now.
 *  · `wait`  — a person is being asked something. NOT a stop: the chain is
 *    alive, and their reply starts the turn that resumes it. Re-issuing here
 *    would talk over the question, which is the one thing a chain must never
 *    do to somebody who is trying to stop it.
 *  · `tail`  — the rungs are done; publish what was built, if the project says
 *    so. The chain owns this step, not `/execute-plan` (see `chain-tail.ts`).
 *  · `stop`  — finished, or a step did not finish cleanly. A failed rung stops
 *    rather than advancing: the next rung's own refusal would catch it, but a
 *    chain that marches on past a step nobody completed is a chain producing
 *    work on a foundation that is not there.
 */
export function nextChainStep(state: ChainState): ChainStep {
  // A QUESTION OUTRANKS EVERYTHING. Checked before the turn's outcome, because
  // a thread that is waiting on a person is waiting whatever its last turn did.
  if (state.threadStatus === 'needs-decision' || state.threadStatus === 'blocked') {
    return { kind: 'wait', reason: WAITING_ON_YOU }
  }
  if (state.lastTurnSucceeded === null) {
    return { kind: 'issue', stage: state.stage ?? state.startAt }
  }
  if (!state.lastTurnSucceeded) {
    return { kind: 'stop', reason: STEP_DID_NOT_FINISH }
  }
  const following = nextStage(state.stage)
  if (following !== null) return { kind: 'issue', stage: following }
  if (!state.tailDone) return { kind: 'tail' }
  // A REFUSED TAIL IS ITS OWN ENDING. Stopping either way is right — nothing is
  // retried and nothing is guessed at — but saying "everything is done" over a
  // publish that was deliberately withheld would hide the one fact the person
  // needs, and a surface reading the reason would move the work on as finished.
  if (state.tailPublished === false) return { kind: 'stop', reason: CHAIN_NOT_PUBLISHED }
  return { kind: 'stop', reason: CHAIN_FINISHED }
}

/** What the chain sends a thread to run one rung. */
export interface StagePromptInput {
  stage: WorkflowStage
  /** The sentence the chain was pointed at, verbatim. May be empty. */
  aim: string
  /** This run's id — the marker an enforced stage carries. */
  chainId: string
  /**
   * The subject this run's documents are named for (`feature-slug.ts`).
   *
   * MINTED BY THE DRIVER, NOT READ BACK OFF THE DISK. The gate that refuses the
   * next rung judges the artifact this one leaves behind, and three of the four
   * artifacts are files named for a feature — so the stage has to be TOLD what
   * to call its document, or the gate is asking about a name nobody chose.
   */
  feature: string
}

/**
 * The document a rung is expected to leave behind, named for this run.
 *
 * PATHS ARE RIGHT HERE AND WRONG ON SCREEN. This string goes to an agent, which
 * has to write the file; forbidden-pattern #12 is about what a PERSON reads,
 * and the sentences that reach a surface are in `stage-gate.ts`.
 *
 * `execute-plan` names the plan it runs rather than a file it writes: its proof
 * is a `phase_result` entry carrying the plan's own slug, so running the right
 * plan is the whole of what it has to be told.
 */
function stageArtifactLine(stage: WorkflowStage, feature: string): string {
  switch (stage) {
    case 'discovery':
      return `Name the discovery document for the feature slug \`${feature}\` — \`flow/discovery/discovery_${feature}_v1.md\`.`
    case 'create-plan':
      return `Name the plan for the feature slug \`${feature}\` — \`flow/plans/plan_${feature}_v1.md\`.`
    case 'execute-plan':
      return `Execute the plan for the feature slug \`${feature}\` — \`flow/plans/plan_${feature}_v1.md\`.`
    case 'review-code':
      return `Name the review document for the feature slug \`${feature}\` — \`flow/reviewed-code/review_${feature}.md\`.`
  }
}

/**
 * The message that runs a rung.
 *
 * THE CHAIN ID RIDES ALONG because enforcement binds enforced runs only: a
 * person running `/create-plan` by hand on a year-old discovery must not be
 * refused into a corner, so the refusal verb applies when — and only when — a
 * chain is driving, and this line is how the stage knows it is one.
 *
 * THE FEATURE SLUG RIDES ALONG for the other half of the same question. The
 * gate reads what a rung LEFT BEHIND, and three of the four proofs are files
 * named for a feature — so the message says which name to use, and the gate
 * asks about that name. The subject is something the driver chose, never
 * something read back out of the files being judged (#1915 C2).
 *
 * THE TAIL IS NAMED AS NOT-YOURS on the build rung. `/execute-plan` commits,
 * pushes and opens a pull request at the end of its own runs; under a chain the
 * chain does that after the review, which is a better order (review currently
 * runs on work already pushed) and a real change of behaviour. One behaviour,
 * two triggers — said here so the model is not left to infer it, and said in the
 * command file by a later phase so a reader finds the same rule twice.
 */
export function stagePrompt(input: StagePromptInput): string {
  const lines = [`${STAGE_COMMAND[input.stage]} ${input.aim}`.trimEnd(), '']
  lines.push(`<!-- flow-chain: ${input.chainId} stage=${input.stage} feature=${input.feature} -->`)
  // THE NAME IS AN INSTRUCTION, not a hint, and the chain enforces it: before
  // the NEXT rung is issued, the gate asks whether this one left a document
  // under exactly this slug, and a document named for something else stops the
  // chain (`stage-gate.ts`). Said here so the requirement reaches the agent
  // that has to meet it, rather than only the code that checks it.
  lines.push('', stageArtifactLine(input.stage, input.feature))
  if (input.stage === 'execute-plan') {
    lines.push(
      '',
      'Do not commit, push or open a pull request when the phases finish — this run is part of a chain, and the chain does that after the review.',
    )
  }
  return lines.join('\n')
}
