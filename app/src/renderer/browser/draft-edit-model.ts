/**
 * THE DRAFT EDIT PANEL'S MODEL — DOM-free, so every decision the panel makes
 * is tested apart from the browser tab.
 *
 *   - what kind of element was picked ("Button") and which fields it gets;
 *   - the values the fields start from, read off the pick's computed styles;
 *   - turning what a person typed into a `DraftEdit`, validated by the same
 *     `validateDraftEdit` main applies, so a value main would refuse is refused
 *     here first, with a sentence;
 *   - the status line ("Saved", or main's refusal, word for word);
 *   - the chip label for "Ask the agent": `Payment · "Pay $27" button`.
 *
 * Every edit addresses the element by its stamped id — never a selector.
 */
import type { BrowserDraftElement } from '../../shared/browser-capture-types'
import type { DraftElementFacts } from '../../shared/draft-pick'
import {
  validateDraftEdit,
  type DraftColourProperty,
  type DraftEdit,
  type DraftSpacingProperty,
  type DraftWriteAnswer,
} from '../../shared/ui-drafts'

export type DraftEditResult = { ok: true; edit: DraftEdit } | { ok: false; reason: string }

/** The four sides, in the order the fields show them. */
export const DRAFT_SIDES = ['top', 'right', 'bottom', 'left'] as const
export type DraftSide = (typeof DRAFT_SIDES)[number]

/** The colour rows of the panel, in order. */
export const DRAFT_COLOUR_FIELDS: ReadonlyArray<{ property: DraftColourProperty; label: string }> = [
  { property: 'background-color', label: 'Background' },
  { property: 'color', label: 'Text colour' },
  { property: 'border-color', label: 'Border' },
]

const ROLE_KINDS: Record<string, string> = {
  button: 'Button',
  link: 'Link',
  heading: 'Heading',
  img: 'Image',
  textbox: 'Field',
  checkbox: 'Checkbox',
  tab: 'Tab',
  listitem: 'List item',
}

const TAG_KINDS: Record<string, string> = {
  button: 'Button',
  a: 'Link',
  h1: 'Heading',
  h2: 'Heading',
  h3: 'Heading',
  h4: 'Heading',
  h5: 'Heading',
  h6: 'Heading',
  p: 'Text',
  span: 'Text',
  label: 'Label',
  strong: 'Text',
  em: 'Text',
  small: 'Text',
  img: 'Image',
  svg: 'Icon',
  input: 'Field',
  textarea: 'Field',
  select: 'Field',
  ul: 'List',
  ol: 'List',
  li: 'List item',
  nav: 'Navigation',
  header: 'Header',
  footer: 'Footer',
  form: 'Form',
  section: 'Section',
  main: 'Section',
  article: 'Section',
  aside: 'Section',
  div: 'Box',
  body: 'Screen',
}

/** What the picked element is, for a person: its role, else its tag ("Button"). */
export function draftKindLabel(facts: Pick<DraftElementFacts, 'role' | 'tag'>): string {
  const role = facts.role.trim().toLowerCase()
  if (role.length > 0) return ROLE_KINDS[role] ?? role.charAt(0).toUpperCase() + role.slice(1)
  return TAG_KINDS[facts.tag] ?? facts.tag.charAt(0).toUpperCase() + facts.tag.slice(1)
}

/** Which fields the panel shows for an element. */
export interface DraftPanelFields {
  /** Text, only when a text edit can change it in place. */
  text: boolean
  colours: ReadonlyArray<{ property: DraftColourProperty; label: string }>
  padding: true
  margin: true
}

export function draftPanelFields(facts: Pick<DraftElementFacts, 'textEditable'>): DraftPanelFields {
  return { text: facts.textEditable, colours: DRAFT_COLOUR_FIELDS, padding: true, margin: true }
}

function hexByte(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
}

/**
 * A computed colour as `#rrggbb`, for a colour field — or '' when it has none
 * to show (transparent, or a value that is not rgb/hex).
 */
export function hexOfColour(computed: string | undefined): string {
  if (computed === undefined) return ''
  const value = computed.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value)
  if (hex !== null) {
    const digits = hex[1]
    return digits.length === 3 ? `#${digits.split('').map((d) => d + d).join('')}` : `#${digits}`
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(value)
  if (rgb === null) return ''
  if (rgb[4] !== undefined) {
    const alpha = rgb[4].endsWith('%') ? Number(rgb[4].slice(0, -1)) / 100 : Number(rgb[4])
    if (alpha === 0) return ''
  }
  return `#${hexByte(Number(rgb[1]))}${hexByte(Number(rgb[2]))}${hexByte(Number(rgb[3]))}`
}

