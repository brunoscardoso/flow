// THE TICKET'S CHROME — the DOM half.
//
// The board had three ticket surfaces and each had grown its own idea of what a
// ticket looks like: the task detail, the queue-item detail, and the remote
// card. They agreed on nothing — one bolded its title and one did not, one had
// a meta line and one had two, the sections were labelled in three ways, and
// none of them showed the facts a tracker prints first. The user, looking at
// two of them side by side: "the standard ticket is really bad as well, lets
// make a standard to all".
//
// So the chrome is built once, here, and every surface fills it. What it SAYS
// is decided in ticket-model.ts, which is DOM-free and therefore testable.

import type { TicketModel } from './ticket-model'

/** The pieces a caller fills in, once the chrome exists. */
export interface TicketFrame {
  /** The dialog itself. */
  element: HTMLElement
  /** The one region that scrolls — every section goes in here. */
  scroll: HTMLElement
  /** The fixed foot. Actions go here. */
  actions: HTMLElement
  /** Add a labelled section, and return its body to fill. */
  section(label: string): HTMLElement
}

/**
 * Build the ticket's chrome into `modal` and hand back the parts to fill.
 *
 * The modal is emptied first: every caller of this rebuilds on a change, and a
 * frame that appended would stack a second copy on the first.
 */
export function buildTicketFrame(modal: HTMLElement, model: TicketModel): TicketFrame {
  modal.textContent = ''
  modal.classList.add('fl-ticket')

  const head = document.createElement('div')
  head.className = 'fl-ticket-head'

  const title = document.createElement('h2')
  // TWO CLASS NAMES, ON PURPOSE. `fl-ticket-title` is what this file styles;
  // `fl-board-modal-title` is what "the title of an open modal" has been called
  // on this board since long before the ticket frame existed, and it is what
  // every keyboard/focus/scroll guard reaches for. Dropping it would have made
  // a rename look like four broken modals.
  title.className = 'fl-ticket-title fl-board-modal-title'
  title.textContent = model.title
  head.appendChild(title)

  if (model.subtitle.trim().length > 0) {
    // A LINK WHEN THERE IS SOMEWHERE TO GO, plain text otherwise — never a link
    // that goes nowhere, and never a bare key when the tracker has a page for
    // it.
    const sub =
      model.url === null ? document.createElement('span') : document.createElement('a')
    sub.className = 'fl-ticket-key'
    sub.textContent = model.subtitle
    if (sub instanceof HTMLAnchorElement && model.url !== null) {
      sub.href = model.url
      sub.target = '_blank'
      sub.rel = 'noreferrer'
    }
    head.appendChild(sub)
  }

  if (model.facts.length > 0) {
    const facts = document.createElement('dl')
    facts.className = 'fl-ticket-facts'
    for (const fact of model.facts) {
      const label = document.createElement('dt')
      label.textContent = fact.label
      const value = document.createElement('dd')
      value.textContent = fact.value
      facts.append(label, value)
    }
    head.appendChild(facts)
  }
  modal.appendChild(head)

  const scroll = document.createElement('div')
  // The board's long-standing name for "the one region of an open ticket that
  // moves" rides along, for the same reason the title keeps two — see above.
  scroll.className = 'fl-ticket-scroll fl-board-detail-scroll'
  modal.appendChild(scroll)

  const actions = document.createElement('div')
  actions.className = 'fl-board-modal-actions fl-ticket-actions'
  modal.appendChild(actions)

  return {
    element: modal,
    scroll,
    actions,
    section(label: string): HTMLElement {
      // THE OLD NAMES RIDE ALONG, as on the title and the scroller above. A
      // section and its label have been `fl-board-detail-section` /
      // `-label` since long before this frame existed, and that is what the
      // board's guards reach for. A rename that leaves them behind does not
      // read as a rename — it reads as the section having disappeared.
      const section = document.createElement('section')
      section.className = 'fl-ticket-section fl-board-detail-section'
      const heading = document.createElement('div')
      heading.className = 'fl-ticket-label fl-board-detail-label'
      heading.textContent = label
      const body = document.createElement('div')
      body.className = 'fl-ticket-body'
      section.append(heading, body)
      scroll.appendChild(section)
      return body
    },
  }
}

/**
 * The ticket's styles.
 *
 * NO BACKTICKS ANYWHERE IN HERE, comments included — this is a template literal
 * and one ends it, with a TypeScript error pointing somewhere else entirely.
 */
