/**
 * StoryCard — the compiled blueprint story rendered inline in the conversation
 * thread (blueprint-v2 Phase 4). Mirrors the QuestionCard / ToolCard live-card
 * architecture: a constructor builds `element`, and the pane appends it via
 * `entryWrapper('story', card.element)`, tracks it in an in-memory map, and
 * drops it on setThread / story-clear (never persisted).
 *
 * On every step change the card fires the `onStepChange` callback;
 * minimizing fires `onStepChange(null)`. The card no longer reaches the
 * blueprint board: its Blueprint button and the board decoration of the active
 * step were retired with the board's discovery view (2026-10-08).
 *
 * ANCHORS OPEN THE CODE (user call 2026-10-14). A step anchor that names one
 * concrete file (kind 'file', or 'symbol' with a `file` scope — see
 * story-card-model's `anchorPrimaryAction`) opens it in the editor when its own
 * chip is clicked, by dispatching `flow:open-file-path` {path} on document —
 * the same bridge a file path in chat markdown uses, so the path is resolved by
 * the editor's one resolver (flow/ dirs, the thread's checkout, then a bounded
 * search) rather than by a second one here. Attaching the reference to the
 * composer keeps a small control of its own beside the chip.
 *
 * This replaced the peek affordance (Phase 5, #568) on this card: the chip now
 * does the stronger version of what peeking did, and a third control on one
 * chip reads as clutter. The board keeps its own `flow:peek-file` entry points.
 *
 * SAFETY: every interpolated string reaches the DOM via `textContent` /
 * `createTextNode`, never innerHTML — model output (titles, prose, chips) is
 * inert by construction. Prose supports paragraphs + inline `code` spans only.
 */
import type { BlueprintStory, BlueprintStoryStep } from '../../shared/ipc-contract'
import { anchorPrimaryAction, capChips, clampStep } from './story-card-model'

/** A blueprint reference the card asks the composer to attach (Phase 5 wiring). */
export interface StoryAttachRef {
  nodeId: string
  label: string
}

export interface StoryCardOptions {
  story: BlueprintStory
  /** Fired with the active step on navigation, or null on minimize. */
  onStepChange?: (step: BlueprintStoryStep | null) => void
  /** Fired when the user attaches a step anchor to the composer. */
  onAttach?: (ref: StoryAttachRef) => void
}

export class StoryCard {
  readonly element: HTMLElement
  #story: BlueprintStory
  #index = 0
  #minimized = false
  readonly #onStepChange?: (step: BlueprintStoryStep | null) => void
  readonly #onAttach?: (ref: StoryAttachRef) => void

  // Stable chrome (built once, updated in place).
  #meta: HTMLElement
  #toggleBtn: HTMLButtonElement
  #body: HTMLElement
  #chipRow: HTMLElement
  #stepHost: HTMLElement
  #backBtn: HTMLButtonElement
  #nextBtn: HTMLButtonElement
  #navLabel: HTMLElement

