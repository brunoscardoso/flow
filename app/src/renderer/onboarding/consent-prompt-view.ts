/**
 * THE TELEMETRY QUESTION, ASKED ON THE THIRD DAY SOMEBODY USES FLOW.
 *
 * It used to be a step in the first-run wizard. That is the worst moment for
 * it: somebody is three screens into getting started, has not seen the app do
 * anything, and is being asked to judge a thing they have no feel for. By the
 * third day the question is about something real.
 *
 * ── WHAT THIS IS CAREFUL ABOUT ──────────────────────────────────────────────
 *
 * BOTH ANSWERS ARE BUTTONS, weighted the same. There is no pre-ticked box and
 * no styled-up "yes" beside a grey "no" — a consent obtained by making one
 * answer easier is not worth having, and this is a dialog people should be able
 * to say no to in one click.
 *
 * DISMISS IS NOT AN ANSWER. Escape and the backdrop close it and leave consent
 * unanswered, which means nothing is collected. It returns on a later day of
 * use, at most twice more, and then never.
 *
 * THE COPY IS DERIVED, not written here — `telemetry-disclosure.ts` builds it
 * from the allowlist, so a field cannot be collected without appearing on this
 * screen. That is the same guarantee the Settings panel gets, from the same
 * source, which is why the two cannot drift into describing one promise two
 * ways.
 */
import {
  CONSENT_BODY,
  CONSENT_NO,
  CONSENT_QUESTION,
  CONSENT_YES,
  NEVER_SENT,
  disclosureLines,
} from '../../shared/telemetry-disclosure'
import { markModalOverlay } from '../modal-overlay'

export interface ConsentPromptDeps {
  /** Persist the answer. */
  setConsent: (agreed: boolean) => Promise<unknown>
  /** Record that the question was RAISED — answered or not. */
  recordAsk: () => Promise<unknown>
}

/**
 * Show it. Resolves when the dialog closes, with the answer or null if
 * dismissed.
 */
let stylesInjected = false
function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  // NO BACKTICKS BELOW — this is a template literal, and one inside it ends the
  // literal with a TS1005 that points at the wrong line.
  style.textContent = `
    .fl-consent-overlay {
      position: fixed;
      inset: 0;
      z-index: 9000;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.45);
      padding: var(--fl-space-lg);
    }
    .fl-consent-card {
      background: var(--fl-color-bg-elevated, var(--fl-color-bg));
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-lg, 10px);
      padding: var(--fl-space-lg);
      max-width: 34rem;
      width: 100%;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
      outline: none;
    }
    .fl-consent-title { margin: 0 0 var(--fl-space-sm); font-size: 1.05rem; }
    .fl-consent-body {
      margin: 0 0 var(--fl-space-md);
      color: var(--fl-color-text-secondary);
      line-height: 1.5;
    }
    /* What is sent, ruled off so it reads as the substance behind the question
       rather than more prose. */
    .fl-consent-detail {
      border-left: var(--fl-border-width) solid var(--fl-color-border);
      padding-left: var(--fl-space-md);
      margin-bottom: var(--fl-space-lg);
      font-size: var(--fl-text-caption-size);
      color: var(--fl-color-text-secondary);
    }
    .fl-consent-label {
      color: var(--fl-color-text-primary);
      font-weight: var(--fl-text-ui-weight-medium);
      margin-top: var(--fl-space-sm);
    }
    .fl-consent-line { margin-top: 2px; }
    .fl-consent-never { margin: var(--fl-space-xs) 0 0; padding-left: 1.1em; }
    .fl-consent-never li { margin-bottom: 2px; }
    /* EQUAL WEIGHT: both answers are the same kind of control, side by side. */
    .fl-consent-actions {
      display: flex;
      gap: var(--fl-space-sm);
      justify-content: flex-end;
    }
    .fl-consent-later {
      display: block;
      margin: var(--fl-space-sm) 0 0 auto;
      background: none;
      border: none;
      padding: 4px;
      cursor: pointer;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      text-decoration: underline;
    }
  `
  document.head.appendChild(style)
}

export function showConsentPrompt(deps: ConsentPromptDeps): Promise<boolean | null> {
  injectStyles()
  return new Promise((resolve) => {
    // RECORDED THE MOMENT IT IS RAISED, not when it is answered. A prompt that
    // only counted answered ones would return every launch for somebody who
    // keeps closing it — which is the nagging this is designed not to do.
    void deps.recordAsk().catch(() => undefined)

    const overlay = document.createElement('div')
    overlay.className = 'fl-consent-overlay'
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    overlay.setAttribute('aria-label', CONSENT_QUESTION)
    // REGISTERED AS A MODAL, not merely labelled as one. `aria-modal` tells a
    // screen reader; this tells the APP — hotkeys go inert, the terminal stops
    // stealing focus, and Tab is contained. A repo guard caught this missing,
    // which is exactly what that guard is for.
    markModalOverlay(overlay)

    const card = document.createElement('div')
    card.className = 'fl-consent-card'

    const heading = document.createElement('h2')
    heading.className = 'fl-consent-title'
    heading.textContent = CONSENT_QUESTION
    card.appendChild(heading)

    const body = document.createElement('p')
    body.className = 'fl-consent-body'
    body.textContent = CONSENT_BODY
    card.appendChild(body)

    // WHAT IS ACTUALLY SENT, on the screen where the decision is made.
    const detail = document.createElement('div')
    detail.className = 'fl-consent-detail'
    for (const line of disclosureLines()) {
      const label = document.createElement('div')
      label.className = 'fl-consent-label'
      label.textContent = line.label
      const text = document.createElement('div')
      text.className = 'fl-consent-line'
      text.textContent = line.detail
      detail.append(label, text)
    }
    const neverLabel = document.createElement('div')
    neverLabel.className = 'fl-consent-label'
    neverLabel.textContent = 'Never sent, whatever you choose'
    const never = document.createElement('ul')
    never.className = 'fl-consent-never'
    for (const item of NEVER_SENT) {
      const li = document.createElement('li')
      li.textContent = item
      never.appendChild(li)
    }
    detail.append(neverLabel, never)
    card.appendChild(detail)

    let settled = false
    const close = (answer: boolean | null): void => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKey, true)
      overlay.remove()
      resolve(answer)
    }

    const answer = (agreed: boolean): void => {
      void deps.setConsent(agreed).catch(() => undefined)
      close(agreed)
    }

    const actions = document.createElement('div')
    actions.className = 'fl-consent-actions'
    // EQUAL WEIGHT. "Don't share" comes first and is the same kind of control,
    // so declining is not the harder thing to do.
    const no = document.createElement('fl-button')
    no.setAttribute('variant', 'ghost')
    no.textContent = CONSENT_NO
    no.addEventListener('click', () => answer(false))
    const yes = document.createElement('fl-button')
    yes.setAttribute('variant', 'ghost')
    yes.textContent = CONSENT_YES
    yes.addEventListener('click', () => answer(true))
    actions.append(no, yes)
    card.appendChild(actions)

    const later = document.createElement('button')
    later.type = 'button'
    later.className = 'fl-consent-later'
    later.textContent = 'Ask me later'
    later.addEventListener('click', () => close(null))
    card.appendChild(later)

    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault()
        close(null)
      }
    }
    document.addEventListener('keydown', onKey, true)
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(null)
    })

    overlay.appendChild(card)
    document.body.appendChild(overlay)
    // Focus the dialog, not a button — landing on "Share" would make the
    // agreeing answer the one a stray Enter picks.
    card.tabIndex = -1
    card.focus()
  })
}
