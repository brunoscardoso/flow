/**
 * "Your project settings" — the wizard's closing summary (#1207).
 *
 * The step claimed "Flow configured your project with these settings" and then
 * listed field LABELS and help text: no values, identical for every project and
 * every choice the user had just made. It was a brochure describing the
 * settings screen, not a report about this project — including for `autopilot`,
 * the setting the user had chosen one step earlier.
 *
 * Pure so the formatting is unit-testable; steps.ts renders the rows.
 */
import {
  splitSelectValue,
  type FieldDef,
  type FlowSettingsValues,
} from '../settings/flow-settings-model'

export interface SummaryRow {
  label: string
  /** The value as the user should read it — never a raw flowconfig string. */
  value: string
}

/** How one field's effective value reads in the summary. */
export function summaryValue(field: FieldDef, values: FlowSettingsValues): string {
  const raw = values[field.key]
  if (field.type === 'toggle') return raw === true ? 'On' : 'Off'
  if (field.type === 'number') {
    return typeof raw === 'number' ? String(raw) : String(field.default ?? '—')
  }
  // A CHOICE READS AS THE CHOICE, not as the token it is stored under. Without
  // this the closing summary printed `here` and `branch:dev` — the file's
  // grammar, shown to a person who never typed it and cannot look it up
  // (forbidden-pattern #12) — for a setting whose options are already written
  // in words two steps earlier. A choice that carries a name prints both,
  // because half of it ("A branch I name") is not an answer.
  if (field.type === 'select') {
    const { option, companion } = splitSelectValue(field, typeof raw === 'string' ? raw : '')
    const chosen = (field.options ?? []).find((candidate) => candidate.value === option)
    if (chosen === undefined) return 'Not set'
    return companion === '' ? chosen.label : `${chosen.label}: ${companion}`
  }
  const text = typeof raw === 'string' ? raw.trim() : ''
  // A blank text field is not "empty", it means something — say what.
  if (text.length === 0) return field.help && /blank/i.test(field.help) ? field.help : 'Not set'
  return text
}

export function summaryRows(fields: readonly FieldDef[], values: FlowSettingsValues): SummaryRow[] {
  return fields.map((field) => ({ label: field.label, value: summaryValue(field, values) }))
}
