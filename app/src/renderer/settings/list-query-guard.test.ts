// The list-query guard — does a saved GitHub query actually READ as a search,
// or is it a URL/repo-path that the Search API will silently take as free text?
//
// The bug it exists to stop: a person pasted `owner/repo/issues` into the field,
// GitHub matched it by TEXT, and the board drew 4 unrelated closed issues while
// the same repo showed 5 open ones. The guard flags that shape and OFFERS a
// scoped rewrite — it never rewrites silently (allowed-pattern #22).

import { inspectListQuery } from './list-query-guard'

describe('inspectListQuery — GitHub', () => {
  it('flags the exact bug: a repo URL PATH, and suggests a scoped search', () => {
    const v = inspectListQuery('github', 'dev/plan-flow/issues')
    expect(v.looksMalformedForSearch).toBe(true)
    expect(v.suggestion).toBe('repo:dev/plan-flow is:issue is:open')
  })

  it('flags a pasted github.com URL and names the repo in the suggestion', () => {
    const v = inspectListQuery('github', 'https://github.com/acme/api')
    expect(v.looksMalformedForSearch).toBe(true)
    expect(v.suggestion).toBe('repo:acme/api is:issue is:open')
  })

  it('flags a bare owner/repo', () => {
    const v = inspectListQuery('github', 'acme/api')
    expect(v.looksMalformedForSearch).toBe(true)
    expect(v.suggestion).toBe('repo:acme/api is:issue is:open')
  })

  it('strips a trailing .git from a copied clone URL', () => {
    expect(inspectListQuery('github', 'acme/api.git').suggestion).toBe(
      'repo:acme/api is:issue is:open',
    )
  })

  it('does NOT flag a real search — the presence of a qualifier is the signal', () => {
    const v = inspectListQuery('github', 'repo:acme/api is:issue is:open label:bug')
    expect(v.looksMalformedForSearch).toBe(false)
    expect(v.reason).toBeNull()
    expect(v.suggestion).toBeNull()
  })

  it('does NOT flag assignee:@me — the default question is a valid search', () => {
    expect(inspectListQuery('github', 'assignee:@me is:issue').looksMalformedForSearch).toBe(false)
  })

  it('an empty or whitespace query is a deliberate blank, never flagged', () => {
    expect(inspectListQuery('github', '').looksMalformedForSearch).toBe(false)
    expect(inspectListQuery('github', '   ').looksMalformedForSearch).toBe(false)
  })

  it('a path-like value with no nameable repo is flagged WITHOUT a rewrite', () => {
    const v = inspectListQuery('github', 'a/b/c/d')
    expect(v.looksMalformedForSearch).toBe(true)
    expect(v.suggestion).toBeNull()
  })
})

describe('inspectListQuery — other trackers pass through (GitHub-first)', () => {
  it('never second-guesses a Jira JQL with a GitHub rule', () => {
    // `project = ACME AND ...` contains no slash and no GitHub qualifier; the
    // guard leaves Jira/Azure alone entirely until they get their own detection.
    expect(inspectListQuery('jira', 'project = ACME AND resolution = Unresolved').looksMalformedForSearch).toBe(
      false,
    )
    expect(inspectListQuery('azure', 'SELECT [System.Id] FROM WorkItems').looksMalformedForSearch).toBe(
      false,
    )
  })
})
