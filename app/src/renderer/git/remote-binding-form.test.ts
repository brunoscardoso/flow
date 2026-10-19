import type { ThreadBindingState, ThreadBindingSuggestion } from '../../shared/ipc-contract'
import {
  bindingForm,
  bindingLine,
  bindingProblem,
  previouslyPushedNote,
} from './remote-binding-form'

const suggestion = (over: Partial<ThreadBindingSuggestion> = {}): ThreadBindingSuggestion => ({
  suggestion: 'feature/PF-42-landing-bar',
  source: 'ticket',
  // Null by default: most of these cases are about the NAME, and a remote the
  // project never named is the plainer starting point for them.
  remote: null,
  remotes: ['origin'],
  base: 'develop',
  ...over,
})

const state = (over: Partial<ThreadBindingState> = {}): ThreadBindingState => ({
  bound: true,
  remote: 'upstream',
  remoteBranch: 'feature/PF-42',
  prBase: 'develop',
  previouslyPushedAs: null,
  suggestion: null,
  ...over,
})

describe('the destination question', () => {
  it('pre-fills from the proposal a refusal handed back, and says where it came from', () => {
    const form = bindingForm({
      binding: null,
      suggestion: suggestion(),
      localBranch: 'thread/add-the-landing-bar',
      base: 'main',
    })
    expect(form.draft.remoteBranch).toBe('feature/PF-42-landing-bar')
    expect(form.draft.remote).toBe('origin')
    expect(form.draft.prBase).toBe('develop')
    expect(form.help).toContain('ticket')
  })

  it('admits when the name in the box is only the local one', () => {
    // The weakest rung is the one a person is most likely to accept unread, so
    // it is the one that has to say what it is.
    const form = bindingForm({
      binding: null,
      suggestion: null,
      localBranch: 'thread/add-the-landing-bar',
      base: 'main',
    })
    expect(form.draft.remoteBranch).toBe('thread/add-the-landing-bar')
    expect(form.help).toContain('just the name it has here')
  })

  it('invents no remote when nothing knows one', () => {
    const form = bindingForm({
      binding: null,
      suggestion: suggestion({ remotes: [] }),
      localBranch: 'thread/x',
      base: null,
    })
    expect(form.draft.remote).toBe('')
    expect(form.showRemoteChoice).toBe(false)
  })

  it('starts on the remote this project usually publishes to, with the choice still open', () => {
    // FR-6: the default reaches the ask pre-selected. It is still a select with
    // both remotes in it — a default is an offer, not a decision already taken.
    const form = bindingForm({
      binding: null,
      suggestion: suggestion({ remote: 'upstream', remotes: ['origin', 'upstream'] }),
      localBranch: 'thread/x',
      base: null,
    })
    expect(form.draft.remote).toBe('upstream')
    expect(form.showRemoteChoice).toBe(true)
    expect(form.remotes).toEqual(['origin', 'upstream'])
    // And it says why that one is sitting there.
    expect(form.remoteHelp).not.toBeNull()
  })

  it('ignores a usual remote this repository does not have', () => {
    // A default naming something absent is a wrong answer already filled in.
    const form = bindingForm({
      binding: null,
      suggestion: suggestion({ remote: 'origin', remotes: ['upstream', 'fork'] }),
      localBranch: 'thread/x',
      base: null,
    })
    expect(form.draft.remote).toBe('')
    expect(form.remoteHelp).toBeNull()
  })

  it('lets the binding that already exists outrank the project\u2019s usual remote', () => {
    // Editing a binding starts from the binding, and nothing explains a value
    // the person themselves chose.
    const form = bindingForm({
      binding: state({ remote: 'fork' }),
      suggestion: suggestion({ remote: 'origin', remotes: ['origin', 'fork'] }),
      localBranch: 'thread/x',
      base: null,
    })
    expect(form.draft.remote).toBe('fork')
    expect(form.remoteHelp).toBeNull()
  })

  it('explains nothing when there was no choice to explain', () => {
    const form = bindingForm({
      binding: null,
      suggestion: suggestion({ remote: 'origin', remotes: ['origin'] }),
      localBranch: 'thread/x',
      base: null,
    })
    expect(form.draft.remote).toBe('origin')
    expect(form.remoteHelp).toBeNull()
  })

  it('offers a choice only when there is one to make', () => {
    const one = bindingForm({
      binding: null,
      suggestion: suggestion({ remotes: ['origin'] }),
      localBranch: 'thread/x',
      base: null,
    })
    const two = bindingForm({
      binding: null,
      suggestion: suggestion({ remotes: ['origin', 'upstream'] }),
      localBranch: 'thread/x',
      base: null,
    })
    expect(one.showRemoteChoice).toBe(false)
    expect(two.showRemoteChoice).toBe(true)
    expect(two.remotes).toEqual(['origin', 'upstream'])
  })

  it('starts an edit from the binding that already exists', () => {
    const form = bindingForm({
      binding: state(),
      suggestion: null,
      localBranch: 'thread/x',
      base: 'main',
    })
    expect(form.draft).toEqual({
      remote: 'upstream',
      remoteBranch: 'feature/PF-42',
      prBase: 'develop',
    })
    // Nothing was proposed, so there is nothing to say about a proposal.
    expect(form.help).toBe('')
  })

  it('says nothing a person could not act on (#12)', () => {
    const forms = [
      bindingForm({ binding: null, suggestion: suggestion(), localBranch: 'a', base: 'b' }),
      bindingForm({ binding: state(), suggestion: null, localBranch: 'a', base: 'b' }),
      bindingForm({ binding: null, suggestion: null, localBranch: null, base: null }),
    ]
    for (const form of forms) {
      for (const text of [form.title, form.body, form.help, form.remoteHelp ?? '', form.confirmLabel]) {
        expect(text).not.toMatch(/planflow-ai|git |gh pr|\/repo|\.flowconfig|--/)
      }
    }
  })
})

