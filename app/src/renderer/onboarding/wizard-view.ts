// Onboarding wizard overlay (#48, Phase 3) — the shell: Stark-styled overlay
// (reusing .fl-settings-overlay chrome), a step indicator, Back/Skip/Next, and
// focus handling. Step CONTENT is injected as StepView objects (Phase 4), so the
// shell stays generic and the navigation gating comes from the pure controller.

import { injectSettingsStyles } from '../settings/settings-view'
import { cancelLoginOwnedBy, WIZARD_LOGIN_SURFACE } from '../accounts/login-inflight'
import { markModalOverlay } from '../modal-overlay'
import {
  WizardController,
  canAdvance,
  type StepId,
  type WizardState,
} from './wizard-controller'

/** Context handed to each step so it can report progress + drive navigation. */
export interface WizardContext {
  readonly state: WizardState
  /** Merge into the wizard state and refresh the Next button's enabled-ness. */
  update(patch: Partial<WizardState>): void
  /** Advance to the next step (or finish on the last). */
  next(): void
  /** Close the wizard without marking it complete. */
  close(): void
}

/** One step's content. `render` populates the body; it may use `ctx` freely. */
export interface StepView {
  id: StepId
  title: string
  /** A title that depends on answers given earlier — the Connect step names the
   *  runtime the user actually chose. Falls back to `title` when absent. */
  titleFor?(state: WizardState): string
  render(container: HTMLElement, ctx: WizardContext): void
  /**
   * The step's DOM is about to go (navigation, Skip, Escape, Finish). A step
   * that mounted something live — a subscription, a timer — releases it here.
   */
  leave?(): void
}

export interface WizardOptions {
  steps: StepView[]
  /** Called when the user finishes the last step (persist completion here). */
  onComplete: (state: WizardState) => void | Promise<void>
}

