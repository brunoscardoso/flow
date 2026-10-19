/**
 * ArtifactCard — a flow/ discovery/plan/brainstorm doc surfaced inline in the
 * conversation thread (blueprint-interaction Phase 2, #563). Mirrors the
 * StoryCard / QuestionCard / ToolCard live-card architecture: a constructor
 * builds `element`, and the pane appends it via `entryWrapper('artifact', el)`,
 * tracks it in an in-memory (latest-per-kind) map, and drops it on thread
 * switch (never persisted).
 *
 * The card shows the doc's kind, title, and feature/mtime line, plus an action
 * row. The doc IS its kind — discovery/plan/brainstorm — so no story-status
 * text renders on the card (#658 follow-up): the `## Story` state stays an
 * internal model field that only decides which action to offer.
 * Board/editor coupling is import-free: actions
 * fire the callbacks the pane wires to decoupled document CustomEvents
 * (flow:open-file-path / flow:open-blueprint / flow:prefill-composer) and the
 * learn:narrate invoke — the same decoupling the StoryCard uses.
 *
 * SAFETY: every interpolated string reaches the DOM via `textContent`, never
 * innerHTML — model output (titles, names, features) is inert by construction.
 */
import {
  artifactSubLine,
  docRefOf,
  docVersionLabel,
  ARTIFACT_GENERATE_LABEL,
  ARTIFACT_OPEN_LABEL,
  ARTIFACT_WRITING_LABEL,
  artifactRowActions,
  CANCEL_LABEL,
  executeConfirmText,
  executePressState,
  EXECUTE_ANYWAY_LABEL,
  notePills,
  PLAN_CREATE_LABEL,
  PLAN_EXECUTE_LABEL,
  PLAN_REVIEW_LABEL,
  REVIEW_FIRST_LABEL,
  selectedDocOf,
  showsInnerStory,
  type ArtifactRowAction,
  type ExecuteState,
  foldDoc as foldDocRef,
  formatMtimeLabel,
  newestMtime,
  OPEN_DOC_LABEL,
  openDocTooltip,
  showsOpenDocButton,
  type ArtifactCardModel,
  type ArtifactDocRef,
} from './artifact-card-model'
import type { PlanNoteCounts } from '../../shared/ipc-contract'

export interface ArtifactCardCallbacks {
  /** Open the doc in the editor (pane → flow:open-file-path). */
  onOpenDoc: (model: ArtifactCardModel) => void
  /** Reveal this artifact on the blueprint board (pane → flow:open-blueprint). */
  onViewBoard: (model: ArtifactCardModel) => void
  /** Open this discovery's artifact — the walkthrough of what users will see —
   *  as an editor tab (pane → flow:open-feature-view). Offered once the page
   *  is written — see `deriveFeatureViewAction`. */
  onOpenFeatureView: (model: ArtifactCardModel) => void
  /** Ask the thread's agent to write this discovery's artifact (pane → the
   *  composer's own send, as `/artifact @<doc>`). Offered while the discovery
   *  has no page. */
  onGenerateArtifact: (model: ArtifactCardModel) => void
  /** Compile the doc's `## Story` section (pane → learn:narrate). Shown only
   *  when `narrateAction === 'narrate'`. */
  onNarrate: (model: ArtifactCardModel) => void
  /** Ask the agent to author a `## Story` section (pane → composer prefill).
   *  Shown only when `narrateAction === 'ask-agent'`. */
  onAskAgent: (model: ArtifactCardModel) => void
  /** Ask the thread's agent to plan from this discovery (pane → the
   *  composer's own send). Offered while the card holds no plan. Answers
   *  whether the message was actually sent. */
  onCreatePlan?: (discoveryPath: string) => boolean
  /** Whether this thread already asked to plan from this discovery — kept by
   *  the pane, because a card is rebuilt and a guard on the card is lost with it. */
  planRequested?: (discoveryPath: string) => boolean
  /** Open the plan's change notes for review (pane → `flow:open-plan-review`). */
  onReviewChange?: (plan: ArtifactDocRef) => void
  /** Ask the thread's agent to execute the plan (pane → the composer's own send). */
  onExecutePlan?: (plan: ArtifactDocRef) => void
  /** The card holds this plan now — the pane answers with `setPlanNotes` /
   *  `setRunning` (from what it already knows, or after reading it once). */
  onPlanDoc?: (card: ArtifactCard, planPath: string) => void
  /** Whether a plan for this feature has been written (it has its own card, so
   *  the discovery's card cannot see it) — Create the plan is then not offered. */
  planWrittenFor?: (feature: string | null) => boolean
}

