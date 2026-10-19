/**
 * ONE BUTTON: "Understand this feature" — PURE, no DOM, no IPC.
 *
 * THE QUESTION THIS ANSWERS
 * =========================
 * "Why do we have a button to learn and another to draw?"
 *
 * There was no answer. `Learn this feature` wrote the feature's `## Learned`
 * section; `Draw this feature` wrote its curated view. They read THE SAME
 * ranked files — `feature-view-session.ts` imports `rankModuleFiles` directly
 * from `learn-session.ts` — ran in the same cage (Read/Grep/Glob), and cost the
 * same several minutes. The only thing that differed was which internal store
 * came out the other end, and a reader was being asked to pick one.
 *
 * The split was implementation-shaped: two plans built two stores at different
 * times and nobody ever collapsed the surface. It even had a visible cost —
 * drawing a feature did NOT light its understanding dot, because
 * `understandingOf` only read `## Learned`. The richest artifact the system can
 * produce left a feature looking unexamined.
 *
 * So: one control, named for what the reader wants rather than for the artifact
 * it happens to write. One pass writes both (`runFeatureViewPass`), and either
 * artifact now counts as understanding (`understandingOf`).
 *
 * WHY THIS IS ONE FUNCTION AND NOT TWO
 * ====================================
 * It replaces `decideGenerateAction` (feature-view-request.ts) and
 * `decideLearnAction` (empty-actions.ts), which had already converged on the
 * same shape, the same `BoardAction`, the same running vocabulary and
 * overlapping refusals. Keeping two deciders for one control is how the pair
 * would grow back.
 *
 * AND IT IS OFFERED ON A CURATED LEVEL TOO — A REFRESH, NOT A FIRST READ
 * =====================================================================
 * The first cut of this module returned null for a curated level, inheriting
 * the old "offer it only where there is a gap" rule. That rule was written when
 * a curated level meant the job was done. It does not.
 *
 * MEASURED (issue #1435, on this machine): 6 of 29 code excerpts — 21% —
 * across the six currently-PASSING orbit-app views no longer match the lines
 * they cite, and those views were generated 2026-08-04 to 08-07. Four days.
 * One is worse than a shift: `chats` cites `streamTurn.ts:858-897` for a
 * `new EngineAPI(...)` line that no longer exists anywhere in the file,
 * so the drawer presents deleted code as current evidence.
 *
 * With the collapse, a drawn feature reports `learned`. So the state without
 * this branch is: drawn → learned → the code moves underneath it → the dot
 * eventually says `stale` → and there is nothing to press. A validator that
 * passes is not a picture that is still true.
 *
 * So the control stays, worded as a RE-RUN. That distinction is not cosmetic:
 * the reader can SEE there is already a drawing, so a control offering to
 * "understand this feature" there reads as a no-op, and a control that reads as
 * a no-op does not get pressed. And when the board already knows a reason to
 * press it — the feature is `stale` — the control says so, because that is the
 * strongest argument it will ever have.
 *
 * EVERY REFUSAL IS SPOKEN, NOT HIDDEN
 * ===================================
 * Returning null IS the hiding mechanism — there is no `visible` flag a caller
 * can ignore — and it is used only where the action could not help at all:
 * a level that is already curated, or a feature with no identity to dispatch
 * against. Every other blocked state returns a DISABLED control that says which
 * state it is in, because a control that vanishes explains nothing and a
 * control that looks pressable and quietly no-ops is worse still.
 *
 * A FEATURE WITH NO ANCHORS IS STILL PRESSABLE, deliberately. The old Learn was
 * disabled there because `#learnFeature` returned early on an empty path list —
 * silently. That silence is gone: the pass reads the feature's plan and
 * discovery documents too, and when there is genuinely nothing it refuses out
 * loud and the reason lands on the level. A disabled button would now be hiding
 * a working path.
 *
 * A PART LEVEL OFFERS THE SAME CONTROL, AND DISPATCHES ITS OWNER'S PASS
 * =====================================================================
 * Per-part learning already exists end to end and there is exactly ONE door to
 * it: `understandFeature` in main draws the feature's view and then runs
 * `learnFeatureParts` over every part the drawing named, writing each part's
 * learnings through `writeParts` — the only parts writer there is. There is no
 * "learn just this one part" channel, and inventing one here would be inventing
 * a second write path into a precious store.
 *
 * So a part's control targets the PART (it is named in the label, and it is the
 * part's anchors that are counted) while dispatching the OWNER's pass — and it
 * says so, because a button that silently spends ten minutes on a bigger job
 * than the one it appears to offer is the same class of lie as a control that
 * looks pressable and no-ops. `understandTarget` is the single place that
 * decides what gets dispatched, so a caller holding a part id cannot
 * accidentally send it down a channel that only resolves features.
 *
 * AND A PART WITH NO ANCHORS REPEATS THE CLI'S REFUSAL, WORD FOR WORD
 * ==================================================================
 * `blueprint features parts` already refuses to write such a part, in prose:
 * *"part '<name>' names no anchors — nothing to learn it from, and nothing to
 * re-check when the code drifts"*. That sentence is the whole explanation and
 * it was previously only ever seen by whoever read stderr. It is repeated here
 * verbatim rather than paraphrased — a second, softer wording for one rule is
 * how the two drift apart, and `understand-action.test.ts` reads the CLI source
 * and fails if they ever do.
 */

