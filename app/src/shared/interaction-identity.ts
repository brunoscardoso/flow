/**
 * NAMING WHAT SOMEBODY CLICKED, WITHOUT RECORDING WHAT IT SAID.
 *
 * A debug session records interactions so its artifact can say what the person
 * DID, not only what the app did — "clicked Save, then the server printed a 500"
 * is the sentence the whole feature exists to make possible.
 *
 * THE LINE THIS DRAWS, AND WHY IT IS HERE AND NOT IN THE GUEST. A page under
 * debug is a real application holding real data: a table of customers, an
 * invoice, somebody's medical record. An element's TEXT is therefore the last
 * thing to record, and it is exactly what the obvious implementation reaches
 * for (`el.textContent`) because it makes the nicest labels.
 *
 * So identity comes from what the element IS — its tag, its role, its
 * accessible NAME where an author wrote one — and never from what it contains.
 * `aria-label`, `title` and `alt` are authored strings, written to be read by
 * anyone who opens the page with a screen reader; a cell's text is the user's
 * data. That is the distinction, and it is the whole of the rule.
 *
 * Pure, DOM-free, and shared so the guest and the tests agree on one answer.
 */

/** The element facts an identity can be built from — all authored, none data. */
export interface InteractionSubject {
  tagName: string
  /** `role`, when the author set one. */
  role?: string | null
  /** `aria-label`, when the author wrote one. */
  ariaLabel?: string | null
  /** `title`, when the author wrote one. */
  title?: string | null
  /** `alt`, for images. */
  alt?: string | null
  /** `name`, for form controls — the FIELD's name, never its value. */
  name?: string | null
  /** `type`, for inputs and buttons. */
  type?: string | null
  /** `id`, when the author set one. */
  id?: string | null
  /** `data-testid` and friends: written for machines, safe by construction. */
  testId?: string | null
  /**
   * A CONTROL's own label — and only a control's.
   *
   * The rule above (never read text) was drawn one notch too tight: it made
   * every artifact say "clicked button #go" where a reader needed "clicked Save
   * template", which is the difference between a record you can follow and one
   * you cannot (user, 2026-09-21).
   *
   * A button's text IS its accessible name — the thing a screen reader announces
   * and the thing the person believes they pressed. It is authored UI chrome,
   * like `aria-label` written a different way. A table cell's text is the user's
   * data and is still never read: the CALLER decides what qualifies (see
   * `interaction-recorder.ts`), and only passes this for elements that behave
   * like controls.
   */
  controlText?: string | null
}

/** Longest an identity may be — a label, not a paragraph. */
const MAX_IDENTITY = 80

/**
 * A short, readable name for what was interacted with.
 *
 * ORDERED BY HOW DELIBERATELY AUTHORED EACH SOURCE IS. A `data-testid` exists
 * to name this element for a machine; an `aria-label` to name it for a person
 * who cannot see it; a `title` or `alt` to describe it. Each was written to be
 * read out of context, which is exactly what this does with it.
 *
 * Falls back to the tag and its type, which name a KIND of control and can
 * carry nothing private at all.
 */
export function interactionIdentity(subject: InteractionSubject): string {
  const tag = (subject.tagName || 'element').toLowerCase()
  const authored = firstAuthored([
    subject.testId,
    subject.ariaLabel,
    subject.title,
    subject.alt,
    // A control's visible label comes BEFORE its form name: "Save template" is
    // what the person pressed; `templateName` is what the field is called.
    subject.controlText,
    subject.name,
  ])
  const role = clean(subject.role)
  const kind = role !== null && role !== '' ? role : tag
  if (authored !== null) return bound(`${kind} ${authored}`)
  const type = clean(subject.type)
  // An id is authored, but it is also frequently generated (`:r3:`, a uuid), so
  // it is the last resort and only when it reads like a name somebody chose.
  const id = clean(subject.id)
  if (type !== null && type !== '') return bound(`${kind} ${type}`)
  if (id !== null && looksAuthored(id)) return bound(`${kind} #${id}`)
  return bound(kind)
}

/** The first of these somebody actually wrote, or null. */
function firstAuthored(values: (string | null | undefined)[]): string | null {
  for (const value of values) {
    const cleaned = clean(value)
    if (cleaned !== null && cleaned !== '') return cleaned
  }
  return null
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Whether an id reads like a name a person chose rather than one a framework
 * generated. React's `useId` produces `:r0:`, and uuids and long hex strings
 * are machine-made — none of them tells a reader anything.
 */
function looksAuthored(id: string): boolean {
  if (id.length > 40) return false
  if (/^[:\d]/.test(id)) return false
  if (/^[0-9a-f-]{16,}$/i.test(id)) return false
  return /[a-z]/i.test(id)
}

function bound(text: string): string {
  return text.length <= MAX_IDENTITY ? text : `${text.slice(0, MAX_IDENTITY - 1)}…`
}