describe('what stops a destination being used', () => {
  it('refuses an empty remote rather than choosing one', () => {
    const problem = bindingProblem({ remote: ' ', remoteBranch: 'feature/x', prBase: '' })
    expect(problem).not.toBeNull()
    expect(problem).not.toMatch(/origin/)
  })

  it('refuses an empty name rather than falling back to the local one', () => {
    expect(bindingProblem({ remote: 'origin', remoteBranch: '', prBase: '' })).not.toBeNull()
  })

  it('refuses a name nothing could be called', () => {
    expect(bindingProblem({ remote: 'origin', remoteBranch: '///', prBase: '' })).not.toBeNull()
    expect(bindingProblem({ remote: 'origin', remoteBranch: 'two words', prBase: '' })).not.toBeNull()
  })

  it('lets a complete answer through, with no base named', () => {
    expect(bindingProblem({ remote: 'origin', remoteBranch: 'feature/x', prBase: '' })).toBeNull()
  })
})

describe('the line a surface shows', () => {
  it('names the destination without repeating the local branch', () => {
    const line = bindingLine({
      bound: true,
      remote: 'origin',
      remoteBranch: 'feature/PF-42',
      prBase: 'develop',
    })
    expect(line).toBe('Published as origin/feature/PF-42 · opens against develop')
  })

  it('leaves the base out when nobody named one', () => {
    expect(
      bindingLine({ bound: true, remote: 'origin', remoteBranch: 'feature/x', prBase: null }),
    ).toBe('Published as origin/feature/x')
  })

  it('reads an unbound worktree as ordinary, not as broken', () => {
    const line = bindingLine({ bound: false, remote: null, remoteBranch: null, prBase: null })
    expect(line).toBe('Not published yet')
  })

  it('names what a rename left on the remote, and never offers to remove it', () => {
    const note = previouslyPushedNote('feature/old-name')
    expect(note).toContain('feature/old-name')
    expect(note).toContain('still there')
    expect(previouslyPushedNote(null)).toBeNull()
  })
})

describe('what each rung admits about itself', () => {
  // Four rungs, four different amounts of standing — and the helper line is
  // the only place a person is told which one they are being handed.
  it('says a name came from the way this project names its branches', () => {
    const form = bindingForm({
      binding: null,
      suggestion: suggestion({ suggestion: 'feature/landing-bar', source: 'pattern' }),
      localBranch: 'thread/x',
      base: 'main',
    })
    expect(form.help).toBe('Suggested from the way this project names its branches.')
  })

  it('says a name came from the last one published here', () => {
    const form = bindingForm({
      binding: null,
      suggestion: suggestion({ suggestion: 'feature/landing-bar', source: 'learned' }),
      localBranch: 'thread/x',
      base: 'main',
    })
    expect(form.help).toBe('Suggested from the last branch you published here.')
  })

  it('gives every rung something to say, and never the same thing twice', () => {
    const helps = (['pattern', 'ticket', 'learned', 'local'] as const).map(
      (source) =>
        bindingForm({
          binding: null,
          suggestion: suggestion({ source }),
          localBranch: 'thread/x',
          base: 'main',
        }).help,
    )
    for (const help of helps) expect(help).not.toBe('')
    expect(new Set(helps).size).toBe(4)
  })

  it('offers the choice of remotes on an edit too, and only when there is one', () => {
    // The select is a control only when a decision exists behind it; editing a
    // binding does not change that.
    const several = bindingForm({
      binding: state(),
      suggestion: suggestion({ remotes: ['origin', 'upstream'] }),
      localBranch: 'thread/x',
      base: 'main',
    })
    const alone = bindingForm({
      binding: state(),
      suggestion: null,
      localBranch: 'thread/x',
      base: 'main',
    })
    expect(several.showRemoteChoice).toBe(true)
    expect(several.remotes).toEqual(['origin', 'upstream'])
    expect(alone.showRemoteChoice).toBe(false)
    expect(alone.remotes).toEqual([])
  })
})

