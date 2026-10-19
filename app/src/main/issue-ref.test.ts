// issue-ref — pure parse + normalize for Jira/GitHub issue references.

import {
  parseIssueRef,
  issueCode,
  titleWithCode,
  unrecognizedRefHint,
  normalizeJiraIssue,
  normalizeGithubIssue,
  normalizeAzureIssue,
  normalizeAzurePr,
} from './issue-ref'

describe('parseIssueRef', () => {
  it('parses a bare Jira key', () => {
    expect(parseIssueRef('PRJ-123')).toEqual({ provider: 'jira', key: 'PRJ-123', site: null })
  })

  it('parses a Jira browse URL (captures the site)', () => {
    expect(parseIssueRef('https://acme.atlassian.net/browse/ABC-9')).toEqual({
      provider: 'jira',
      key: 'ABC-9',
      site: 'acme.atlassian.net',
    })
  })

  it('parses a Jira board deep link (selectedIssue query param)', () => {
    expect(
      parseIssueRef(
        'https://acme.atlassian.net/jira/software/c/projects/ACME/boards/3023?assignee=712020%3A00000000-0000-4000-8000-000000000000&selectedIssue=ACME-2059',
      ),
    ).toEqual({ provider: 'jira', key: 'ACME-2059', site: 'acme.atlassian.net' })
  })

  it('parses a Jira software /issues/ URL', () => {
    expect(
      parseIssueRef('https://acme.atlassian.net/jira/software/projects/ABC/issues/ABC-9'),
    ).toEqual({ provider: 'jira', key: 'ABC-9', site: 'acme.atlassian.net' })
  })

  it('parses a GitHub issue URL', () => {
    expect(parseIssueRef('https://github.com/octo/repo/issues/42')).toEqual({
      provider: 'github',
      owner: 'octo',
      repo: 'repo',
      number: 42,
      key: 'octo/repo#42',
    })
  })

  it('does not misread a numeric GitHub /issues/ URL as Jira', () => {
    // The Jira URL parser runs first; a numeric issue number must fall through.
    expect(parseIssueRef('https://github.com/octo/repo/issues/42')?.provider).toBe('github')
  })

  it('parses the GitHub owner/repo#n shorthand', () => {
    expect(parseIssueRef('octo/repo#7')).toEqual({
      provider: 'github',
      owner: 'octo',
      repo: 'repo',
      number: 7,
      key: 'octo/repo#7',
    })
  })

  it('parses an Azure DevOps work-item URL (dev.azure.com)', () => {
    expect(parseIssueRef('https://dev.azure.com/acme-devops/Orbit/_workitems/edit/12345')).toEqual({
      provider: 'azure',
      kind: 'workitem',
      org: 'acme-devops',
      project: 'Orbit',
      id: 12345,
      key: 'acme-devops/Orbit#12345',
    })
  })

  it('parses the legacy visualstudio.com work-item URL', () => {
    expect(parseIssueRef('https://acme-devops.visualstudio.com/Orbit/_workitems/edit/7')).toEqual({
      provider: 'azure',
      kind: 'workitem',
      org: 'acme-devops',
      project: 'Orbit',
      id: 7,
      key: 'acme-devops/Orbit#7',
    })
  })

  it('parses an Azure DevOps pull-request URL', () => {
    expect(
      parseIssueRef('https://dev.azure.com/acme-devops/Orbit/_git/orbit-app/pullrequest/120160'),
    ).toEqual({
      provider: 'azure',
      kind: 'pr',
      org: 'acme-devops',
      project: 'Orbit',
      repo: 'orbit-app',
      id: 120160,
      key: 'acme-devops/Orbit/orbit-app!120160',
    })
  })

  it('parses an Azure PR URL with a query string (?_a=files)', () => {
    const ref = parseIssueRef(
      'https://dev.azure.com/acme-devops/Orbit/_git/orbit-app/pullrequest/120160?_a=files',
    )
    expect(ref).toMatchObject({ provider: 'azure', kind: 'pr', repo: 'orbit-app', id: 120160 })
  })

  it('does NOT treat an Azure git repo URL (no PR/work-item) as an issue', () => {
    expect(parseIssueRef('https://dev.azure.com/acme-devops/Orbit/_git/orbit-app')).toBeNull()
  })

  it('returns null for junk / empty', () => {
    expect(parseIssueRef('not an issue')).toBeNull()
    expect(parseIssueRef('   ')).toBeNull()
    expect(parseIssueRef('lowercase-1')).toBeNull() // Jira keys are uppercase
  })
})

