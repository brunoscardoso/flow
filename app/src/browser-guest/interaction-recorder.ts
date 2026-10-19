/**
 * RECORDING WHAT THE PERSON DID, inside the page being debugged.
 *
 * Runs in the guest (DOM code, `tsconfig.guest.json`), beside the inspect
 * bridge but deliberately NOT part of it:
 *
 *   the picker   is a MODE. A person enters it to choose one element, and it
 *                swallows the page's own clicks to do that.
 *   recording    is PASSIVE. It runs for a whole session and must change
 *                nothing — a reproduction that behaves differently because it
 *                is being recorded is not a reproduction.
 *
 * So every listener here is a non-capturing, passive one that never calls
 * `preventDefault` or `stopPropagation`, and the page cannot tell it is there.
 *
 * WHAT IS NOT RECORDED: typed input, of any kind. There is no `input` or
 * `change` listener, and `BrowserInteractionEvent` has no field a value could
 * arrive in. That was the decision taken in discovery — it is the highest
 * chance of recording a password or somebody's customer data — and it is
 * enforced by there being nothing here that could.
 */
import { interactionIdentity, type InteractionSubject } from '../shared/interaction-identity'
import type { BrowserInteractionEvent } from '../shared/browser-inspect-channels'

export interface InteractionRecorder {
  start(): void
  stop(): void
  readonly recording: boolean
}

/** Longest control label kept — a label, never a paragraph of content. */
const MAX_CONTROL_TEXT = 60

/**
 * Elements whose own text IS their label rather than the user's data.
 *
 * A button says "Save template"; a table cell says whatever the customer is
 * called. The first is UI chrome an author wrote and a screen reader announces;
 * the second is the data this recorder exists to stay out of. The list is
 * deliberately short and additions should be argued for.
 */
const LABELLED_CONTROLS = new Set(['BUTTON', 'A', 'SUMMARY', 'LABEL', 'OPTION', 'LEGEND'])

function controlTextOf(el: Element): string | null {
  const role = el.getAttribute('role')
  const isControl = LABELLED_CONTROLS.has(el.tagName) || role === 'button' || role === 'link' || role === 'tab'
  if (!isControl) return null
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return null
  // A control whose label runs to a paragraph is not a label — it is content
  // that happens to be clickable, and reading it would be reading the page.
  return text.length > MAX_CONTROL_TEXT ? null : text
}

/** Read an element's AUTHORED attributes, plus a CONTROL's own label. */
function subjectOf(el: Element): InteractionSubject {
  const get = (name: string): string | null => el.getAttribute(name)
  return {
    tagName: el.tagName,
    role: get('role'),
    ariaLabel: get('aria-label'),
    title: get('title'),
    alt: get('alt'),
    name: get('name'),
    type: get('type'),
    id: el.id === '' ? null : el.id,
    testId: get('data-testid') ?? get('data-test-id') ?? get('data-test'),
    controlText: controlTextOf(el),
  }
}

/**
 * The element a click is ABOUT.
 *
 * A click lands on whatever is deepest under the pointer — often a `<span>`
 * inside the button, or an icon's `<svg>` — and "clicked span" tells a reader
 * nothing. This walks out to the nearest thing that behaves like a control,
 * which is what the person believes they clicked.
 */
function controlFor(start: Element): Element {
  const CONTROLS = 'button, a, input, select, textarea, [role], [onclick], label, summary'
  return start.closest(CONTROLS) ?? start
}

export function createInteractionRecorder(
  emit: (event: BrowserInteractionEvent) => void,
): InteractionRecorder {
  let on = false

  const onClick = (event: Event): void => {
    if (!on) return
    const target = event.target
    if (!(target instanceof Element)) return
    emit({
      kind: 'click',
      at: Date.now(),
      target: interactionIdentity(subjectOf(controlFor(target))),
    })
  }

  // A page load is the frame the clicks sit in, and it is also the thing the
  // browser's network capture routinely misses (the debugger attaches after the
  // guest's first requests — see e2e/ux/browser-capture-clock.spec.ts). Saying
  // when it happened is the least the artifact can do about that.
  const onLoad = (): void => {
    if (!on) return
    emit({ kind: 'load', at: Date.now(), target: 'page', url: location.href })
  }

  const onNavigate = (): void => {
    if (!on) return
    emit({ kind: 'navigate', at: Date.now(), target: 'page', url: location.href })
  }

  return {
    get recording() {
      return on
    },
    start() {
      if (on) return
      on = true
      // PASSIVE AND NON-CAPTURING, so the page behaves exactly as it would with
      // nobody watching. `passive: true` also tells the browser this listener
      // will never preventDefault, so scrolling and touch stay smooth.
      document.addEventListener('click', onClick, { capture: false, passive: true })
      window.addEventListener('load', onLoad, { passive: true })
      window.addEventListener('popstate', onNavigate, { passive: true })
      window.addEventListener('hashchange', onNavigate, { passive: true })
    },
    stop() {
      if (!on) return
      on = false
      document.removeEventListener('click', onClick, { capture: false })
      window.removeEventListener('load', onLoad)
      window.removeEventListener('popstate', onNavigate)
      window.removeEventListener('hashchange', onNavigate)
    },
  }
}