export const TICKET_STYLES = `
  /* A FIXED SIZE. A dialog that grows to its content jumps between one ticket
     and the next, and a one-line ticket that opens as a sliver reads as a
     failure rather than as a short ticket. */
  .fl-ticket {
    width: min(780px, 92vw); max-width: 92vw;
    height: min(720px, 86vh);
    padding: 0; gap: 0; overflow: hidden;
  }
  .fl-ticket-head {
    flex: none; display: flex; flex-direction: column; gap: 6px;
    padding: var(--fl-space-lg) var(--fl-space-lg) var(--fl-space-md);
    border-bottom: var(--fl-border-width) solid var(--fl-color-separator);
  }
  /* THE TITLE READS AS ONE. It was body text at medium weight, which on a
     ticket whose title is its whole subject read as the first sentence. */
  /* Scoped to .fl-ticket so it beats the board's generic .fl-board-modal-title
     rule, which the element also carries — by specificity, never by which
     stylesheet happens to be injected second. */
  .fl-ticket .fl-ticket-title {
    margin: 0;
    font-size: 17px; line-height: 1.3;
    font-weight: 600; color: var(--fl-color-text);
    overflow-wrap: anywhere;
  }
  .fl-ticket-key {
    font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary);
    text-decoration: none; width: fit-content;
  }
  a.fl-ticket-key:hover { color: var(--fl-color-accent); text-decoration: underline; }
  /* The facts, as a wrapping label/value run rather than a column: they are
     short, there are at most five, and a stacked list of them would push the
     description below the fold on every ticket. */
  .fl-ticket-facts {
    display: flex; flex-wrap: wrap; align-items: baseline;
    gap: 2px var(--fl-space-md); margin: 4px 0 0;
    font-size: var(--fl-text-caption-size);
  }
  .fl-ticket-facts dt {
    color: var(--fl-color-text-secondary); text-transform: uppercase;
    letter-spacing: 0.04em; margin-right: 5px;
  }
  .fl-ticket-facts dd { margin: 0 var(--fl-space-sm) 0 0; color: var(--fl-color-text); }
  /* The one region that moves. */
  .fl-ticket-scroll {
    flex: 1; min-height: 0; overflow-y: auto;
    /* THE SECTIONS ARE FAR APART ON PURPOSE. The user asked for "space between
       the sections" AND, on an earlier pass, for the black hairlines to go —
       so the separation is all air. 24px is enough that a label reads as the
       start of something rather than as a caption on what is above it. */
    display: flex; flex-direction: column; gap: var(--fl-space-xl);
    padding: var(--fl-space-lg);
  }
  .fl-ticket-actions {
    flex: none; padding: var(--fl-space-md) var(--fl-space-lg);
    border-top: var(--fl-border-width) solid var(--fl-color-separator);
  }
  .fl-ticket-section { display: flex; flex-direction: column; gap: var(--fl-space-sm); }
  .fl-ticket-label {
    font-size: var(--fl-text-caption-size); font-weight: var(--fl-text-ui-weight-medium);
    text-transform: uppercase; letter-spacing: 0.06em; color: var(--fl-color-text-secondary);
  }
  .fl-ticket-body { font-size: var(--fl-text-ui-size); color: var(--fl-color-text); line-height: 1.55; }

  /* ── The body's typography ────────────────────────────────────────────
     The markdown renderer gives the elements; what a ticket needs on top is
     room between blocks, headings that look like headings, a table that reads
     as a table, and a URL that wraps instead of pushing the dialog wider. */
  .fl-ticket-body .fl-md > * + * { margin-top: var(--fl-space-md); }
  .fl-ticket-body .fl-md > :first-child { margin-top: 0; }
  /* A HEADING NEEDS AIR ABOVE IT AND A GAP BELOW. The renderer's own rule sets
     both to a small value; on a ticket whose whole structure IS its headings,
     that put "Background" hard against the paragraph it introduces. */
  .fl-ticket-body .fl-md h1,
  .fl-ticket-body .fl-md h2,
  .fl-ticket-body .fl-md h3,
  .fl-ticket-body .fl-md h4,
  .fl-ticket-body .fl-md h5,
  .fl-ticket-body .fl-md h6 {
    margin: var(--fl-space-lg) 0 var(--fl-space-sm);
    font-size: 14px; font-weight: 600; line-height: 1.35;
    color: var(--fl-color-text);
  }
  .fl-ticket-body .fl-md ul,
  .fl-ticket-body .fl-md ol { padding-left: 1.35em; margin: 0; }
  .fl-ticket-body .fl-md li + li { margin-top: 5px; }
  .fl-ticket-body .fl-md p { margin: 0; }
  .fl-ticket-body .fl-md > p + p { margin-top: var(--fl-space-md); }
  .fl-ticket-body .fl-md a { color: var(--fl-color-accent); overflow-wrap: anywhere; }
  .fl-ticket-body .fl-md strong { font-weight: 600; color: var(--fl-color-text); }
  .fl-ticket-body .fl-md blockquote {
    margin: 0; padding: 2px 0 2px var(--fl-space-md);
    border-left: 2px solid var(--fl-color-border); color: var(--fl-color-text-secondary);
  }
  /* A wide table scrolls INSIDE ITS OWN BOX rather than making the ticket
     scroll sideways — the rule the rest of the app follows for wide content. */
  .fl-ticket-body .fl-md table {
    display: block; overflow-x: auto; border-collapse: collapse;
    font-size: var(--fl-text-caption-size);
  }
  .fl-ticket-body .fl-md th,
  .fl-ticket-body .fl-md td {
    border: var(--fl-border-width) solid var(--fl-color-border);
    padding: 5px var(--fl-space-sm); text-align: left; vertical-align: top;
  }
  .fl-ticket-body .fl-md th {
    background: var(--fl-color-surface); color: var(--fl-color-text-secondary);
    font-weight: var(--fl-text-ui-weight-medium); white-space: nowrap;
  }
`