/** A computed length in px as the number a spacing field shows ('12px' → '12'), else ''. */
export function pxNumber(computed: string | undefined): string {
  if (computed === undefined) return ''
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(computed.trim())
  if (match === null) return ''
  const rounded = Math.round(Number(match[1]) * 100) / 100
  return String(rounded)
}

/** The values the panel's fields start from. */
export interface DraftPanelSeed {
  text: string
  colours: Record<DraftColourProperty, string>
  padding: Record<DraftSide, string>
  margin: Record<DraftSide, string>
}

export function draftPanelSeed(facts: DraftElementFacts): DraftPanelSeed {
  const sides = (box: 'padding' | 'margin'): Record<DraftSide, string> => ({
    top: pxNumber(facts.styles[`${box}-top`]),
    right: pxNumber(facts.styles[`${box}-right`]),
    bottom: pxNumber(facts.styles[`${box}-bottom`]),
    left: pxNumber(facts.styles[`${box}-left`]),
  })
  return {
    text: facts.text,
    colours: {
      'background-color': hexOfColour(facts.styles['background-color']),
      color: hexOfColour(facts.styles.color),
      'border-color': hexOfColour(facts.styles['border-color']),
    },
    padding: sides('padding'),
    margin: sides('margin'),
  }
}

/** A text edit of the element. */
export function draftTextEdit(id: string, text: string): DraftEditResult {
  return validateDraftEdit({ id, kind: 'text', text })
}

/**
 * A colour edit from a colour picker or a hex field. A bare `2b6cff` or `fff`
 * gets its `#`; anything else must be a colour Flow can write.
 */
export function draftColourEdit(id: string, property: DraftColourProperty, input: string): DraftEditResult {
  const raw = input.trim()
  if (raw.length === 0) return { ok: false, reason: 'Type a colour, such as #2b6cff.' }
  const value = /^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw) ? `#${raw}` : raw
  return validateDraftEdit({ id, kind: 'colour', property, value })
}

/**
 * A spacing edit from one side's number field. A plain number is pixels
 * (`12` → `12px`); `px`, `rem` and `0` are accepted as typed.
 */
export function draftSpacingEdit(
  id: string,
  box: 'padding' | 'margin',
  side: DraftSide,
  input: string,
): DraftEditResult {
  const raw = input.trim()
  if (raw.length === 0) return { ok: false, reason: 'Type a number of pixels, such as 12.' }
  const value = /^\d+(?:\.\d+)?$/.test(raw) && raw !== '0' ? `${raw}px` : raw
  const property = `${box}-${side}` as DraftSpacingProperty
  return validateDraftEdit({ id, kind: 'spacing', property, value })
}

/** The status line after a change: "Saved", or the reason it was not, word for word. */
export function draftStatusText(answer: DraftWriteAnswer): string {
  return answer.ok ? 'Saved' : answer.reason
}

const LABEL_NAME_MAX = 32

/** The chip label for "Ask the agent": `Payment · "Pay $27" button`. */
export function draftChipLabel(screenTitle: string, facts: Pick<DraftElementFacts, 'name' | 'role' | 'tag'>): string {
  const kind = draftKindLabel(facts).toLowerCase()
  const name = facts.name.trim()
  const short = name.length > LABEL_NAME_MAX ? `${name.slice(0, LABEL_NAME_MAX - 1)}…` : name
  return short.length > 0 ? `${screenTitle} · "${short}" ${kind}` : `${screenTitle} · ${kind}`
}

/** The label of the screen's picture: "Picture of Payment". */
export function draftPictureLabel(screenTitle: string): string {
  return `Picture of ${screenTitle}`
}

/**
 * The chip's context text for the agent (note 8): the canvas, the screen file
 * and the element's stamped id in place of a selector, plus the DOM summary —
 * so the agent edits the right file and the right element.
 */
export function draftElementText(summary: string, draft: BrowserDraftElement): string {
  // The id leads: the composer's chip previews the first line.
  const lines: string[] = [`Element: data-flow-id="${draft.id}"`]
  const role = draft.role.length > 0 ? ` (role ${draft.role})` : ''
  lines.push(`A <${draft.tag}>${role} of a UI draft: a look-alike screen, not the app itself.`)
  if (draft.canvas !== undefined) lines.push(`Canvas: ${draft.canvas}`)
  const title = draft.screenTitle !== undefined ? `${draft.screenTitle} — ` : ''
  lines.push(`Screen: ${title}${draft.file ?? `${draft.screen}.html`}`)
  lines.push(`DOM: ${summary}`)
  lines.push('Change this element in the screen file, keeping its data-flow-id.')
  return lines.join('\n')
}