import type { ProvisioningState } from '../../shared/ipc-contract'
import { notReadyReason, type BoardAction } from './empty-actions'
import type { FeatureUnderstanding } from './feature-view-model'

/** What resolved behind the feature's level — `LevelVerdict`, structurally. */
export type UnderstandLevel = 'curated' | 'derived' | 'empty'

/** THE LABEL. Named for what the reader wants, not for the store it writes. */
export const UNDERSTAND_LABEL = 'Understand this feature'

/**
 * THE RE-RUN LABEL, for a level that already has a drawing.
 *
 * Deliberately a different word from the first-read label. The reader is
 * looking at a picture; a button offering to produce one reads as a control
 * that does nothing, and the whole point of showing it there is that the
 * picture may no longer be true (see the header, issue #1435).
 */
export const REDRAW_LABEL = 'Understand it again'

/**
 * THE PART LABEL. The same act, the right noun.
 *
 * "Understand this feature" on a part's level would name the wrong thing — the
 * reader drilled into one piece of a capability, and the vocabulary sweep this
 * plan exists for is precisely about three words meaning three things.
 * `REDRAW_LABEL` needs no variant: "Understand it again" already says *it*.
 */
export const UNDERSTAND_PART_LABEL = 'Understand this part'

/**
 * The part a level is about, when the level is a part's.
 *
 * Its presence is what makes this a part decision — `level` is the level's
 * VERDICT (curated / derived / empty) and is a different axis; a part's level
 * can be any of the three, exactly like a feature's.
 */
export interface UnderstandPartInput {
  /**
   * How many anchors the part names.
   *
   * `null` means "not read yet", the same distinction `modulePaths` draws:
   * claiming a part anchors nothing before anyone opened its record would be a
   * claim about a state nothing has checked. `0` means read, and found none —
   * which is the state the CLI refuses to write, and the reason it gives is
   * what this level then says.
   */
  anchorCount: number | null
  /** The FEATURE that owns it — the id the pass is actually dispatched against. */
  ownerRef: string | null
  /** That feature's name, for the sentence that admits what the press runs. */
  ownerName: string | null
}

/**
 * The CLI's refusal for a part that names no anchors — VERBATIM.
 *
 * Source of truth: `src/cli/commands/blueprint.ts` (`runFeaturesParts`), which
 * refuses the write with this exact sentence. Repeated rather than paraphrased
 * because a rule with two wordings has two meanings within a release; the test
 * reads the CLI source and fails when they diverge.
 */
export function partNoAnchorRefusal(partName: string): string {
  return `part '${partName}' names no anchors — nothing to learn it from, and nothing to re-check when the code drifts`
}