describe('unrecognizedRefHint', () => {
  it('explains a Jira board/non-issue URL and points at the issue format', () => {
    const hint = unrecognizedRefHint(
      'https://acme.atlassian.net/jira/software/c/projects/ACME/boards/6632',
    )
    expect(hint).toMatch(/Jira URL/)
    expect(hint).toMatch(/ACME-123/)
    expect(hint).toMatch(/issue/i)
  })

  it('explains a GitHub non-issue URL', () => {
    const hint = unrecognizedRefHint('https://github.com/octo/repo')
    expect(hint).toMatch(/GitHub URL/)
    expect(hint).toMatch(/owner\/repo#123/)
  })

  it('explains an Azure DevOps non-issue URL', () => {
    const hint = unrecognizedRefHint('https://dev.azure.com/acme-devops/Orbit/_git/orbit-app')
    expect(hint).toMatch(/Azure DevOps URL/)
    expect(hint).toMatch(/_workitems\/edit/)
  })

  it('falls back to the generic message for non-provider junk', () => {
    expect(unrecognizedRefHint('not an issue')).toBe(
      'Not a recognized Jira key or Jira/GitHub/Azure DevOps issue URL: "not an issue"',
    )
  })
})

describe('issueCode', () => {
  it('uses the Jira key verbatim', () => {
    expect(issueCode({ provider: 'jira', key: 'ACME-2109', site: 'x.atlassian.net' })).toBe('ACME-2109')
  })
  it('uses #number for GitHub and #id / PR id for Azure', () => {
    expect(issueCode({ provider: 'github', owner: 'o', repo: 'r', number: 42, key: 'o/r#42' })).toBe('#42')
    expect(
      issueCode({ provider: 'azure', kind: 'workitem', org: 'o', project: 'p', id: 7, key: 'o/p#7' }),
    ).toBe('#7')
    expect(
      issueCode({ provider: 'azure', kind: 'pr', org: 'o', project: 'p', repo: 'g', id: 120160, key: 'k' }),
    ).toBe('PR 120160')
  })
})

describe('titleWithCode', () => {
  it('prefixes the code when absent', () => {
    expect(titleWithCode('ACME-2109', 'Duplicate inserts into tenant_users')).toBe(
      'ACME-2109: Duplicate inserts into tenant_users',
    )
  })
  it('does not double-prefix when the title already leads with the code', () => {
    expect(titleWithCode('ACME-2109', 'ACME-2109 Duplicate inserts')).toBe('ACME-2109 Duplicate inserts')
    expect(titleWithCode('ACME-2109', '[ACME-2109] Duplicate')).toBe('[ACME-2109] Duplicate')
  })
})

describe('normalizeAzureIssue', () => {
  it('maps System.* fields, strips HTML, and prefers the _links html url', () => {
    const ref = { org: 'o', project: 'p', id: 12345, key: 'o/p#12345' }
    const issue = normalizeAzureIssue(
      {
        id: 12345,
        fields: {
          'System.Title': 'Fix billing',
          'System.State': 'Active',
          'System.Description': '<div>Line one.<br>Line two.</div>',
        },
        _links: { html: { href: 'https://dev.azure.com/o/p/_workitems/edit/12345' } },
      },
      ref,
    )
    expect(issue).toMatchObject({
      key: 'o/p#12345',
      title: 'Fix billing',
      status: 'Active',
      url: 'https://dev.azure.com/o/p/_workitems/edit/12345',
    })
    expect(issue.description).toBe('Line one.\nLine two.')
  })

  it('falls back to a constructed url and default title when fields are missing', () => {
    const issue = normalizeAzureIssue({ id: 9, fields: {} }, { org: 'o', project: 'p', id: 9, key: 'o/p#9' })
    expect(issue.title).toBe('Work item 9')
    expect(issue.status).toBe('Unknown')
    expect(issue.url).toBe('https://dev.azure.com/o/p/_workitems/edit/9')
  })
})

describe('normalizeAzurePr', () => {
  const ref = { org: 'o', project: 'p', repo: 'repo', id: 120160, key: 'o/p/repo!120160' }

  it('maps PR title/description/status and prefers the _links web url', () => {
    const issue = normalizeAzurePr(
      {
        pullRequestId: 120160,
        title: 'Fix the build',
        description: 'Please review',
        status: 'active',
        _links: { web: { href: 'https://dev.azure.com/o/p/_git/repo/pullrequest/120160' } },
      },
      ref,
    )
    expect(issue).toMatchObject({
      key: 'o/p/repo!120160',
      title: 'Fix the build',
      description: 'Please review',
      status: 'active',
      url: 'https://dev.azure.com/o/p/_git/repo/pullrequest/120160',
    })
  })

  it('constructs a url and default title when fields are missing', () => {
    const issue = normalizeAzurePr({}, ref)
    expect(issue.title).toBe('Pull request 120160')
    expect(issue.url).toBe('https://dev.azure.com/o/p/_git/repo/pullrequest/120160')
  })
})

describe('normalizeJiraIssue', () => {
  it('extracts key, summary, ADF description, status and builds the url', () => {
    const raw = {
      key: 'ABC-9',
      fields: {
        summary: 'Fix the login bug',
        status: { name: 'In Progress' },
        description: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Line one.' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'Line two.' }] },
          ],
        },
      },
    }
    const issue = normalizeJiraIssue(raw, 'acme.atlassian.net')
    expect(issue.key).toBe('ABC-9')
    expect(issue.title).toBe('Fix the login bug')
    expect(issue.status).toBe('In Progress')
    // A BLANK LINE BETWEEN PARAGRAPHS, because the description is markdown now:
    // two lines separated by a single newline are ONE paragraph, which is how a
    // reproduction used to arrive as an unbroken wall of sentences.
    expect(issue.description).toBe('Line one.\n\nLine two.')
    expect(issue.url).toBe('https://acme.atlassian.net/browse/ABC-9')
  })

  it('keeps the SHAPE of a description, not just its words', () => {
    // ADF used to be flattened to text nodes with a newline after paragraphs,
    // so a heading became a line like any other, a numbered reproduction became
    // one long sentence, and a link became its label with the address gone.
    // The app renders markdown everywhere it shows a body; this converts to the
    // format the renderer already speaks.
    const raw = {
      key: 'ABC-1',
      fields: {
        summary: 'S',
        description: {
          type: 'doc',
          content: [
            { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Steps' }] },
            {
              type: 'orderedList',
              content: [
                {
                  type: 'listItem',
                  content: [
                    { type: 'paragraph', content: [{ type: 'text', text: 'Open Admin' }] },
                  ],
                },
                {
                  type: 'listItem',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Click add' }] }],
                },
              ],
            },
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'See ' },
                {
                  type: 'text',
                  text: 'the env',
                  marks: [{ type: 'link', attrs: { href: 'https://qa.example.test/x' } }],
                },
                { type: 'text', text: ' and ' },
                { type: 'text', text: 'note', marks: [{ type: 'strong' }] },
                { type: 'text', text: ' the ' },
                { type: 'text', text: 'flag', marks: [{ type: 'code' }] },
              ],
            },
            {
              type: 'codeBlock',
              attrs: { language: 'ts' },
              content: [{ type: 'text', text: 'const a = 1' }],
            },
          ],
        },
      },
    }
    const said = normalizeJiraIssue(raw, 'acme.atlassian.net').description
    expect(said).toContain('## Steps')
    expect(said).toContain('1. Open Admin')
    expect(said).toContain('1. Click add')
    expect(said).toContain('[the env](https://qa.example.test/x)')
    expect(said).toContain('**note**')
    // Code wins alone: markdown has no emphasis inside a code span, so wrapping
    // one would print the asterisks.
    expect(said).toContain('`flag`')
    expect(said).toContain('```ts')
  })

  it('turns an ADF table into a markdown one, flattening each cell to a line', () => {
    // A markdown table cannot hold a block. Flattening a cell loses its line
    // breaks; emitting a table the renderer breaks on loses the whole table.
    const raw = {
      key: 'ABC-2',
      fields: {
        summary: 'S',
        description: {
          type: 'doc',
          content: [
            {
              type: 'table',
              content: [
                {
                  type: 'tableRow',
                  content: [
                    {
                      type: 'tableHeader',
                      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Spec' }] }],
                    },
                    {
                      type: 'tableHeader',
                      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Verdict' }] }],
                    },
                  ],
                },
                {
                  type: 'tableRow',
                  content: [
                    {
                      type: 'tableCell',
                      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a | b' }] }],
                    },
                    {
                      type: 'tableCell',
                      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Real' }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    }
    const said = normalizeJiraIssue(raw, 'acme.atlassian.net').description
    expect(said).toContain('| Spec | Verdict |')
    expect(said).toContain('| --- | --- |')
    // A pipe inside a cell is escaped, or it would end the cell early.
    expect(said).toContain('| a \\| b | Real |')
  })

  it('keeps the text of a node it cannot convert, and invents no wrapper for it', () => {
    // Panels, macros and layout columns have no markdown that would be TRUE.
    const raw = {
      key: 'ABC-3',
      fields: {
        summary: 'S',
        description: {
          type: 'doc',
          content: [
            {
              type: 'panel',
              attrs: { panelType: 'info' },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Heads up' }] }],
            },
          ],
        },
      },
    }
    expect(normalizeJiraIssue(raw, 'acme.atlassian.net').description).toBe('Heads up')
  })

  it('handles a plain-string description and missing fields', () => {
    const issue = normalizeJiraIssue({ key: 'X-1', fields: { description: 'plain text' } })
    expect(issue.title).toBe('X-1')
    expect(issue.description).toBe('plain text')
    expect(issue.status).toBe('Unknown')
  })
})

describe('normalizeGithubIssue', () => {
  it('derives the key from html_url and maps body/state', () => {
    const issue = normalizeGithubIssue({
      number: 42,
      title: 'Add dark mode',
      body: 'Please add a toggle.',
      state: 'open',
      html_url: 'https://github.com/octo/repo/issues/42',
    })
    expect(issue.key).toBe('octo/repo#42')
    expect(issue.title).toBe('Add dark mode')
    expect(issue.description).toBe('Please add a toggle.')
    expect(issue.status).toBe('open')
    expect(issue.url).toBe('https://github.com/octo/repo/issues/42')
  })

  it('tolerates a null body', () => {
    const issue = normalizeGithubIssue({
      number: 1,
      title: 't',
      body: null,
      state: 'closed',
      html_url: 'https://github.com/o/r/issues/1',
    })
    expect(issue.description).toBe('')
    expect(issue.status).toBe('closed')
  })
})
