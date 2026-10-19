// Carry in-progress text across a Settings body rebuild (#1000, #1032).
//
// The Settings overlay re-renders its whole body whenever it hears
// `accounts:changed` (any account-row action: set default, remove, re-login) and
// the flow-settings overlay writes on every edit. Those swaps used to destroy
// whatever the user was typing — a half-typed "Add account" name vanished with
// no warning. This is the same capture/restore contract the git panel uses for
// its commit box (#282/#1093): identify fields by a STABLE key, read value +
// selection before the swap, put them back after.
//
// Typed against MINIMAL STRUCTURAL interfaces (not lib.dom) so the module — and
// its tests — run under the app's node-env jest, the established idiom here
// (see project-accent.ts's MinimalDocument).

/** The attribute a field opts in with. Fields without it are never carried. */
export const CARRY_KEY_ATTR = 'data-carry-key'

/** The slice of a text input/textarea this helper touches. */
export interface CarryField {
  tagName: string
  type?: string
  value: string
  selectionStart: number | null
  selectionEnd: number | null
  getAttribute(name: string): string | null
  focus(): void
  setSelectionRange?(start: number, end: number): void
}

/** The slice of the host container + document this helper reads. */
export interface CarryHost {
  ownerDocument?: { activeElement: unknown } | null
  querySelectorAll(selector: string): Iterable<unknown>
  querySelector(selector: string): unknown
}

/** One field's carried state, keyed by its stable `data-carry-key`. */
export interface CarriedInput {
  key: string
  value: string
  selectionStart: number | null
  selectionEnd: number | null
  /** True when the field had focus at capture time — only then is focus restored. */
  focused: boolean
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'password', undefined, ''])

function asField(node: unknown): CarryField | null {
  const candidate = node as CarryField | null
  if (candidate === null || typeof candidate !== 'object') return null
  if (typeof candidate.getAttribute !== 'function' || typeof candidate.value !== 'string') return null
  if (candidate.tagName === 'TEXTAREA') return candidate
  if (candidate.tagName !== 'INPUT') return null
  return TEXT_INPUT_TYPES.has(candidate.type) ? candidate : null
}

/**
 * Snapshot every opted-in field that holds text (or focus) inside `host`. Empty,
 * unfocused fields are skipped — carrying them would be churn and could clobber
 * a fresh render's own default value.
 */
export function captureSettingsInput(host: CarryHost): CarriedInput[] {
  const active = host.ownerDocument?.activeElement ?? null
  const carried: CarriedInput[] = []
  for (const node of host.querySelectorAll(`[${CARRY_KEY_ATTR}]`)) {
    const field = asField(node)
    if (field === null) continue
    const key = field.getAttribute(CARRY_KEY_ATTR)
    if (key === null || key === '') continue
    const focused = node === active
    if (field.value === '' && !focused) continue
    carried.push({
      key,
      value: field.value,
      selectionStart: field.selectionStart,
      selectionEnd: field.selectionEnd,
      focused,
    })
  }
  return carried
}

/**
 * Put carried text back into the rebuilt DOM. Focus and caret are restored only
 * for the field that HAD focus, so a rebuild never steals focus the user moved
 * elsewhere (the ownership rule from #1045). Fields that no longer exist are
 * dropped silently — their section is simply gone.
 */
export function restoreSettingsInput(host: CarryHost, carried: readonly CarriedInput[]): void {
  for (const entry of carried) {
    const escaped = entry.key.replace(/["\\]/g, '\\$&')
    const field = asField(host.querySelector(`[${CARRY_KEY_ATTR}="${escaped}"]`))
    if (field === null) continue
    field.value = entry.value
    if (!entry.focused) continue
    field.focus()
    if (entry.selectionStart !== null && entry.selectionEnd !== null && field.setSelectionRange) {
      try {
        field.setSelectionRange(entry.selectionStart, entry.selectionEnd)
      } catch {
        // Some input types reject setSelectionRange — the value still carried.
      }
    }
  }
}