  constructor(opts: StoryCardOptions) {
    injectStoryStyles()
    this.#story = opts.story
    this.#onStepChange = opts.onStepChange
    this.#onAttach = opts.onAttach

    this.element = document.createElement('div')
    this.element.className = 'fl-story-card'
    this.element.tabIndex = 0
    this.element.setAttribute('role', 'group')
    this.element.setAttribute('aria-label', 'Blueprint story')

    // ── Header row ─────────────────────────────────────────────────────────
    const head = document.createElement('div')
    head.className = 'fl-story-head'
    const icon = document.createElement('span')
    icon.className = 'fl-story-glyph'
    icon.textContent = '📖'
    icon.setAttribute('aria-hidden', 'true')
    const label = document.createElement('span')
    label.className = 'fl-story-label'
    label.textContent = 'STORY'
    this.#meta = document.createElement('span')
    this.#meta.className = 'fl-story-meta'
    this.#toggleBtn = document.createElement('button')
    this.#toggleBtn.type = 'button'
    this.#toggleBtn.className = 'fl-story-toggle'
    this.#toggleBtn.addEventListener('click', () => this.setMinimized(!this.#minimized))
    head.append(icon, label, this.#meta, this.#toggleBtn)
    this.element.appendChild(head)

    // ── Body (chips → step → nav) ────────────────────────────────────────────
    this.#body = document.createElement('div')
    this.#body.className = 'fl-story-body'

    this.#chipRow = document.createElement('div')
    this.#chipRow.className = 'fl-story-steps'
    this.#chipRow.setAttribute('role', 'tablist')

    this.#stepHost = document.createElement('div')
    this.#stepHost.className = 'fl-story-step'

    const nav = document.createElement('div')
    nav.className = 'fl-story-nav'
    this.#backBtn = document.createElement('button')
    this.#backBtn.type = 'button'
    this.#backBtn.className = 'fl-story-nav-btn'
    this.#backBtn.textContent = '◀ Back'
    this.#backBtn.addEventListener('click', () => this.prev())
    this.#navLabel = document.createElement('span')
    this.#navLabel.className = 'fl-story-nav-label'
    this.#nextBtn = document.createElement('button')
    this.#nextBtn.type = 'button'
    this.#nextBtn.className = 'fl-story-nav-btn'
    this.#nextBtn.textContent = 'Next ▶'
    this.#nextBtn.addEventListener('click', () => this.next())
    nav.append(this.#backBtn, this.#navLabel, this.#nextBtn)

    this.#body.append(this.#chipRow, this.#stepHost, nav)
    this.element.appendChild(this.#body)

    // Arrow-key navigation while the card (or a child) has focus.
    this.element.addEventListener('keydown', (event) => this.#onKeydown(event))

    this.#render()
    this.#emit()
  }

  /** Replace the story in place (compile refreshed / plan switched). Clamps the
   *  current step into range so an edit that removes steps never dangles. */
  setStory(story: BlueprintStory): void {
    this.#story = story
    this.#index = clampStep(this.#index, story.steps.length)
    this.#render()
    this.#emit()
  }

  /** Collapse to the header line (minimize) or restore the full card (expand). */
  setMinimized(minimized: boolean): void {
    if (this.#minimized === minimized) return
    this.#minimized = minimized
    this.#render()
    this.#emit()
  }

  get minimized(): boolean {
    return this.#minimized
  }

  next(): void {
    this.goTo(this.#index + 1)
  }

  prev(): void {
    this.goTo(this.#index - 1)
  }

  goTo(index: number): void {
    const clamped = clampStep(index, this.#story.steps.length)
    if (clamped === this.#index) return
    this.#index = clamped
    this.#render()
    this.#emit()
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  #onKeydown(event: KeyboardEvent): void {
    if (this.#minimized || event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      this.prev()
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      this.next()
    }
  }

  /** The active step, or null when the story has no steps. */
  #activeStep(): BlueprintStoryStep | null {
    return this.#story.steps[this.#index] ?? null
  }

  /** Report the active step (null while minimized) to the owner. */
  #emit(): void {
    this.#onStepChange?.(this.#minimized ? null : this.#activeStep())
  }

  #render(): void {
    const count = this.#story.steps.length
    const human = count > 0 ? this.#index + 1 : 0
    this.#meta.textContent = `${this.#story.plan} · step ${human}/${count}`
    this.element.classList.toggle('fl-story-minimized', this.#minimized)
    this.#toggleBtn.textContent = this.#minimized ? 'Expand' : 'Minimize'
    this.#toggleBtn.setAttribute('aria-expanded', String(!this.#minimized))
    this.#body.hidden = this.#minimized
    if (this.#minimized) return

    this.#renderChipRow()
    this.#renderStep()

    this.#navLabel.textContent = count > 0 ? `STEP ${human} / ${count}` : 'No steps'
    this.#backBtn.disabled = count === 0 || this.#index === 0
    this.#nextBtn.disabled = count === 0 || this.#index >= count - 1
  }

  #renderChipRow(): void {
    this.#chipRow.replaceChildren()
    this.#story.steps.forEach((step, i) => {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'fl-story-stepchip'
      chip.classList.toggle('active', i === this.#index)
      chip.setAttribute('role', 'tab')
      chip.setAttribute('aria-selected', String(i === this.#index))
      chip.textContent = String(i + 1)
      chip.title = step.title
      chip.addEventListener('click', () => this.goTo(i))
      this.#chipRow.appendChild(chip)
    })
  }

  #renderStep(): void {
    this.#stepHost.replaceChildren()
    const step = this.#activeStep()
    if (!step) {
      const empty = document.createElement('div')
      empty.className = 'fl-story-empty'
      empty.textContent = 'This story has no steps yet.'
      this.#stepHost.appendChild(empty)
      return
    }

    if (step.kicker) {
      const kicker = document.createElement('div')
      kicker.className = 'fl-story-kicker'
      kicker.textContent = step.kicker
      this.#stepHost.appendChild(kicker)
    }

    const title = document.createElement('div')
    title.className = 'fl-story-title'
    title.textContent = step.title
    this.#stepHost.appendChild(title)

    const prose = renderProse(step.body)
    this.#stepHost.appendChild(prose)

    if (step.anchors.length > 0) {
      this.#stepHost.appendChild(this.#renderAnchors(step))
    }

    if (step.decisions.length > 0) {
      this.#stepHost.appendChild(this.#renderGroup('decisions', 'Decisions', step.decisions))
    }
    if (step.rejected.length > 0) {
      this.#stepHost.appendChild(this.#renderGroup('rejected', 'Rejected', step.rejected))
    }
    if (step.questions.length > 0) {
      this.#stepHost.appendChild(this.#renderGroup('open', 'Open', step.questions, 'PENDING'))
    }
  }

  /** A capped chip group with a colored left edge (decisions/rejected/open). */
  #renderGroup(variant: string, label: string, items: string[], pill?: string): HTMLElement {
    const group = document.createElement('div')
    group.className = `fl-story-group fl-story-group-${variant}`

    const header = document.createElement('div')
    header.className = 'fl-story-group-head'
    const name = document.createElement('span')
    name.className = 'fl-story-group-label'
    name.textContent = label
    header.appendChild(name)
    if (pill) {
      const badge = document.createElement('span')
      badge.className = 'fl-story-pill'
      badge.textContent = pill
      header.appendChild(badge)
    }
    group.appendChild(header)

    const list = document.createElement('div')
    list.className = 'fl-story-chips'
    for (const chip of capChips(items)) {
      const el = document.createElement('span')
      el.className = 'fl-story-chip'
      if (chip.overflow) el.classList.add('overflow')
      el.textContent = chip.text
      list.appendChild(el)
    }
    group.appendChild(list)
    return group
  }

  /** Anchor refs: the chip opens the file it names, else attaches the reference. */
  #renderAnchors(step: BlueprintStoryStep): HTMLElement {
    const group = document.createElement('div')
    group.className = 'fl-story-group fl-story-group-anchors'
    const header = document.createElement('div')
    header.className = 'fl-story-group-head'
    const name = document.createElement('span')
    name.className = 'fl-story-group-label'
    name.textContent = 'Anchors'
    header.appendChild(name)
    group.appendChild(header)
    const list = document.createElement('div')
    list.className = 'fl-story-chips'
    for (const anchor of step.anchors) {
      const row = document.createElement('span')
      row.className = 'fl-story-anchor-row'
      const action = anchorPrimaryAction(anchor)
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'fl-story-chip fl-story-anchor'
      btn.textContent = anchor.ref
      if (action.kind === 'open') {
        const path = action.path
        btn.title = `Open ${path}`
        btn.addEventListener('click', () => {
          document.dispatchEvent(new CustomEvent('flow:open-file-path', { detail: { path } }))
        })
      } else {
        btn.title = `Add ${anchor.ref} to the message`
        btn.addEventListener('click', () => this.#onAttach?.({ nodeId: anchor.ref, label: anchor.ref }))
        btn.disabled = this.#onAttach === undefined
      }
      row.appendChild(btn)
      // The chip opens; this keeps attaching one click away for an anchor whose
      // chip is now spoken for. An anchor with nothing to open already attaches
      // on its chip, so a second control there would do the same thing twice.
      if (action.kind === 'open' && this.#onAttach !== undefined) {
        const attachBtn = document.createElement('button')
        attachBtn.type = 'button'
        attachBtn.className = 'fl-story-anchor-attach'
        attachBtn.title = `Add ${anchor.ref} to the message`
        attachBtn.setAttribute('aria-label', `Add ${anchor.ref} to the message`)
        attachBtn.textContent = '+'
        attachBtn.addEventListener('click', () =>
          this.#onAttach?.({ nodeId: anchor.ref, label: anchor.ref }),
        )
        row.appendChild(attachBtn)
      }
      list.appendChild(row)
    }
    group.appendChild(list)
    return group
  }
}

/** Minimal prose: blank-line paragraphs + inline `code` spans, all text-safe. */
function renderProse(body: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'fl-story-prose'
  const paragraphs = body.split(/\n\s*\n/)
  for (const raw of paragraphs) {
    const text = raw.replace(/\s*\n\s*/g, ' ').trim()
    if (!text) continue
    const p = document.createElement('p')
    appendInline(p, text)
    wrap.appendChild(p)
  }
  return wrap
}

/** Append `text` to `p`, rendering backtick-delimited spans as inline code. */
function appendInline(p: HTMLElement, text: string): void {
  const parts = text.split(/(`[^`]+`)/g)
  for (const part of parts) {
    if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
      const code = document.createElement('code')
      code.className = 'fl-story-inline-code'
      code.textContent = part.slice(1, -1)
      p.appendChild(code)
    } else if (part) {
      p.appendChild(document.createTextNode(part))
    }
  }
}

let stylesInjected = false

function injectStoryStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  // Drafting palette (Prussian/vellum) scoped to the card so chat chrome stays
  // untouched. Dark is the default; light applies via prefers-color-scheme AND
  // the app's <html data-theme> stamp (data-theme wins over the media query).
  style.textContent = `
    .fl-story-card {
      --story-accent: #6ea8d8;
      --story-bg: #12202e;
      --story-bg-raised: #17293a;
      --story-fg: #e8e2d0;
      --story-muted: #9fb3c4;
      --story-border: #2f4a63;
      --story-glow: rgba(110,168,216,0.28);
      --story-green: #7fbf9a;
      --story-red: #d98a8a;
      --story-amber: #d9b86a;
      position: relative;
      display: flex;
      flex-direction: column;
      gap: var(--fl-space-sm);
      padding: var(--fl-space-md);
      color: var(--story-fg);
      background: var(--story-bg);
      border: 1px solid var(--story-border);
      border-left: 3px solid var(--story-accent);
      border-radius: var(--fl-radius-md);
      box-shadow: 0 0 0 1px var(--story-glow), 0 6px 22px -12px var(--story-glow);
      font-family: var(--fl-font-ui);
      outline: none;
    }
    .fl-story-card:focus-visible { box-shadow: 0 0 0 2px var(--story-accent); }
    @media (prefers-color-scheme: light) {
      .fl-story-card {
        --story-accent: #2b4a6f;
        --story-bg: #f4efe0;
        --story-bg-raised: #ece5d2;
        --story-fg: #1f2d3a;
        --story-muted: #5a6b78;
        --story-border: #d8cdb0;
        --story-glow: rgba(43,74,111,0.18);
        --story-green: #3f7d54;
        --story-red: #b04d4d;
        --story-amber: #9a7a2e;
      }
    }
    :root[data-theme="dark"] .fl-story-card {
      --story-accent: #6ea8d8;
      --story-bg: #12202e;
      --story-bg-raised: #17293a;
      --story-fg: #e8e2d0;
      --story-muted: #9fb3c4;
      --story-border: #2f4a63;
      --story-glow: rgba(110,168,216,0.28);
      --story-green: #7fbf9a;
      --story-red: #d98a8a;
      --story-amber: #d9b86a;
    }
    :root[data-theme="light"] .fl-story-card {
      --story-accent: #2b4a6f;
      --story-bg: #f4efe0;
      --story-bg-raised: #ece5d2;
      --story-fg: #1f2d3a;
      --story-muted: #5a6b78;
      --story-border: #d8cdb0;
      --story-glow: rgba(43,74,111,0.18);
      --story-green: #3f7d54;
      --story-red: #b04d4d;
      --story-amber: #9a7a2e;
    }
    .fl-story-head { display: flex; align-items: center; gap: var(--fl-space-sm); }
    .fl-story-glyph { font-size: 15px; line-height: 1; }
    .fl-story-label {
      font-size: var(--fl-text-caption-size); font-weight: var(--fl-text-ui-weight-medium);
      letter-spacing: 0.16em; color: var(--story-accent);
    }
    .fl-story-meta {
      font-family: var(--fl-font-mono, monospace); font-size: var(--fl-text-caption-size);
      color: var(--story-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .fl-story-toggle {
      margin-left: auto; flex: none; border: 1px solid var(--story-border);
      background: var(--story-bg-raised); color: var(--story-fg); cursor: pointer;
      padding: 3px var(--fl-space-sm); border-radius: var(--fl-radius-sm);
      font-family: var(--fl-font-ui); font-size: var(--fl-text-caption-size);
    }
    .fl-story-toggle:hover { border-color: var(--story-accent); }
    .fl-story-minimized { gap: 0; }
    .fl-story-body[hidden] { display: none; }
    .fl-story-body { display: flex; flex-direction: column; gap: var(--fl-space-sm); }
    .fl-story-steps { display: flex; flex-wrap: wrap; gap: 4px; }
    .fl-story-stepchip {
      min-width: 22px; height: 22px; padding: 0 5px; border: 1px solid var(--story-border);
      background: var(--story-bg-raised); color: var(--story-muted); cursor: pointer;
      border-radius: var(--fl-radius-sm); font-size: var(--fl-text-caption-size);
      font-variant-numeric: tabular-nums; transition: background 0.12s, border-color 0.12s, color 0.12s;
    }
    .fl-story-stepchip:hover { border-color: var(--story-accent); }
    .fl-story-stepchip.active {
      background: var(--story-accent); border-color: var(--story-accent);
      color: var(--story-bg); font-weight: var(--fl-text-ui-weight-medium);
    }
    .fl-story-step { display: flex; flex-direction: column; gap: var(--fl-space-xs); }
    .fl-story-kicker {
      font-size: var(--fl-text-caption-size); letter-spacing: 0.18em; text-transform: uppercase;
      color: var(--story-accent); opacity: 0.9;
    }
    .fl-story-title {
      font-size: var(--fl-text-prose-size); font-weight: var(--fl-text-ui-weight-medium);
      color: var(--story-fg);
    }
    .fl-story-prose { font-size: var(--fl-text-prose-size); color: var(--story-fg); }
    .fl-story-prose p { margin: 0 0 var(--fl-space-xs); line-height: 1.5; overflow-wrap: break-word; }
    .fl-story-prose p:last-child { margin-bottom: 0; }
    .fl-story-inline-code {
      font-family: var(--fl-font-mono, monospace); font-size: 0.9em;
      background: var(--story-bg-raised); border: 1px solid var(--story-border);
      border-radius: 3px; padding: 0 3px;
    }
    .fl-story-empty { font-size: var(--fl-text-caption-size); color: var(--story-muted); font-style: italic; }
    .fl-story-group {
      display: flex; flex-direction: column; gap: 3px; padding: 4px 0 4px var(--fl-space-sm);
      border-left: 2px solid var(--story-border); margin-top: 2px;
    }
    .fl-story-group-decisions { border-left-color: var(--story-green); }
    .fl-story-group-rejected { border-left-color: var(--story-red); }
    .fl-story-group-open { border-left-color: var(--story-amber); }
    .fl-story-group-anchors { border-left-color: var(--story-accent); }
    .fl-story-group-head { display: flex; align-items: center; gap: var(--fl-space-xs); }
    .fl-story-group-label {
      font-size: var(--fl-text-caption-size); letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--story-muted);
    }
    .fl-story-pill {
      font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase;
      color: var(--story-amber); border: 1px solid var(--story-amber);
      border-radius: 999px; padding: 0 6px; line-height: 1.5;
    }
    .fl-story-chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .fl-story-chip {
      font-size: var(--fl-text-caption-size); color: var(--story-fg);
      background: var(--story-bg-raised); border: 1px solid var(--story-border);
      border-radius: var(--fl-radius-sm); padding: 2px var(--fl-space-sm); line-height: 1.4;
    }
    .fl-story-chip.overflow { color: var(--story-muted); font-style: italic; background: transparent; }
    .fl-story-group-rejected .fl-story-chip { text-decoration: line-through; color: var(--story-muted); }
    .fl-story-anchor {
      cursor: pointer; font-family: var(--fl-font-mono, monospace);
    }
    .fl-story-anchor:hover { border-color: var(--story-accent); color: var(--story-accent); }
    .fl-story-anchor-row { display: inline-flex; align-items: center; gap: 2px; }
    .fl-story-anchor-attach {
      flex: none; border: none; background: transparent; cursor: pointer;
      color: var(--story-muted); font-size: 12px; line-height: 1; padding: 0 2px;
    }
    .fl-story-anchor-attach:hover, .fl-story-anchor-attach:focus-visible { color: var(--story-accent); }
    .fl-story-nav {
      display: flex; align-items: center; justify-content: space-between; gap: var(--fl-space-sm);
      padding-top: var(--fl-space-xs); border-top: 1px solid var(--story-border);
    }
    .fl-story-nav-btn {
      border: 1px solid var(--story-border); background: var(--story-bg-raised); color: var(--story-fg);
      cursor: pointer; padding: 4px var(--fl-space-sm); border-radius: var(--fl-radius-sm);
      font-family: var(--fl-font-ui); font-size: var(--fl-text-caption-size);
    }
    .fl-story-nav-btn:hover:not(:disabled) { border-color: var(--story-accent); }
    .fl-story-nav-btn:disabled { opacity: 0.4; cursor: default; }
    .fl-story-nav-label {
      font-size: var(--fl-text-caption-size); letter-spacing: 0.08em; color: var(--story-muted);
      font-variant-numeric: tabular-nums;
    }
    @media (prefers-reduced-motion: reduce) {
      .fl-story-stepchip { transition: none; }
    }
  `
  document.head.appendChild(style)
}
