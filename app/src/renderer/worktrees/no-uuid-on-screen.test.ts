/**
 * NO UUID REACHES A PERSON — the sweep, as a test rather than a promise.
 *
 * The conflation this feature ended had one visible symptom in three places: a
 * thread's id, printed as if it were a name. The directory is named now and the
 * branch is named now, but "named now" is a claim about code that is easy to
 * break later — so the rule is asserted where it can fail on the way past
 * (forbidden-pattern #17: grep for the leftovers after a rewrite, then keep the
 * grep).
 */
import { isUnnamedCheckoutPath, worktreeNameFromTitle } from '../../shared/worktree-name'
import { threadWorktreeState } from './thread-worktree-state'
import { switchView } from './worktree-switch'
import type { ThreadSummary } from '../../shared/ipc-contract'

const UUID = 'e2265b48-03e9-43e3-8f76-ff887a48615e'
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

const thread = (over: Partial<ThreadSummary> = {}): ThreadSummary =>
  ({ id: UUID, title: 'Data Contract Guard', worktreePath: null, worktreeBranch: null, ...over }) as ThreadSummary

describe('a thread id is never a name on screen', () => {
  it('says nothing id-shaped for a conversation working in the project', () => {
    const view = switchView(threadWorktreeState('/repos/orbit-app', thread(), 'main'))
    expect(view.stateLine).not.toMatch(UUID_RE)
  })

  it('says nothing id-shaped for a conversation with a copy', () => {
    const state = threadWorktreeState(
      '/repos/orbit-app',
      thread({
        worktreePath: `/repos/.orbit-app-threads/${UUID}`,
        worktreeBranch: `worktree/${UUID}`,
      }),
      'main',
    )
    const view = switchView(state)
    // The SWITCH says nothing about either identifier…
    expect(view.stateLine).not.toMatch(UUID_RE)
    // …and the branch, which the panel prints on its own row, is the one place
    // an id can still appear — for a checkout cut before this shipped. The
    // migration is what ends that, and this is what would notice if it were
    // ever reintroduced at the source.
    expect(state.kind).toBe('own')
    expect(isUnnamedCheckoutPath(`/repos/.orbit-app-threads/${UUID}`)).toBe(true)
  })

  it('never derives a name that is an id, from any title', () => {
    for (const title of [UUID, UUID.toUpperCase(), `  ${UUID}  `]) {
      expect(worktreeNameFromTitle(title)).not.toMatch(UUID_RE)
    }
  })
})