/** What the pane knows about a plan the card holds. */
interface CardPlanState {
  path: string
  counts: PlanNoteCounts | null
  /** The running line while a run started here is going, else null. */
  running: string | null
  /** The footnote under the running line (rejected notes left out). */
  runningNote: string | null
}

const KIND_LABEL: Record<ArtifactCardModel['kind'], string> = {
  plan: 'PLAN',
  discovery: 'DISCOVERY',
  brainstorm: 'BRAINSTORM',
}

/** The words on the button that opens one of the card's documents. */
const DOC_LABEL: Record<ArtifactCardModel['kind'], string> = {
  plan: 'Plan',
  discovery: 'Discovery',
  brainstorm: 'Brainstorm',
}

export class ArtifactCard {
  readonly element: HTMLElement
  #model: ArtifactCardModel
  readonly #callbacks: ArtifactCardCallbacks

  // Stable chrome (built once, updated in place).
  #eyebrow: HTMLElement
  #title: HTMLElement
  #sub: HTMLElement
  #summary: HTMLElement
  /** One button per folded document — shown only once there is more than one. */
  #docs: HTMLElement
  /** Every document this card stands for: its own, plus the plan the pane
   *  folded in when this is the discovery it was written from (stage order). */
  #docRefs: ArtifactDocRef[]
  /** Host for this doc's compiled story (empty and hidden until mounted). */
  #story: HTMLElement
  #actions: HTMLElement
  /** The plan's note pills (empty and hidden unless a plan with notes is selected). */
  #pills: HTMLElement
  /** The Execute confirm box and the running line. */
  #run: HTMLElement
  /** The chip the person last pressed (a doc path), or null before any press. */
  #chosenPath: string | null = null
  /** The plan this card holds, as the pane last described it. */
  #plan: CardPlanState | null = null
  /** The plan paths already announced through `onPlanDoc`. */
  #announced = new Set<string>()
  /** Where Execute the plan stands while nothing is running. */
  #execute: Exclude<ExecuteState, 'running'> = 'idle'
  /** True while a narrate action is in flight — disables the button (no import
   *  of promise state into the pure model). */
  #busy = false

