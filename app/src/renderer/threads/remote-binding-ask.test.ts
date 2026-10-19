import { authoredStrings, remoteBindingQuestion } from './remote-binding-ask'
import type { ThreadBindingSuggestion } from '../../shared/ipc-contract'

function suggestion(
  overrides: Partial<ThreadBindingSuggestion> = {},
): ThreadBindingSuggestion {
  return {
    suggestion: 'feature/PF-42-push-from-review',
    source: 'ticket',
    remote: 'origin',
    remotes: ['origin'],
    base: 'main',
    ...overrides,
  }
}

const SOURCES: ThreadBindingSuggestion['source'][] = ['pattern', 'ticket', 'learned', 'local']

describe('remoteBindingQuestion — provenance in the project’s words', () => {
  it('says where every proposal came from, and says something different each time', () => {
    const lines = SOURCES.map((source) => remoteBindingQuestion(suggestion({ source })).provenance)
    for (const line of lines) expect(line.length).toBeGreaterThan(0)
    // Distinct, because the whole point of the line is that a name built from
    // the project's own convention is a stronger claim than the local branch's
    // name reused for want of anything better. Four identical sentences would
    // be the field with extra steps.
    expect(new Set(lines).size).toBe(SOURCES.length)
  })

  it('never says the enum’s word back to the reader', () => {
    // `pattern`, `ticket`, `learned` and `local` label the suggestion ladder's
    // rungs. None is a word a reader of this dialog knows, and three of them
    // mean something else in ordinary English.
    for (const source of SOURCES) {
      const line = remoteBindingQuestion(suggestion({ source })).provenance.toLowerCase()
      for (const word of SOURCES) expect(line).not.toContain(word)
    }
  })
})

describe('remoteBindingQuestion — an answerable question in every case', () => {
  it('turns an empty remote list into a field rather than an empty picker', () => {
    // A repository that reported no remotes still has to be answerable; the one
    // thing this must never become is a control nobody can finish.
    const question = remoteBindingQuestion(suggestion({ remote: null, remotes: [] }))
    expect(question.remoteIsTyped).toBe(true)
    expect(question.remoteChoices).toEqual([])
    expect(question.remotePlaceholder.length).toBeGreaterThan(0)
    expect(question.title.length).toBeGreaterThan(0)
    expect(question.confirmLabel.length).toBeGreaterThan(0)
  })

  it('pre-selects what the project named, so the ordinary answer costs a nod', () => {
    expect(remoteBindingQuestion(suggestion()).remotePreset).toBe('origin')
    expect(remoteBindingQuestion(suggestion()).remoteIsTyped).toBe(false)
  })

  it('pre-selects nothing when nobody named a destination — even with one to spare', () => {
    // ALLOWED-PATTERN #22. Selecting the only remote there looks harmless and is
    // the same act as selecting one of four: naming a place nobody named. The
    // ask exists to stop exactly that, so it must not happen inside the ask.
    const question = remoteBindingQuestion(suggestion({ remote: null, remotes: ['origin'] }))
    expect(question.remotePreset).toBe('')
    expect(question.remoteChoices).toEqual(['origin'])
  })

  it('pre-selects nothing when the named remote is not one this checkout has', () => {
    const question = remoteBindingQuestion(
      suggestion({ remote: 'upstream', remotes: ['origin', 'fork'] }),
    )
    expect(question.remotePreset).toBe('')
  })

  it('offers every remote the repository reported, in the order it reported them', () => {
    const question = remoteBindingQuestion(suggestion({ remotes: ['origin', 'upstream', 'fork'] }))
    expect(question.remoteChoices).toEqual(['origin', 'upstream', 'fork'])
  })
})

describe('remoteBindingQuestion — the proposal is not rewritten on its way to the field', () => {
  it.each([
    'feature/PF-42-push-from-review',
    'release/v1.2.3',
    'devuser/spike.2',
    'ACME-2446-rework-the-session-cache-for-the-new-router',
    'feat/some--odd__name.with.dots',
  ])('shows %s byte for byte', (name) => {
    // A DERIVED VALUE IS SHOWN, NOT CLEANED (allowed-pattern #22). This field is
    // editable, so anything sanitised on the way in would quietly become the
    // reader's answer the moment they accepted without reading it — and the name
    // they were shown would not be the name that got written.
    expect(remoteBindingQuestion(suggestion({ suggestion: name })).branchPreset).toBe(name)
  })

  it('passes even a name that is only whitespace straight through', () => {
    // Validating it is the dialog's job, on what the person types BACK. Fixing
    // it here would be the ask answering itself.
    expect(remoteBindingQuestion(suggestion({ suggestion: '   ' })).branchPreset).toBe('   ')
  })
})

describe('remoteBindingQuestion — no dead ends in any string', () => {
  it('hands the reader no command, no path and no config key', () => {
    // FORBIDDEN-PATTERN #12, pinned. This dialog has no terminal behind it, so
    // an invocation in one of these strings is a dead end wearing a sentence's
    // clothes. Checked across every string this module authors; the two presets
    // are excluded on purpose — they are the repository's data, not our words.
    for (const source of SOURCES) {
      for (const remotes of [[], ['origin'], ['origin', 'upstream']]) {
        const question = remoteBindingQuestion(suggestion({ source, remotes }))
        for (const text of authoredStrings(question)) {
          expect(text).not.toContain('`')
          expect(text).not.toContain('/Users/')
          expect(text).not.toContain('./')
          expect(text.toLowerCase()).not.toContain('git ')
          expect(text.toLowerCase()).not.toContain('planflow-ai')
          expect(text).not.toMatch(/^[a-z_]+:/i)
        }
      }
    }
  })

  it('says the blanks are refused rather than filled in', () => {
    const question = remoteBindingQuestion(suggestion())
    expect(question.blankRemoteMessage.length).toBeGreaterThan(0)
    expect(question.blankBranchMessage.length).toBeGreaterThan(0)
    expect(question.blankRemoteMessage).not.toBe(question.blankBranchMessage)
  })
})