describe('half a binding is not a binding', () => {
  it('reads a remote with no name on it as unpublished', () => {
    // It would otherwise read as decided and publish nowhere.
    expect(
      bindingLine({ bound: true, remote: 'origin', remoteBranch: null, prBase: 'develop' }),
    ).toBe('Not published yet')
  })

  it('reads a name with no remote under it as unpublished', () => {
    expect(
      bindingLine({ bound: true, remote: null, remoteBranch: 'feature/x', prBase: 'develop' }),
    ).toBe('Not published yet')
  })

  it('believes the flag over the values beside it', () => {
    // A mirror that says it is not bound is not bound, whatever it is carrying.
    expect(
      bindingLine({ bound: false, remote: 'origin', remoteBranch: 'feature/x', prBase: 'develop' }),
    ).toBe('Not published yet')
  })

  it('treats an empty base the same as none at all', () => {
    expect(bindingLine({ bound: true, remote: 'origin', remoteBranch: 'feature/x', prBase: '' })).toBe(
      'Published as origin/feature/x',
    )
  })
})

describe('the note a rename leaves behind', () => {
  it('says the whole thing, including that nothing was removed', () => {
    expect(previouslyPushedNote('feature/old-name')).toBe(
      'Previously published as feature/old-name — that copy is still there.',
    )
  })

  it('says nothing at all when the field is merely empty', () => {
    expect(previouslyPushedNote('')).toBeNull()
  })
})

describe('nothing on this form is something to go and type (#12)', () => {
  it('sweeps every string these two surfaces render', () => {
    const forms = [
      ...(['pattern', 'ticket', 'learned', 'local'] as const).map((source) =>
        bindingForm({
          binding: null,
          suggestion: suggestion({ source }),
          localBranch: 'thread/x',
          base: 'main',
        }),
      ),
      bindingForm({ binding: state(), suggestion: null, localBranch: 'thread/x', base: 'main' }),
      bindingForm({ binding: null, suggestion: null, localBranch: null, base: null }),
      bindingForm({
        binding: null,
        suggestion: suggestion({ remotes: ['origin', 'upstream'] }),
        localBranch: 'thread/x',
        base: 'main',
      }),
      // The one that carries a remote explanation, so #12 sweeps that too.
      bindingForm({
        binding: null,
        suggestion: suggestion({ remote: 'upstream', remotes: ['origin', 'upstream'] }),
        localBranch: 'thread/x',
        base: 'main',
      }),
    ]
    const strings = [
      ...forms.flatMap((form) => [
        form.title,
        form.body,
        form.help,
        form.remoteHelp ?? '',
        form.confirmLabel,
      ]),
      bindingLine({ bound: true, remote: 'origin', remoteBranch: 'feature/x', prBase: 'develop' }),
      bindingLine({ bound: false, remote: null, remoteBranch: null, prBase: null }),
      previouslyPushedNote('feature/old-name') ?? '',
      bindingProblem({ remote: '', remoteBranch: 'feature/x', prBase: '' }) ?? '',
      bindingProblem({ remote: 'origin', remoteBranch: '', prBase: '' }) ?? '',
      bindingProblem({ remote: 'origin', remoteBranch: '///', prBase: '' }) ?? '',
      bindingProblem({ remote: 'origin', remoteBranch: 'two words', prBase: '' }) ?? '',
    ]
    expect(strings.length).toBeGreaterThan(20)
    for (const text of strings) {
      expect(text).not.toMatch(/planflow-ai|git |gh pr|--[a-z]|\.flowconfig/)
    }
  })
})