  constructor(model: ArtifactCardModel, callbacks: ArtifactCardCallbacks) {
    injectArtifactStyles()
    this.#model = model
    this.#callbacks = callbacks
    this.#docRefs = [docRefOf(model)]

    this.element = document.createElement('div')
    this.element.className = 'fl-artifact-card fl-artifact-clickable'
    this.element.setAttribute('role', 'button')
    this.element.tabIndex = 0
    this.element.addEventListener('click', () => this.#pressCard())
    this.element.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        this.#pressCard()
      }
    })
    // role=button set above — the whole card is the press: it opens the doc.
    this.element.setAttribute('aria-label', 'Flow artifact')

    // ── Header row (glyph + kind eyebrow) ─────────────────────────────────────
    const head = document.createElement('div')
    head.className = 'fl-artifact-head'
    const glyph = document.createElement('span')
    glyph.className = 'fl-artifact-glyph'
    glyph.textContent = '📄'
    glyph.setAttribute('aria-hidden', 'true')
    this.#eyebrow = document.createElement('span')
    this.#eyebrow.className = 'fl-artifact-eyebrow'
    head.append(glyph, this.#eyebrow)
    this.element.appendChild(head)

    // ── Title + feature/mtime line ────────────────────────────────────────────
    this.#title = document.createElement('div')
    this.#title.className = 'fl-artifact-title'
    this.element.appendChild(this.#title)

    this.#sub = document.createElement('div')
    this.#sub.className = 'fl-artifact-sub'
    this.element.appendChild(this.#sub)

    // A plan's description (its Overview), in place of the note counts.
    this.#summary = document.createElement('p')
    this.#summary.className = 'fl-artifact-summary'
    this.#summary.hidden = true
    this.element.appendChild(this.#summary)

    this.#docs = document.createElement('div')
    this.#docs.className = 'fl-artifact-docs'
    this.#docs.hidden = true
    this.element.appendChild(this.#docs)

    // ── Story slot ────────────────────────────────────────────────────────────
    // The compiled story for THIS doc renders here rather than as a second card
    // in the feed (user call 2026-08-11: "we don't need two"). The pane owns the
    // matching and mounts the StoryCard's element — this card never imports it.
    this.#story = document.createElement('div')
    this.#story.className = 'fl-artifact-story'
    this.#story.hidden = true
    // The whole card is the open-the-doc affordance, so a click inside the
    // mounted story would ALSO open the markdown behind it. Both channels are
    // stopped here, exactly as the action buttons do.
    this.#story.addEventListener('click', (event) => event.stopPropagation())
    this.#story.addEventListener('keydown', (event) => event.stopPropagation())
    this.element.appendChild(this.#story)

    // ── Note pills (a plan with change notes) ────────────────────────────────
    this.#pills = document.createElement('div')
    this.#pills.className = 'fl-artifact-pills'
    this.#pills.hidden = true
    this.element.appendChild(this.#pills)

    // ── Actions row ───────────────────────────────────────────────────────────
    this.#actions = document.createElement('div')
    this.#actions.className = 'fl-artifact-actions'
    this.element.appendChild(this.#actions)

    // ── Execute confirm / running line ───────────────────────────────────────
    this.#run = document.createElement('div')
    this.#run.className = 'fl-artifact-run'
    this.#run.hidden = true
    // Like the story slot: a press in here is never a press on the card.
    this.#run.addEventListener('click', (event) => event.stopPropagation())
    this.#run.addEventListener('keydown', (event) => event.stopPropagation())
    this.element.appendChild(this.#run)

    this.#render()
    this.#announcePlans()
  }

  /** Replace the model in place — a fresher read of THIS card's document (its
   *  hydration, a watcher event, a story status change after a narrate). A
   *  card stands for one version for its whole life: another document never
   *  becomes it (see `foldDoc` for the one that may join it). */
  setModel(model: ArtifactCardModel): void {
    if (model.path !== this.#model.path) {
      // A folded document's fresher read refreshes its reference only.
      if (this.#docRefs.some((doc) => doc.path === model.path)) this.foldDoc(model)
      else console.warn('flow: artifact card refused another document', { card: this.#model.path, doc: model.path })
      return
    }
    this.#model = model
    this.#docRefs = foldDocRef(this.#docRefs, docRefOf(model))
    this.#busy = false
    this.#render()
  }

  /**
   * Take in the plan written from this card's discovery instead of letting it
   * become a second card. The card keeps its own title and actions — it is
   * still that discovery version — and lists the plan, which it can open.
   */
  foldDoc(model: ArtifactCardModel): void {
    this.#docRefs = foldDocRef(this.#docRefs, docRefOf(model))
    this.#render()
    this.#announcePlans()
  }

  /** Every plan path this card holds — what the pane keeps notes for. */
  get planPaths(): string[] {
    return this.#docRefs.filter((doc) => doc.kind === 'plan').map((doc) => doc.path)
  }

  /**
   * The plan's note counts (null when they could not be read, or the plan has
   * none to read). Re-renders only what they drive.
   */
  setPlanNotes(path: string, counts: PlanNoteCounts | null): void {
    const current = this.#plan?.path === path ? this.#plan : null
    if (current !== null && JSON.stringify(current.counts) === JSON.stringify(counts)) return
    this.#plan = { path, counts, running: current?.running ?? null, runningNote: current?.runningNote ?? null }
    this.#renderActions()
  }

  /** The running line for a run started from this card, or null when none runs. */
  setRunning(path: string, line: string | null, note: string | null = null): void {
    const current = this.#plan?.path === path ? this.#plan : null
    if (current !== null && current.running === line && current.runningNote === note) return
    this.#plan = { path, counts: current?.counts ?? null, running: line, runningNote: note }
    if (line !== null) this.#execute = 'idle'
    this.#renderActions()
  }

  /** Every document this card stands for, in stage order. */
  get docs(): readonly ArtifactDocRef[] {
    return this.#docRefs
  }

  get model(): ArtifactCardModel {
    return this.#model
  }

  /**
   * Mount (or clear, with null) this doc's story element inside the card. The
   * pane decides WHICH card hosts a story — the card only holds the slot, so
   * neither component imports the other.
   *
   * Re-mounting the same element is a no-op, which matters: the pane re-runs its
   * story render on every reconcile, and re-appending a live element would tear
   * down and rebuild the story's DOM (losing focus mid-interaction).
   */
  mountStory(element: HTMLElement | null): void {
    if (element === null) {
      this.#story.replaceChildren()
      this.#story.hidden = true
      return
    }
    if (element.parentElement !== this.#story) this.#story.replaceChildren(element)
    this.#syncStoryVisibility()
  }

  /** True when a story element is currently mounted in this card. */
  hasStory(): boolean {
    return this.#story.firstElementChild !== null
  }

  /** Mark the narrate action as in flight (the pane sets this around the
   *  learn:narrate round-trip so the button can't be double-fired). */
  setBusy(busy: boolean): void {
    if (this.#busy === busy) return
    this.#busy = busy
    this.#renderActions()
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Tell the pane about each plan this card holds, once per path. */
  #announcePlans(): void {
    for (const path of this.planPaths) {
      if (this.#announced.has(path)) continue
      this.#announced.add(path)
      this.#callbacks.onPlanDoc?.(this, path)
    }
  }

  /** The document the action row is about (see `selectedDocOf`). */
  #selected(): ArtifactDocRef | null {
    return selectedDocOf(this.#docRefs, this.#chosenPath, this.#model.path)
  }

  /** The selected plan's state, when the selected document is the plan the pane described. */
  #selectedPlan(): CardPlanState | null {
    const selected = this.#selected()
    if (selected === null || selected.kind !== 'plan') return null
    return this.#plan !== null && this.#plan.path === selected.path ? this.#plan : null
  }

  /** The inner STORY section hides while a plan with notes is selected —
   *  its review is Review the change. A mounted story stays mounted. */
  #syncStoryVisibility(): void {
    const selected = this.#selected()
    const counts = this.#selectedPlan()?.counts ?? null
    this.#story.hidden = !this.hasStory() || !showsInnerStory(selected?.kind ?? null, counts)
  }

  #render(): void {
    const model = this.#model
    this.#eyebrow.textContent = this.#docRefs.map((doc) => KIND_LABEL[doc.kind]).join(' · ')
    this.#title.textContent = model.title
    // Which version this card is — a stable hook for the e2e suite and devtools.
    this.element.dataset.docPath = model.path
    // "updated" reads the newest of its documents: a plan written an hour after
    // the discovery is what changed last, not the discovery.
    const mtimeLabel =
      this.#docRefs.length > 1 ? formatMtimeLabel(newestMtime(this.#docRefs), Date.now()) : model.mtimeLabel
    this.#sub.textContent = artifactSubLine(model.feature, model.name, mtimeLabel)
    this.#summary.textContent = model.summary ?? ''
    this.#summary.hidden = model.summary === null
    this.#renderDocs()
    this.#renderActions()
  }

  /** The card's own press opens its document. It opened the board's discovery
   *  view until that view was retired (2026-10-08). */
  #pressCard(): void {
    this.#callbacks.onOpenDoc(this.#model)
  }

  /** A button per document, once the card stands for more than one. Clicking
   *  one opens THAT document — never the one behind the card. */
  #renderDocs(): void {
    this.#docs.replaceChildren()
    if (this.#docRefs.length < 2) {
      this.#docs.hidden = true
      return
    }
    for (const doc of this.#docRefs) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'fl-artifact-btn fl-artifact-doc'
      const isSelected = this.#selected()?.path === doc.path
      button.classList.toggle('fl-artifact-doc-selected', isSelected)
      button.setAttribute('aria-pressed', String(isSelected))
      const version = docVersionLabel(doc.name)
      button.textContent = version === null ? DOC_LABEL[doc.kind] : `${DOC_LABEL[doc.kind]} ${version}`
      button.title = `Open ${doc.name}`
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        // The chip chooses which document the card's actions are about, and
        // opens it, as it always did.
        if (this.#chosenPath !== doc.path) {
          this.#chosenPath = doc.path
          this.#execute = 'idle'
          this.#renderDocs()
          this.#renderActions()
        }
        this.#callbacks.onOpenDoc({ ...this.#model, kind: doc.kind, path: doc.path, name: doc.name })
      })
      button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
      })
      this.#docs.appendChild(button)
    }
    this.#docs.hidden = false
  }

  #renderActions(): void {
    // The card's own press opens its document. The row follows the selected
    // document (`artifactRowActions`): a discovery offers Create the plan
    // (until the card holds one), Open md file and its artifact door; a plan
    // offers Review the change, Execute the plan and Open md file.
    this.#actions.replaceChildren()
    this.element.title = 'Open as preview'
    const selected = this.#selected() ?? docRefOf(this.#model)
    const plan = this.#selectedPlan()
    const counts = plan?.counts ?? null
    const feature = this.#model.featureViewAction
    const row = artifactRowActions({
      selected: selected.kind,
      holds: [
        ...this.#docRefs.map((doc) => doc.kind),
        ...(this.#callbacks.planWrittenFor?.(this.#model.feature) === true ? (['plan'] as const) : []),
      ],
      openDoc: showsOpenDocButton(this.#model) || (selected.kind === 'plan' && this.#model.feature !== null),
      artifact: feature !== null,
      notes: counts,
    })
    for (const action of row) this.#appendAction(action, selected, plan)
    this.#actions.hidden = row.length === 0
    this.#renderPills(selected.kind === 'plan' ? counts : null)
    this.#renderRun(selected, plan)
    this.#syncStoryVisibility()
  }

  #appendAction(action: ArtifactRowAction, selected: ArtifactDocRef, plan: CardPlanState | null): void {
    const feature = this.#model.featureViewAction
    switch (action) {
      case 'create-plan': {
        const discovery = selected
        const requested = this.#callbacks.planRequested?.(discovery.path) === true
        const button = this.#actionButton(
          PLAN_CREATE_LABEL,
          requested
            ? 'Flow has asked the agent to plan from this discovery.'
            : 'Ask the agent to write the implementation plan from this discovery.',
          () => {
            // Sent once, never twice — asked of the pane, which outlives this card.
            if (this.#callbacks.planRequested?.(discovery.path) === true) return
            if (this.#callbacks.onCreatePlan?.(discovery.path) === true) this.#renderActions()
          },
        )
        button.classList.add('fl-artifact-btn-go')
        if (requested) button.disabled = true
        this.#actions.appendChild(button)
        return
      }
      case 'review-change': {
        const button = this.#actionButton(
          PLAN_REVIEW_LABEL,
          'Read each change this plan will make, as code, and accept or reject it.',
          () => this.#callbacks.onReviewChange?.(selected),
        )
        button.classList.add('fl-artifact-btn-primary')
        this.#actions.appendChild(button)
        return
      }
      case 'execute-plan': {
        const button = this.#actionButton(
          PLAN_EXECUTE_LABEL,
          'Ask the agent to build this plan, phase by phase.',
          () => this.#pressExecute(selected),
        )
        button.classList.add('fl-artifact-btn-go')
        if (plan?.running != null || this.#execute === 'confirm') button.disabled = true
        this.#actions.appendChild(button)
        return
      }
      case 'open-doc':
        this.#actions.appendChild(
          this.#actionButton(OPEN_DOC_LABEL, openDocTooltip(selected.kind), () =>
            this.#callbacks.onOpenDoc({ ...this.#model, kind: selected.kind, path: selected.path, name: selected.name }),
          ),
        )
        return
      case 'artifact':
        if (feature === null) return
        if (feature.state === 'writing') {
          // THE PAGE EXISTS BUT IS NOT A PAGE YET: /artifact copies the template
          // and fills it in place, and opening it now showed the empty template.
          // Only this door waits; the page's own change event re-renders it ready.
          this.#actions.appendChild(this.#writingButton())
        } else if (feature.state === 'generate') {
          // NO PAGE YET: discoveries no longer write one by themselves, so the
          // card offers to have it written — a message into this thread.
          const generate = this.#actionButton(
            ARTIFACT_GENERATE_LABEL,
            'Ask the agent to write a step-by-step walkthrough of what people will see in this feature.',
            () => this.#callbacks.onGenerateArtifact(this.#model),
          )
          generate.classList.add('fl-artifact-btn-generate')
          this.#actions.appendChild(generate)
        } else {
          this.#actions.appendChild(
            this.#actionButton(
              ARTIFACT_OPEN_LABEL,
              'Show what people will see in this feature, as a step-by-step walkthrough.',
              () => this.#callbacks.onOpenFeatureView(this.#model),
            ),
          )
        }
        return
    }
  }

  /** Execute the plan: ask first when a note is unreviewed, else send. */
  #pressExecute(plan: ArtifactDocRef): void {
    const counts = this.#selectedPlan()?.counts ?? null
    if (executePressState(counts) === 'confirm') {
      this.#execute = 'confirm'
      this.#renderActions()
      return
    }
    this.#execute = 'idle'
    this.#callbacks.onExecutePlan?.(plan)
  }

  /** The note pills: notes / accepted / rejected / to review. */
  #renderPills(counts: PlanNoteCounts | null): void {
    const pills = notePills(counts)
    this.#pills.replaceChildren(
      ...pills.map((pill) => {
        const span = document.createElement('span')
        span.className = `fl-artifact-pill fl-artifact-pill-${pill.tone}`
        span.textContent = pill.label
        return span
      }),
    )
    this.#pills.hidden = pills.length === 0
  }

  /** The confirm box, or the running line, under the row. */
  #renderRun(selected: ArtifactDocRef, plan: CardPlanState | null): void {
    this.#run.replaceChildren()
    this.#run.classList.remove('fl-artifact-confirm', 'fl-artifact-running')
    if (selected.kind !== 'plan') {
      this.#run.hidden = true
      return
    }
    if (plan?.running != null) {
      this.#run.classList.add('fl-artifact-running')
      const line = document.createElement('span')
      line.className = 'fl-artifact-run-line'
      line.textContent = plan.running
      const bar = document.createElement('div')
      bar.className = 'fl-artifact-run-bar'
      bar.setAttribute('role', 'progressbar')
      bar.setAttribute('aria-label', plan.running)
      bar.appendChild(document.createElement('i'))
      this.#run.append(line, bar)
      if (plan.runningNote !== null) {
        const note = document.createElement('span')
        note.className = 'fl-artifact-run-note'
        note.textContent = plan.runningNote
        this.#run.appendChild(note)
      }
      this.#run.hidden = false
      return
    }
    const text = this.#execute === 'confirm' ? executeConfirmText(plan?.counts ?? null) : null
    if (text === null) {
      this.#execute = 'idle'
      this.#run.hidden = true
      return
    }
    this.#run.classList.add('fl-artifact-confirm')
    const sentence = document.createElement('span')
    sentence.textContent = text
    const buttons = document.createElement('div')
    buttons.className = 'fl-artifact-run-buttons'
    const anyway = this.#actionButton(EXECUTE_ANYWAY_LABEL, 'Build the plan now, with the notes as they are.', () => {
      this.#execute = 'idle'
      this.#callbacks.onExecutePlan?.(selected)
      this.#renderActions()
    })
    anyway.classList.add('fl-artifact-btn-go')
    const first = this.#actionButton(REVIEW_FIRST_LABEL, 'Review the notes before anything is built.', () => {
      this.#execute = 'idle'
      this.#callbacks.onReviewChange?.(selected)
      this.#renderActions()
    })
    first.classList.add('fl-artifact-btn-primary')
    const cancel = this.#actionButton(CANCEL_LABEL, 'Build nothing for now.', () => {
      this.#execute = 'idle'
      this.#renderActions()
    })
    buttons.append(anyway, first, cancel)
    this.#run.append(sentence, buttons)
    this.#run.hidden = false
  }

  /** The artifact door while its page is being written: a loader, not a door. */
  #writingButton(): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'fl-artifact-btn fl-artifact-btn-accent fl-artifact-btn-writing'
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
    button.title = 'The artifact — what people will see — is still being written. It opens here when it is ready.'
    const spinner = document.createElement('span')
    spinner.className = 'fl-artifact-spinner'
    spinner.setAttribute('aria-hidden', 'true')
    button.append(spinner, ARTIFACT_WRITING_LABEL)
    return button
  }

  /** One accent action button. Disabled while a narrate is in flight, like
   *  every action on the card. */
  #actionButton(label: string, title: string, onPress: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'fl-artifact-btn fl-artifact-btn-accent'
    button.textContent = label
    button.title = title
    button.disabled = this.#busy
    // THE CARD IS ALSO CLICKABLE, so the press must stop here or it opens the
    // markdown behind the surface it just asked for. Enter on a focused button
    // fires click AND bubbles its own keydown to the card's Enter handler, so
    // both channels are stopped.
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      onPress()
    })
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
    })
    return button
  }

}

