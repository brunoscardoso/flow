// The shared builder both model pickers use (#1918). Pure — no DOM. The point
// of the module is that the composer and the new-thread page cannot drift into
// offering different lists (allowed-pattern #14), so this pins the merge/dedupe/
// label behaviour they both now depend on.

import { buildModelOptions } from './model-options'

describe('buildModelOptions (#1918)', () => {
  it('offers only the base aliases for Claude when there are no account ids', () => {
    expect(buildModelOptions('claude', [])).toEqual([
      { value: 'auto', label: 'Auto' },
      { value: 'fable', label: 'Fable' },
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'haiku', label: 'Haiku' },
    ])
  })

  it('surfaces a Copilot account\'s configured ids after the lone Auto base', () => {
    // The bug: Copilot's base list is only Auto, so a configured id can ONLY
    // reach the picker as an extra. Labelled from Copilot's own catalogue
    // (#1929) — `claude-sonnet-5` reads as "Claude Sonnet 5", `gpt-5-mini` as
    // "GPT-5 Mini" — where modelLabel would print a gpt id raw.
    expect(buildModelOptions('copilot', ['claude-sonnet-5', 'gpt-5-mini'])).toEqual([
      { value: 'auto', label: 'Auto' },
      { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { value: 'gpt-5-mini', label: 'GPT-5 Mini' },
    ])
  })

  it('labels an unknown Copilot id with modelLabel, not the catalogue', () => {
    // An id NOT in the catalogue falls through to modelLabel — a Claude family
    // id still reads nicely; a truly unknown one keeps its raw name.
    expect(buildModelOptions('copilot', ['claude-opus-4-8', 'mystery-9'])).toEqual([
      { value: 'auto', label: 'Auto' },
      { value: 'claude-opus-4-8', label: 'Opus 4.8' },
      { value: 'mystery-9', label: 'mystery-9' },
    ])
  })

  it('drops empties and de-dupes extras against the base and against each other', () => {
    // An extra that repeats a base alias (opus) or another extra, or is empty,
    // never produces a second option.
    expect(buildModelOptions('claude', ['opus', '', 'claude-opus-5', 'claude-opus-5'])).toEqual([
      { value: 'auto', label: 'Auto' },
      { value: 'fable', label: 'Fable' },
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'haiku', label: 'Haiku' },
      { value: 'claude-opus-5', label: 'Opus 5' },
    ])
  })

  it('defaults extraModels to none', () => {
    expect(buildModelOptions('copilot')).toEqual([{ value: 'auto', label: 'Auto' }])
  })
})

describe('the regression that shipped: every extra model was discarded (#1918)', () => {
  // `!taken.add(value)` read as a dedupe and behaved as a delete: `Set.add`
  // returns the Set, so the negation was always false. A Copilot account with
  // four models pinned in Settings got a picker with one entry.
  it('keeps every configured model, not just Auto', () => {
    const pinned = ['claude-sonnet-5', 'claude-sonnet-4.5', 'claude-haiku-4.5', 'gpt-5-mini']
    const options = buildModelOptions('copilot', pinned)

    expect(options).toHaveLength(pinned.length + 1)
    expect(options[0]).toEqual({ value: 'auto', label: 'Auto' })
    expect(options.map((option) => option.value)).toEqual(['auto', ...pinned])
  })

  // The composer hides the picker entirely at `options.length < 2`, so the bug
  // did not merely shorten the list — it removed the control.
  it('gives the picker something to be a picker about', () => {
    expect(buildModelOptions('copilot', ['claude-sonnet-5']).length).toBeGreaterThan(1)
  })

  it('still dedupes — the add is a side effect, not a test', () => {
    const options = buildModelOptions('copilot', ['gpt-5-mini', 'gpt-5-mini', 'auto', ''])
    expect(options.map((option) => option.value)).toEqual(['auto', 'gpt-5-mini'])
  })
})

describe('untested ids are offered, and said to be a guess', () => {
  // Copilot has no listing command, so `candidates` is a measured guess. Offering
  // them unmarked made the picker promise models an account may not own:
  // `Model "claude-sonnet-4.5" from --model flag is not available` (user, 2026-09-16).
  it('marks a candidate, and leaves a known model plain', () => {
    const options = buildModelOptions('copilot', ['claude-sonnet-5'], ['claude-sonnet-4.5'])

    expect(options.map((option) => option.value)).toEqual([
      'auto',
      'claude-sonnet-5',
      'claude-sonnet-4.5',
    ])
    // The suffix is the claim being made, not the name — `modelLabel` owns the
    // name, and asserting its exact wording here would couple these two.
    expect(options[1].label).not.toMatch(/untested/)
    expect(options[2].label).toMatch(/\(untested\)$/)
  })

  it('never offers the same id twice — a candidate the account already has stays plain', () => {
    const options = buildModelOptions('copilot', ['gpt-5-mini'], ['gpt-5-mini', 'claude-haiku-4.5'])

    expect(options.map((option) => option.value)).toEqual(['auto', 'gpt-5-mini', 'claude-haiku-4.5'])
    // Known wins over guessed: an id in both lists is not hedged.
    expect(options[1].label).not.toMatch(/untested/)
    expect(options[2].label).toMatch(/\(untested\)$/)
  })

  it('offers nothing extra when there are no candidates', () => {
    expect(buildModelOptions('copilot', ['claude-sonnet-5'])).toHaveLength(2)
  })
})