/** Everything the decision reads. Nothing here touches the DOM or IPC. */
export interface UnderstandActionInput {
  /** The verdict the level opened with. */
  level: UnderstandLevel
  /**
   * The active root's PATH — every `learn:*` channel takes the path, never the
   * project UUID. See `buildFeatureViewRequest` for what that trap costs.
   */
  rootPath: string | null
  /**
   * The NODE this level is about — a feature's id/slug, or a part's id when
   * `part` is set. It is not necessarily what gets dispatched: see
   * `understandTarget`, which is the one place that decides that.
   */
  featureRef: string | null
  /** Its human name, for the pass's prompt and for the label. */
  featureName: string | null
  /**
   * Set when this level is a PART's rather than a feature's.
   *
   * Absent/null keeps every existing caller on exactly the path it had.
   */
  part?: UnderstandPartInput | null
  /** The root's live readiness. `undefined` = not observed yet. */
  provisioning: ProvisioningState | undefined
  /**
   * Module paths this feature's anchors resolve to.
   *
   * `null` means "not looked up yet" — the board resolves anchors with an async
   * brief fetch, and claiming "no code is anchored" before anyone has looked
   * would be a claim about a state nothing has checked. `[]` means looked, and
   * found none, which is a different sentence.
   */
  modulePaths: readonly string[] | null
  /** A pass for THIS feature is already in flight. */
  running: boolean
  /**
   * The name of ANOTHER feature currently being understood, when one is.
   *
   * Only one caged pass runs at a time — so a press here JOINS THE QUEUE rather
   * than being refused. It used to disable the control, which read as "come
   * back later" and, on any surface that had not been told who held the turn,
   * as a button that simply did nothing. Waiting is the machine's problem, not
   * the reader's: they said what they wanted understood, and it will be.
   */
  busyWith?: string | null
  /** This feature is already waiting its turn — pressed, not yet started. */
  queued?: boolean
  /** The last failure for this feature, kept on screen after the toast goes. */
  error?: string | null
  /**
   * What the board currently claims to know about this feature.
   *
   * Read ONLY to argue for the re-run on a curated level: `stale` is the
   * strongest reason to press it, and a control that knows that and does not
   * say it is withholding the one fact that would make the press worth making.
   * `undefined` means the graph has not been read yet — the control is still
   * offered, it just does not argue for itself.
   */
  understanding?: FeatureUnderstanding | undefined
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function modules(count: number): string {
  return `${String(count)} module${count === 1 ? '' : 's'}`
}

function anchors(count: number): string {
  return `${String(count)} anchor${count === 1 ? '' : 's'}`
}

/**
 * What a feature is CALLED, from whichever source has it.
 *
 * A CONTROL THAT VANISHES EXPLAINS NOTHING, and this module's own rule is that
 * `null` is reserved for "could not help at all". `decideUnderstandAction`
 * needs a name — the pass is dispatched by name — and the board's brief path
 * fed it `brief.delta.identity?.name`, which the CONTRACT marks optional. A
 * brief that carried no identity hid the re-learn control completely, on
 * exactly the levels that have something to re-learn, with nothing on screen to
 * say why. The board is holding that name in two other places at the time.
 *
 * In order of authority: what the brief calls it, then the node the reader
 * actually drilled into, then the feature graph. Null only when no source
 * knows — the one state where hiding is the honest answer.
 */
export function featureDisplayName(
  featureRef: string | null,
  sources: {
    fromBrief?: string | null
    stack?: readonly { id: string; name: string }[]
    graph?: readonly { id: string; name: string }[]
  },
): string | null {
  const brief = clean(sources.fromBrief)
  if (brief !== null) return brief
  if (featureRef === null) return null
  const stacked = clean(sources.stack?.find((node) => node.id === featureRef)?.name)
  if (stacked !== null) return stacked
  return clean(sources.graph?.find((node) => node.id === featureRef)?.name)
}

/**
 * WHAT A PRESS ACTUALLY DISPATCHES — the one place that decides.
 *
 * On a feature's level this is the feature. On a PART's level it is the part's
 * OWNER, because the only per-part learn path in the system is the owner's
 * pass: `understandFeature` draws the feature's view and then walks every part
 * through `writeParts`. Handing a part id to `learn:generateFeatureView`
 * resolves no feature and produces nothing — silently, which is the exact
 * failure shape this repo has paid for twice (see `#understandFeature`'s
 * rootId note). Deciding it here rather than at the call site means a caller
 * holding a part cannot make that mistake.
 *
 * `null` means there is nothing dispatchable, and `decideUnderstandAction`
 * returns null for the same input — one rule, not two.
 */
export function understandTarget(
  input: UnderstandActionInput,
): { featureRef: string; featureName: string } | null {
  if (input.part != null) {
    const ownerRef = clean(input.part.ownerRef)
    const ownerName = clean(input.part.ownerName)
    if (ownerRef === null || ownerName === null) return null
    return { featureRef: ownerRef, featureName: ownerName }
  }
  const featureRef = clean(input.featureRef)
  const featureName = clean(input.featureName)
  if (featureRef === null || featureName === null) return null
  return { featureRef, featureName }
}

/** What the pass produces, stated once so every title says the same thing. */
const WHAT_IT_WRITES =
  'writes both what it does and a drawing of how it works'

/**
 * What a re-run does to the drawing that is already there.
 *
 * OVERWRITING IS THE POINT, AND IT MUST NOT BE A SURPRISE. `writeFeatureView`
 * renames the existing artifact to `<slug>.prev.json` before writing, so the
 * previous drawing survives — that is a fact about the writer, verified, not a
 * reassurance invented here.
 */
const WHAT_A_RERUN_REPLACES =
  'replace the drawing that is there now — the previous one is kept alongside as .prev.json'

/**
 * Should this level offer to understand its feature (or its part), and how does
 * it read?
 */
export function decideUnderstandAction(input: UnderstandActionInput): BoardAction | null {
  const rootPath = clean(input.rootPath)
  const featureRef = clean(input.featureRef)
  const featureName = clean(input.featureName)
  // Without all three the call cannot be built, and an action that cannot
  // dispatch is the failure this whole module exists to remove.
  if (rootPath === null || featureRef === null || featureName === null) return null
  // …and on a part's level the same rule reaches one step further: the press
  // dispatches the OWNER's pass, so a part with no resolvable owner has nothing
  // to send either. Same rule, one code path.
  const target = understandTarget(input)
  if (target === null) return null

  const part = input.part ?? null

  // A CURATED LEVEL GETS THE SAME ACT UNDER A DIFFERENT NAME. See the header:
  // the old rule hid it here, and a drawing that passed the validator four days
  // ago is not a drawing that is still true. The reader can see a picture, so
  // the label has to say "again" or it reads as a control that does nothing.
  const redraw = input.level === 'curated'
  const first = part !== null ? UNDERSTAND_PART_LABEL : UNDERSTAND_LABEL
  const label = redraw ? REDRAW_LABEL : first

  const error = clean(input.error)

  if (input.running) {
    return {
      label: `Understanding ${featureName}…`,
      // SAY WHAT IS HAPPENING AND ROUGHLY HOW LONG. A caged pass reads code and
      // thinks for minutes; "working" without a duration reads as hung.
      //
      // A PART SAYS WHOSE PASS IS RUNNING. It is not this part's own — one pass
      // covers the whole feature — and a reader who leaves and comes back needs
      // the name of the thing that is actually working.
      title:
        part !== null
          ? `Reading ${target.featureName}’s code and plans and learning each of its parts, ${featureName} among them. This takes several minutes; the level refreshes itself when it lands.`
          : `Reading ${featureName}’s code and plans, then ${WHAT_IT_WRITES}. This takes several minutes; the level refreshes itself when it lands.`,
      running: true,
      // Pressing again would start a second caged pass over the first's result.
      disabled: true,
      error: null,
    }
  }

  const blocked = notReadyReason(input.provisioning)
  if (blocked !== null) {
    // SHOWN, AND REFUSED OUT LOUD. Hiding it would leave a freshly added
    // project — where this state is most likely to be seen — with no
    // explanation at all.
    return { label, title: blocked, running: false, disabled: true, error }
  }

  // ALREADY WAITING ITS TURN. Not running, not idle — pressed, and it will
  // start on its own. Disabled because there is nothing left to ask for, and
  // labelled so a reader who comes back does not press it again wondering.
  if (input.queued === true) {
    const ahead = clean(input.busyWith)
    return {
      label: `${featureName} is queued`,
      title:
        ahead === null
          ? `It starts as soon as the pass in front of it finishes.`
          : `It starts as soon as ${ahead} finishes. One pass runs at a time; the rest wait.`,
      running: false,
      disabled: true,
      error,
    }
  }

  // ANOTHER FEATURE HOLDS THE TURN — SO THIS PRESS QUEUES.
  //
  // It used to be refused: disabled, with a sentence naming who to wait for.
  // That is a fair description of the machine and a poor deal for the reader,
  // who then has to watch a pass they do not care about and remember to come
  // back. Worse, a surface that did not know who held the turn showed an
  // ordinary-looking button that did nothing at all — the exact failure this
  // module was written to remove, reappearing through the one state it left
  // pressable-looking. So the control stays live and SAYS it will wait.
  const busyWith = clean(input.busyWith)
  if (busyWith !== null) {
    return {
      label,
      title: `${busyWith} is being understood — one pass runs at a time, so this one starts when that finishes.`,
      running: false,
      disabled: false,
      error,
    }
  }

  // ── A PART'S LEVEL ────────────────────────────────────────────────────────
  //
  // It reaches here having passed every refusal a feature's level has, because
  // they are the same refusals: an unready root blocks a part exactly as it
  // blocks a feature, and the one caged turn is global. What differs is what is
  // counted (the part's own anchors, not the feature's resolved modules) and
  // what the sentence admits (the press runs the owner's whole pass).
  if (part !== null) {
    const anchorCount = part.anchorCount
    // NOT READ YET IS NOT "NONE". Same distinction `modulePaths: null` draws —
    // saying a part anchors nothing before its record was opened would be a
    // claim about a state nothing has checked.
    if (anchorCount === null) {
      return {
        label,
        title: `Looking up what ${featureName} anchors…`,
        running: false,
        disabled: true,
        error,
      }
    }
    // THE CLI'S REFUSAL, VERBATIM AND ON THE LEVEL.
    //
    // `blueprint features parts` will not write this part, and it says why in
    // a full sentence. That sentence is the honest state of this level, so it
    // is what the level says — not a blank panel, and not a generic failure
    // invented here that would explain less than the one already written.
    // The control stays visible and unpressable: a press could never learn
    // this part, and a vanished control explains nothing.
    if (anchorCount === 0) {
      return {
        label,
        title: partNoAnchorRefusal(featureName),
        running: false,
        disabled: true,
        error,
      }
    }
    // LEAD WITH THE REASON WHEN THERE IS ONE — same rule as a feature's re-run.
    const why =
      redraw && input.understanding === 'stale'
        ? `${featureName}’s code has drifted since this was learned, so what it says may no longer be true. `
        : ''
    // WHAT THE PRESS ACTUALLY COSTS. There is no learn-one-part channel: the
    // owner's pass is the per-part path, and it re-reads every sibling. Hiding
    // that would make the button spend ten minutes on a larger job than the one
    // it appeared to offer.
    const scope = `this runs ${target.featureName}’s understand pass, which ${
      redraw ? `will ${WHAT_A_RERUN_REPLACES} and re-learn` : `${WHAT_IT_WRITES} and learns`
    } every one of its parts, ${featureName} included`
    return {
      label,
      title: `${why}${redraw ? 'Re-read' : 'Read'} the ${anchors(anchorCount)} ${featureName} names — ${scope}. Takes several minutes.`,
      running: false,
      disabled: false,
      error,
    }
  }

  // ANCHORS NOT RESOLVED YET. Offered and disabled, saying which: the lookup is
  // one round trip and the button re-enables itself when it lands.
  if (input.modulePaths === null) {
    return {
      label,
      title: `Looking up which code ${featureName} covers…`,
      running: false,
      disabled: true,
      error,
    }
  }

  const count = input.modulePaths.length
  const reads =
    count > 0
      ? `${modules(count)}`
      : // NO ANCHORS IS NOT NOTHING. The pass reads the feature's plan and
        // discovery documents as well as its code, and refuses out loud when
        // there is genuinely neither — see the header.
        `${featureName}’s plans and code`

  if (redraw) {
    // LEAD WITH THE REASON WHEN THERE IS ONE. `stale` means the code this
    // drawing was made from has moved, which is the single strongest argument
    // for pressing it — and the board already knows. Withholding it would leave
    // the reader guessing whether a re-run is worth ten minutes. When it is not
    // stale the control is still there and simply does not argue for itself.
    const why =
      input.understanding === 'stale'
        ? `${featureName}’s code has drifted since this was drawn, so what it shows may no longer be true. `
        : ''
    return {
      label: REDRAW_LABEL,
      title: `${why}Re-read ${reads} and ${WHAT_A_RERUN_REPLACES}. Takes several minutes.`,
      running: false,
      disabled: false,
      error,
    }
  }

  return {
    label: UNDERSTAND_LABEL,
    title:
      (count > 0
        ? `Read ${reads} and work out how ${featureName} actually works`
        : `Read ${reads} and work out how it actually works`) +
      ` — ${WHAT_IT_WRITES}. Takes several minutes.`,
    running: false,
    disabled: false,
    error,
  }
}