let stylesInjected = false

function injectArtifactStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  // Same drafting palette (Prussian/vellum) as the StoryCard so the two flow
  // cards read as one family. Dark is the default; light applies via
  // prefers-color-scheme AND the app's <html data-theme> stamp (data-theme wins).
  style.textContent = `
    .fl-artifact-card {
      --art-accent: #6ea8d8;
      --art-bg: #12202e;
      --art-bg-raised: #17293a;
      --art-fg: #e8e2d0;
      --art-muted: #9fb3c4;
      --art-border: #2f4a63;
      --art-glow: rgba(110,168,216,0.28);
      display: flex;
      flex-direction: column;
      gap: var(--fl-space-xs);
      padding: var(--fl-space-md);
      color: var(--art-fg);
      background: var(--art-bg);
      border: 1px solid var(--art-border);
      border-left: 3px solid var(--art-accent);
      border-radius: var(--fl-radius-md);
      box-shadow: 0 0 0 1px var(--art-glow), 0 6px 22px -12px var(--art-glow);
      font-family: var(--fl-font-ui);
    }
    @media (prefers-color-scheme: light) {
      .fl-artifact-card {
        --art-accent: #2b4a6f;
        --art-bg: #f4efe0;
        --art-bg-raised: #ece5d2;
        --art-fg: #1f2d3a;
        --art-muted: #5a6b78;
        --art-border: #d8cdb0;
        --art-glow: rgba(43,74,111,0.18);
      }
    }
    :root[data-theme="dark"] .fl-artifact-card {
      --art-accent: #6ea8d8;
      --art-bg: #12202e;
      --art-bg-raised: #17293a;
      --art-fg: #e8e2d0;
      --art-muted: #9fb3c4;
      --art-border: #2f4a63;
      --art-glow: rgba(110,168,216,0.28);
    }
    :root[data-theme="light"] .fl-artifact-card {
      --art-accent: #2b4a6f;
      --art-bg: #f4efe0;
      --art-bg-raised: #ece5d2;
      --art-fg: #1f2d3a;
      --art-muted: #5a6b78;
      --art-border: #d8cdb0;
      --art-glow: rgba(43,74,111,0.18);
    }
    .fl-artifact-head { display: flex; align-items: center; gap: var(--fl-space-sm); }
    .fl-artifact-glyph { font-size: 14px; line-height: 1; }
    .fl-artifact-eyebrow {
      font-size: var(--fl-text-caption-size); font-weight: var(--fl-text-ui-weight-medium);
      letter-spacing: 0.16em; color: var(--art-accent);
    }
    .fl-artifact-title {
      font-size: var(--fl-text-prose-size); font-weight: var(--fl-text-ui-weight-medium);
      color: var(--art-fg); overflow-wrap: break-word;
    }
    .fl-artifact-summary {
      margin: 0; font-size: var(--fl-text-caption-size); line-height: 1.45; color: var(--art-muted);
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
    }
    .fl-artifact-summary[hidden] { display: none; }
    .fl-artifact-sub {
      font-family: var(--fl-font-mono, monospace); font-size: var(--fl-text-caption-size);
      color: var(--art-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* Mounted story (see mountStory). The StoryCard keeps its own palette but
       sheds its outer chrome — border, glow, radius, padding — so the two read
       as ONE card with a divider, not a card floating inside a card. */
    .fl-artifact-story { margin-top: var(--fl-space-xs); padding-top: var(--fl-space-sm); border-top: 1px solid var(--art-border); }
    .fl-artifact-story[hidden] { display: none; }
    .fl-artifact-story .fl-story-card {
      border: none; border-left: none; border-radius: 0; box-shadow: none;
      background: transparent; padding: 0;
    }
    .fl-artifact-docs { display: flex; flex-wrap: wrap; gap: var(--fl-space-xs); }
    .fl-artifact-docs[hidden] { display: none; }
    .fl-artifact-actions {
      display: flex; flex-wrap: wrap; gap: var(--fl-space-xs);
      padding-top: var(--fl-space-xs); margin-top: 2px;
      border-top: 1px solid var(--art-border);
    }
    /* The plan's note pills, the Execute confirm box and the running line. */
    .fl-artifact-card {
      --art-ok: #7cc49a;
      --art-no: #e08a7e;
      --art-wait: #e3c06a;
    }
    @media (prefers-color-scheme: light) {
      .fl-artifact-card { --art-ok: #2f7a4f; --art-no: #a8443a; --art-wait: #8a6a12; }
    }
    :root[data-theme="dark"] .fl-artifact-card { --art-ok: #7cc49a; --art-no: #e08a7e; --art-wait: #e3c06a; }
    :root[data-theme="light"] .fl-artifact-card { --art-ok: #2f7a4f; --art-no: #a8443a; --art-wait: #8a6a12; }
    .fl-artifact-pills { display: flex; flex-wrap: wrap; gap: var(--fl-space-xs); }
    .fl-artifact-pills[hidden] { display: none; }
    .fl-artifact-pill {
      border-radius: 999px; padding: 1px 8px; border: 1px solid var(--art-border);
      color: var(--art-muted); font-size: var(--fl-text-caption-size); font-variant-numeric: tabular-nums;
    }
    .fl-artifact-pill-ok { color: var(--art-ok); border-color: var(--art-ok); }
    .fl-artifact-pill-no { color: var(--art-no); border-color: var(--art-no); }
    .fl-artifact-pill-wait { color: var(--art-wait); border-color: var(--art-wait); border-style: dashed; }
    /* Doubled with .fl-artifact-btn: the base button rule below is declared
       later with the same weight and would otherwise win. */
    .fl-artifact-btn.fl-artifact-doc-selected { border-color: var(--art-accent); color: var(--art-accent); }
    .fl-artifact-btn.fl-artifact-btn-primary { border-color: var(--art-accent); background: var(--art-accent); color: var(--art-bg); }
    .fl-artifact-btn.fl-artifact-btn-primary:hover:not(:disabled) { color: var(--art-bg); filter: brightness(1.1); }
    .fl-artifact-btn.fl-artifact-btn-go { border-color: var(--art-ok); color: var(--art-ok); }
    .fl-artifact-btn.fl-artifact-btn-go:hover:not(:disabled) { background: var(--art-ok); color: var(--art-bg); border-color: var(--art-ok); }
    .fl-artifact-run { display: flex; flex-direction: column; gap: var(--fl-space-xs); font-size: var(--fl-text-caption-size); color: var(--art-muted); cursor: auto; }
    .fl-artifact-run[hidden] { display: none; }
    .fl-artifact-confirm { padding: var(--fl-space-sm); border: 1px dashed var(--art-wait); border-radius: var(--fl-radius-sm); }
    .fl-artifact-run-buttons { display: flex; flex-wrap: wrap; gap: var(--fl-space-xs); }
    .fl-artifact-run-line { color: var(--art-fg); }
    .fl-artifact-run-bar { position: relative; height: 3px; border-radius: 2px; background: var(--art-border); overflow: hidden; }
    .fl-artifact-run-bar i {
      position: absolute; top: 0; bottom: 0; width: 35%; background: var(--art-accent);
      animation: fl-artifact-run-slide 1.4s ease-in-out infinite;
    }
    @keyframes fl-artifact-run-slide { from { left: -35%; } to { left: 100%; } }
    /* THE CARD IS A BUTTON, so it says so under the pointer. The embedded story
       swallows its clicks (they do not open the view), so its area keeps the
       ordinary cursor; its own controls carry their own pointer. */
    .fl-artifact-clickable { cursor: pointer; }
    .fl-artifact-clickable .fl-artifact-story { cursor: auto; }
    .fl-artifact-btn {
      border: 1px solid var(--art-border); background: var(--art-bg-raised); color: var(--art-fg);
      cursor: pointer; padding: 4px var(--fl-space-sm); border-radius: var(--fl-radius-sm);
      font-family: var(--fl-font-ui); font-size: var(--fl-text-caption-size);
      transition: border-color 0.12s, color 0.12s, background 0.12s;
    }
    .fl-artifact-btn:hover:not(:disabled) { border-color: var(--art-accent); color: var(--art-accent); }
    .fl-artifact-btn:disabled { opacity: 0.5; cursor: default; }
    .fl-artifact-btn-accent {
      border-color: var(--art-accent); color: var(--art-accent);
    }
    .fl-artifact-btn-accent:hover:not(:disabled) {
      background: var(--art-accent); color: var(--art-bg);
    }
    /* A door whose page is still being written: it reads as working, not
       as broken, so it keeps full strength rather than the disabled fade. */
    .fl-artifact-btn-writing:disabled { opacity: 1; cursor: progress; display: inline-flex; align-items: center; gap: 6px; }
    .fl-artifact-spinner {
      width: 10px; height: 10px; border-radius: 50%;
      border: 1.5px solid currentColor; border-right-color: transparent;
      animation: fl-artifact-spin 0.8s linear infinite;
    }
    @keyframes fl-artifact-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .fl-artifact-btn { transition: none; }
      .fl-artifact-run-bar i { animation: none; left: 0; width: 100%; opacity: 0.5; }
      .fl-artifact-spinner { animation: none; border-right-color: currentColor; opacity: 0.6; }
    }
  `
  document.head.appendChild(style)
}