let wizardStylesInjected = false
function injectWizardStyles(): void {
  if (wizardStylesInjected) return
  wizardStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-wizard-steps { display: flex; gap: var(--fl-space-sm); padding: 0 var(--fl-space-lg); }
    .fl-wizard-dot {
      flex: 1; height: 3px; border-radius: 2px; background: var(--fl-color-border);
      transition: background var(--fl-transition-fast);
    }
    .fl-wizard-dot[data-active="true"] { background: var(--fl-color-accent); }
    .fl-wizard-body { padding: var(--fl-space-lg); overflow-y: auto; flex: 1; }
    .fl-wizard-footer {
      display: flex; align-items: center; justify-content: space-between;
      gap: var(--fl-space-sm); padding: var(--fl-space-md) var(--fl-space-lg);
      border-top: var(--fl-border-width) solid var(--fl-color-border);
    }
    .fl-wizard-btn {
      font-size: var(--fl-text-ui-size); padding: 6px 14px; border-radius: var(--fl-radius-md);
      border: var(--fl-border-width) solid var(--fl-color-border);
      background: var(--fl-color-surface-raised); color: var(--fl-color-text); cursor: pointer;
    }
    .fl-wizard-btn--primary { background: var(--fl-color-accent); border-color: var(--fl-color-accent); color: #fff; }
    .fl-wizard-btn:disabled { opacity: 0.5; cursor: default; }
    .fl-wizard-btn--ghost { background: transparent; }
  `
  document.head.appendChild(style)
}

export class OnboardingWizard {
  #overlay: HTMLDivElement
  #dots: HTMLDivElement
  #titleEl: HTMLDivElement
  #body: HTMLDivElement
  #backBtn: HTMLButtonElement
  #nextBtn: HTMLButtonElement
  #controller: WizardController
  #steps: StepView[]
  #onComplete: (state: WizardState) => void | Promise<void>
  /** #1356: a Finish commit is in flight — Finish must not re-fire. */
  #finishing = false
  /** The inline "couldn't save" line, created on first failure. */
  /**
   * The pending Finish failure, as STATE (#1461).
   *
   * It used to be a cached DOM node appended once to the wizard body — and every
   * step navigation calls `#body.replaceChildren()`, which detached it while the
   * field stayed non-null. So Back wiped the notice while the failure was still
   * unresolved, and every LATER failed Finish only set `.textContent` on a node
   * no longer in the document: the button flickered Finish → Saving… → Finish
   * and nothing else happened, forever — byte-for-byte the pre-#1356 silent
   * failure, one Back click away. What stays unwritten meanwhile is the app-wide
   * permission-prompt bypass, which only Finish commits.
   *
   * The mode step one screen earlier learned this in #1078, for the same reason:
   * "Back → Next re-renders the step, and the error must not evaporate while it
   * still gates Next."
   */
  #finishErrorText: string | null = null
  #state: WizardState = {
    // Unknown until the runtime step answers — not defaulted to Claude, which
    // would let the connect gate demand an Anthropic account before anybody had
    // said which agent they wanted.
    runtime: null,
    runtimeReady: false,
    accountConnected: false,
    projectOpen: false,
    mode: null,
    modePersistFailed: false,
    // Nobody has been asked yet — and that is not a no. See WizardState.
    telemetryConsent: null,
  }
  /** Escape-to-close, bound to DOCUMENT while open (#475) so it fires from any
   *  focus — not just when focus is inside the overlay. Added on open, removed on
   *  close (the wizard is per-open, so a document listener must not outlive it). */
  #onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.close()
  }

  constructor(opts: WizardOptions) {
    injectSettingsStyles()
    injectWizardStyles()
    this.#steps = opts.steps
    this.#onComplete = opts.onComplete
    this.#controller = new WizardController(opts.steps.map((s) => s.id))

    this.#overlay = document.createElement('div')
    this.#overlay.className = 'fl-settings-overlay'
    // Modal chrome: declare it to the shared guard so global panel shortcuts,
    // the terminal's autofocus and the focus trap all treat it as owning the
    // keyboard (#1002).
    markModalOverlay(this.#overlay)
    this.#overlay.hidden = true

    const panel = document.createElement('div')
    panel.className = 'fl-settings-panel'
    panel.tabIndex = -1

    const header = document.createElement('div')
    header.className = 'fl-settings-header'
    this.#titleEl = document.createElement('div')
    this.#titleEl.style.fontWeight = 'var(--fl-text-ui-weight-medium)'
    header.appendChild(this.#titleEl)

    this.#dots = document.createElement('div')
    this.#dots.className = 'fl-wizard-steps'
    for (let i = 0; i < this.#steps.length; i += 1) {
      const dot = document.createElement('div')
      dot.className = 'fl-wizard-dot'
      this.#dots.appendChild(dot)
    }

    this.#body = document.createElement('div')
    this.#body.className = 'fl-wizard-body'

    const footer = document.createElement('div')
    footer.className = 'fl-wizard-footer'
    this.#backBtn = this.#makeButton('Back', 'fl-wizard-btn fl-wizard-btn--ghost', () => {
      if (this.#controller.back()) this.#renderCurrent()
    })
    const skipBtn = this.#makeButton('Skip for now', 'fl-wizard-btn fl-wizard-btn--ghost', () =>
      this.close(),
    )
    this.#nextBtn = this.#makeButton('Next', 'fl-wizard-btn fl-wizard-btn--primary', () =>
      this.#advance(),
    )
    const rightGroup = document.createElement('div')
    rightGroup.style.display = 'flex'
    rightGroup.style.gap = 'var(--fl-space-sm)'
    rightGroup.append(skipBtn, this.#nextBtn)
    footer.append(this.#backBtn, rightGroup)

    panel.append(header, this.#dots, this.#body, footer)
    this.#overlay.appendChild(panel)
    // Escape is bound to DOCUMENT in open() (not the overlay) so it closes from any
    // focus (#475); the overlay is attached in open() and removed in close() (#474).
  }

  #makeButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = className
    btn.textContent = label
    btn.addEventListener('click', onClick)
    return btn
  }

  #ctx(): WizardContext {
    return {
      state: this.#state,
      update: (patch) => {
        this.#state = { ...this.#state, ...patch }
        this.#refreshNav()
      },
      next: () => this.#advance(),
      close: () => this.close(),
    }
  }

  #advance(): void {
    if (!canAdvance(this.#controller.current, this.#state)) return
    if (this.#controller.isLast) {
      // #1356: Finish is the COMMIT for the app-wide permission-prompt bypass,
      // and it was fire-and-forget — on a failed write the wizard closed
      // byte-for-byte the way it closes on success, so the user believed a
      // safety-relevant choice was saved when nothing was. AWAIT it, and keep
      // the wizard open on failure so the choice can be re-committed.
      this.#finishing = true
      this.#refreshNav()
      void Promise.resolve(this.#onComplete(this.#state))
        .then(() => {
          this.close()
        })
        .catch((error: unknown) => {
          this.#finishing = false
          this.#showFinishError(error)
          this.#refreshNav()
        })
      return
    }
    this.#controller.next()
    this.#renderCurrent()
  }

  /** Say the commit failed, in the wizard, without closing it (#1356). */
  #showFinishError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.#finishErrorText = `Couldn’t save your setup — ${message}. Try Finish again.`
    this.#renderFinishError()
  }

  /** Paint the pending failure onto whatever step is on screen (#1461). Called
   *  after every step render, so navigating away and back cannot lose it. */
  #renderFinishError(): void {
    for (const stale of this.#body.querySelectorAll('.fl-wizard-error')) stale.remove()
    if (this.#finishErrorText === null) return
    const line = document.createElement('div')
    line.className = 'fl-wizard-error'
    line.setAttribute('role', 'alert')
    line.textContent = this.#finishErrorText
    this.#body.appendChild(line)
  }

  #refreshNav(): void {
    this.#backBtn.style.visibility = this.#controller.isFirst ? 'hidden' : 'visible'
    // #1356: while the Finish commit is in flight the button says so and
    // cannot re-fire — a second write of the permission-bypass default is
    // exactly what a double-click should not produce.
    this.#nextBtn.textContent = this.#finishing
      ? 'Saving…'
      : this.#controller.isLast
        ? 'Finish'
        : 'Next'
    this.#nextBtn.disabled =
      this.#finishing || !canAdvance(this.#controller.current, this.#state)
    this.#dots.querySelectorAll('.fl-wizard-dot').forEach((dot, i) => {
      dot.setAttribute('data-active', String(i <= this.#controller.index))
    })
  }

  #renderCurrent(): void {
    // #1320: leaving a step DESTROYS its DOM — including the Connect step's
    // status line, sign-in URL, paste-your-code field and its only Cancel
    // button — while the `claude auth login` child keeps running and keeps the
    // orchestrator's single in-flight slot. Back→Next then re-rendered a bare
    // "Connect a Claude account" with no sign a sign-in was live, and every
    // later Add account / Connect died with "another sign-in is already in
    // progress", app-wide, with no Cancel anywhere.
    //
    // Navigating away abandons the sign-in, exactly as dismissing the wizard
    // already does. Fail-soft: nothing in flight is a no-op.
    void cancelLoginOwnedBy(WIZARD_LOGIN_SURFACE, window.flow.accounts.cancelLogin)
    this.#leaveCurrent()
    const step = this.#steps[this.#controller.index]
    this.#rendered = step
    this.#titleEl.textContent = step.titleFor?.(this.#state) ?? step.title
    this.#body.replaceChildren()
    step.render(this.#body, this.#ctx())
    // #1461: an unresolved Finish failure outlives the step it happened on.
    this.#renderFinishError()
    this.#refreshNav()
  }

  /** The step whose DOM is on screen, so it can let go of what it mounted. */
  #rendered: StepView | null = null

  #leaveCurrent(): void {
    const step = this.#rendered
    this.#rendered = null
    try {
      step?.leave?.()
    } catch (error) {
      console.warn('flow: onboarding step cleanup failed', error)
    }
  }

  open(): void {
    // Re-attach if a prior close() removed the overlay, so re-opening always works
    // and never leaves the previous overlay lingering in the DOM (#474).
    if (!this.#overlay.isConnected) document.body.appendChild(this.#overlay)
    this.#overlay.hidden = false
    // Document-level Escape so it closes from any focus, not just inside the overlay
    // (#475). Removed in close(). addEventListener dedups the same handler ref.
    document.addEventListener('keydown', this.#onKeydown)
    this.#controller = new WizardController(this.#steps.map((s) => s.id))
    this.#renderCurrent()
    ;(this.#overlay.querySelector('.fl-settings-panel') as HTMLElement | null)?.focus()
  }

  /** Close AND remove the overlay from the DOM — not just hide it — so repeated
   *  opens don't accumulate full-screen overlays (and their keydown listeners)
   *  on document.body (#474). The listeners live on the overlay, so they go with it. */
  close(): void {
    document.removeEventListener('keydown', this.#onKeydown) // don't leak the doc listener (#475)
    // #1167 (the un-fixed half of #1107): an interactive `claude auth login`
    // started from the Connect step outlives this DOM — the child sits on stdin
    // and the orchestrator's single-flight slot never clears, so every later
    // Add account / Connect dies with "another sign-in is already in progress",
    // app-wide, with no Cancel anywhere. Dismissing the wizard abandons that
    // sign-in, so say so out loud. Fail-soft: nothing in flight is a no-op.
    cancelLoginOwnedBy(WIZARD_LOGIN_SURFACE, window.flow.accounts.cancelLogin)
    this.#leaveCurrent()
    this.#overlay.hidden = true
    this.#overlay.remove()
  }
}
