import { summaryRows, summaryValue } from './settings-summary'
import { FLOW_SETTINGS_SECTIONS, type FieldDef } from '../settings/flow-settings-model'

// #1207: the step claimed "Flow configured your project with these settings"
// and then listed labels + help text — identical for every project and every
// choice, including the autopilot the user had picked one step earlier.

const toggle: FieldDef = { key: 'autopilot', label: 'Autopilot', type: 'toggle' }
const branch: FieldDef = {
  key: 'branch',
  label: 'Target branch',
  type: 'text',
  help: 'Blank = current branch',
}
const retries: FieldDef = { key: 'max_verify_retries', label: 'Max verify retries', type: 'number', default: 2 }
// A choice that carries a name: three options, one of which is only half an
// answer until it is given one. No shipped field is a select any more, but the
// summary must keep rendering the shape correctly if one comes back.
const start: FieldDef = {
  key: 'a_choice',
  label: 'A choice that carries a name',
  type: 'select',
  options: [
    { value: 'here', label: 'Where the project is now' },
    { value: 'trunk', label: 'The default branch, brought up to date' },
    { value: 'branch', label: 'A branch I name', companion: { placeholder: 'branch name' } },
  ],
}

describe('summaryValue (#1207)', () => {
  it('reports a toggle as On/Off — the summary must differ between two projects', () => {
    expect(summaryValue(toggle, { autopilot: true })).toBe('On')
    expect(summaryValue(toggle, { autopilot: false })).toBe('Off')
  })

  it('reports a text value, and says what BLANK means rather than showing nothing', () => {
    expect(summaryValue(branch, { branch: 'release/next' })).toBe('release/next')
    expect(summaryValue(branch, { branch: '' })).toBe('Blank = current branch')
    expect(summaryValue(branch, {})).toBe('Blank = current branch')
  })

  it('falls back to a text field’s "Not set" when it has no blank-hint', () => {
    expect(summaryValue({ key: 'x', label: 'X', type: 'text' }, {})).toBe('Not set')
  })

  it('reports a number, falling back to its default when unset', () => {
    expect(summaryValue(retries, { max_verify_retries: 5 })).toBe('5')
    expect(summaryValue(retries, {})).toBe('2')
  })

  it('reports a choice by its LABEL, never the token it is stored under', () => {
    // The bug: the summary printed `here` / `trunk` — the config file's own
    // grammar — in a report written for someone who never typed it.
    expect(summaryValue(start, { a_choice: 'here' })).toBe('Where the project is now')
    expect(summaryValue(start, { a_choice: 'trunk' })).toBe(
      'The default branch, brought up to date',
    )
  })

  it('prints the name a choice carries beside it', () => {
    expect(summaryValue(start, { a_choice: 'branch:develop' })).toBe(
      'A branch I name: develop',
    )
  })

  it('reads an unset or unrecognised choice as the first option, never as blank', () => {
    // Both are the built-in behaviour, and the summary has to say what WILL
    // happen rather than leave the row empty.
    expect(summaryValue(start, {})).toBe('Where the project is now')
    expect(summaryValue(start, { a_choice: 'nonsense' })).toBe('Where the project is now')
  })

  it('says "Not set" for a choice with no options at all', () => {
    expect(summaryValue({ key: 'x', label: 'X', type: 'select' }, { x: 'y' })).toBe('Not set')
  })
})

describe('summaryRows (#1207)', () => {
  it('pairs every field with its value, in order', () => {
    expect(summaryRows([toggle, branch], { autopilot: true, branch: 'main' })).toEqual([
      { label: 'Autopilot', value: 'On' },
      { label: 'Target branch', value: 'main' },
    ])
  })

  it('pairs a choice row with its label, like every other row', () => {
    expect(summaryRows([start], { a_choice: 'branch:release' })).toEqual([
      { label: 'A choice that carries a name', value: 'A branch I name: release' },
    ])
  })

  it('produces DIFFERENT output for an autopilot-on and an autopilot-off project', () => {
    // The exact thing the old summary could not do.
    expect(summaryRows([toggle], { autopilot: true })).not.toEqual(
      summaryRows([toggle], { autopilot: false }),
    )
  })
})

describe('the summary step', () => {
  it('every other section still reports a row per field', () => {
    const withFields = FLOW_SETTINGS_SECTIONS.filter((section) => section.fields.length > 0)
    expect(withFields.length).toBeGreaterThan(0)
    for (const section of withFields) {
      expect(summaryRows(section.fields, {})).toHaveLength(section.fields.length)
    }
  })
})
