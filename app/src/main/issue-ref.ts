// Pure issue parsing + normalization for the task list. No network, no DOM —
// unit-tested directly. The integration layer (integrations-manager) does the
// authenticated fetch and hands the raw JSON to the normalize* functions here.

import {
  imagesFromHtml,
  imagesFromJiraFields,
  imagesFromMarkdown,
  type IssueImage,
} from './integrations/issue-images'

export type { IssueImage }

export type IssueProvider = 'jira' | 'github' | 'azure'

/** A parsed reference to an external issue/PR, from a pasted key/URL. */
export type IssueRef =
  | { provider: 'jira'; key: string; site: string | null }
  | { provider: 'github'; owner: string; repo: string; number: number; key: string }
  | { provider: 'azure'; kind: 'workitem'; org: string; project: string; id: number; key: string }
  | {
      provider: 'azure'
      kind: 'pr'
      org: string
      project: string
      repo: string
      id: number
      key: string
    }

/**
 * A compact human code for an issue, used to prefix task/thread titles
 * (e.g. "ACME-2109"). Jira keys are already short; GitHub/Azure use a `#id` /
 * `PR id` form rather than the long `owner/repo#n` dedup key.
 */
export function issueCode(ref: IssueRef): string {
  switch (ref.provider) {
    case 'jira':
      return ref.key
    case 'github':
      return `#${ref.number}`
    case 'azure':
      return ref.kind === 'pr' ? `PR ${ref.id}` : `#${ref.id}`
  }
}

/**
 * Prefix a title with its issue code unless it already leads with it (some
 * summaries embed the key). Keeps titles scannable: "ACME-2109: <summary>".
 */
export function titleWithCode(code: string, title: string): string {
  const trimmed = title.trim()
  if (!code) return trimmed
  // Already starts with the code (any of `ACME-1`, `ACME-1:`, `[ACME-1]`, `#5 …`).
  const normalized = trimmed.replace(/^[[\s]*/, '')
  if (normalized.toLowerCase().startsWith(code.toLowerCase())) return trimmed
  return `${code}: ${trimmed}`
}

/** A provider-agnostic issue, ready to become a task. */
export interface NormalizedIssue {
  key: string
  title: string
  description: string
  status: string
  url: string
  /**
   * The facts a tracker prints beside a ticket, and a person reads before
   * anything else: what KIND of thing it is, how urgent, who filed it and who
   * has it.
   *
   * EMPTY MEANS THE TRACKER DID NOT SAY, never "none" — a field with no value
   * is not drawn at all, because "Priority: —" is a row of chrome about an
   * absence. Every one is optional because the three trackers disagree about
   * which of them exist: GitHub has no priority, Azure calls the reporter
   * "created by", and a Jira project can switch any of them off.
   */
  type?: string
  priority?: string
  reporter?: string
  assignee?: string
  /**
   * The pictures the ticket carries — addresses only, never bytes.
   *
   * A screenshot is most of what a bug report says, and none of them reached
   * the card before: Jira's live in an attachment list the description never
   * mentions, and a GitHub body's `![](…)` was text in a renderer with no
   * image support. The bytes are fetched one at a time, on demand, by
   * `IntegrationsManager.imageData` — a list of issues must not become a
   * megabyte of base64 per row.
   *
   * ABSENT WHERE IT WAS NOT ASKED. A normalizer given a payload without the
   * field simply omits this, which is not the same as a ticket with no
   * pictures — see the Jira `fields` list.
   */
  images?: IssueImage[]
}

/** Description text stored/seeded per task is capped to keep the DB lean. */
const MAX_DESCRIPTION = 8_000

const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/
// Host is a bare hostname (+ optional port) — no userinfo (`@`), no other junk,
// so a pasted URL can't smuggle credentials to an arbitrary authority.
const JIRA_HOST = /^https?:\/\/([a-zA-Z0-9.-]+(?::\d+)?)\//
// The issue key can live in the path (/browse/KEY, /issues/KEY) or as a
// selectedIssue=KEY query param — the latter is how board/backlog deep links
// (…/boards/3023?selectedIssue=ACME-2059) address the open issue.
const JIRA_PATH_KEY = /\/(?:browse|issues)\/([A-Z][A-Z0-9]+-\d+)\b/
const JIRA_SELECTED_KEY = /[?&]selectedIssue=([A-Z][A-Z0-9]+-\d+)\b/
const GITHUB_URL = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\b/
const GITHUB_SHORT = /^([\w.-]+)\/([\w.-]+)#(\d+)$/
// Azure DevOps work item: dev.azure.com/{org}/{project}/_workitems/edit/{id}
// or the legacy {org}.visualstudio.com/{project}/_workitems/edit/{id}.
const AZURE_URL =
  /^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_workitems\/edit\/(\d+)\b/
const AZURE_VS_URL =
  /^https?:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_workitems\/edit\/(\d+)\b/
// Azure DevOps pull request: dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}
const AZURE_PR_URL =
  /^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)\b/i
const AZURE_VS_PR_URL =
  /^https?:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)\b/i

/**
 * Parse a pasted string into an IssueRef, auto-detecting the provider.
 * Accepts: a bare Jira key (PRJ-123), a Jira browse URL, a GitHub issue URL,
 * or the GitHub `owner/repo#123` shorthand. Returns null when nothing matches.
 */
export function parseIssueRef(input: string): IssueRef | null {
  const text = input.trim()
  if (!text) return null

  const jira = parseJiraUrl(text)
  if (jira) return jira
  const githubUrl = GITHUB_URL.exec(text)
  if (githubUrl) {
    const owner = githubUrl[1]!
    const repo = githubUrl[2]!
    const number = Number.parseInt(githubUrl[3]!, 10)
    return { provider: 'github', owner, repo, number, key: `${owner}/${repo}#${number}` }
  }
  const githubShort = GITHUB_SHORT.exec(text)
  if (githubShort) {
    const owner = githubShort[1]!
    const repo = githubShort[2]!
    const number = Number.parseInt(githubShort[3]!, 10)
    return { provider: 'github', owner, repo, number, key: `${owner}/${repo}#${number}` }
  }
  const azurePr = AZURE_PR_URL.exec(text) ?? AZURE_VS_PR_URL.exec(text)
  if (azurePr) {
    const org = decodeURIComponent(azurePr[1]!)
    const project = decodeURIComponent(azurePr[2]!)
    const repo = decodeURIComponent(azurePr[3]!)
    const id = Number.parseInt(azurePr[4]!, 10)
    return { provider: 'azure', kind: 'pr', org, project, repo, id, key: `${org}/${project}/${repo}!${id}` }
  }
  const azure = AZURE_URL.exec(text) ?? AZURE_VS_URL.exec(text)
  if (azure) {
    const org = decodeURIComponent(azure[1]!)
    const project = decodeURIComponent(azure[2]!)
    const id = Number.parseInt(azure[3]!, 10)
    return { provider: 'azure', kind: 'workitem', org, project, id, key: `${org}/${project}#${id}` }
  }
  if (JIRA_KEY.test(text)) {
    return { provider: 'jira', key: text, site: null }
  }
  return null
}

/**
 * A friendly, specific reason why `parseIssueRef` rejected `input` (which has
 * already failed to parse). The common case is a provider URL that isn't an
 * *issue* link — a Jira board/backlog, a repo/PR page — so name the format the
 * user should paste instead. Falls back to the generic message for text that
 * doesn't look like any known provider. Pure; unit-tested.
 */
export function unrecognizedRefHint(input: string): string {
  const text = input.trim()
  if (/atlassian\.net|\/jira\//i.test(text)) {
    return 'That looks like a Jira URL, but not an issue link. Paste an issue key (e.g. ACME-123) or an issue URL (…/browse/ACME-123).'
  }
  if (/github\.com/i.test(text)) {
    return 'That looks like a GitHub URL, but not an issue link. Paste an issue URL (…/issues/123) or the owner/repo#123 shorthand.'
  }
  if (/dev\.azure\.com|visualstudio\.com/i.test(text)) {
    return 'That looks like an Azure DevOps URL, but not a work-item or PR link. Paste a work-item URL (…/_workitems/edit/123) or a pull-request URL.'
  }
  return `Not a recognized Jira key or Jira/GitHub/Azure DevOps issue URL: "${input}"`
}

/**
 * Recognize a Jira issue from any of its URL shapes: a /browse/ or /issues/
 * link, or a board/backlog deep link carrying selectedIssue=KEY. The host is
 * captured for downstream validation only — fetchJira ignores it and talks
 * solely to the connected site, refusing a mismatch (no credential exfiltration
 * to a pasted authority). GitHub/Azure URLs never carry a Jira-style KEY, so
 * this stays specific.
 */
function parseJiraUrl(text: string): IssueRef | null {
  const host = JIRA_HOST.exec(text)
  if (!host) return null
  const key = JIRA_PATH_KEY.exec(text) ?? JIRA_SELECTED_KEY.exec(text)
  if (!key) return null
  return { provider: 'jira', key: key[1]!, site: host[1]! }
}

/** Normalize a Jira Cloud REST v3 issue payload. */
export function normalizeJiraIssue(raw: unknown, site?: string | null): NormalizedIssue {
  const obj = asRecord(raw)
  const key = str(obj['key'])
  const fields = asRecord(obj['fields'])
  const title = str(fields['summary']) || key || 'Jira issue'
  const description = capDescription(extractJiraDescription(fields['description']))
  const status = str(asRecord(fields['status'])['name']) || 'Unknown'
  const url = site && key ? `https://${site}/browse/${key}` : str(obj['self'])
  return {
    key,
    title,
    description,
    status,
    url,
    ...named('type', str(asRecord(fields['issuetype'])['name'])),
    ...named('priority', str(asRecord(fields['priority'])['name'])),
    ...named('reporter', str(asRecord(fields['reporter'])['displayName'])),
    ...named('assignee', str(asRecord(fields['assignee'])['displayName'])),
    ...pictures(imagesFromJiraFields(fields)),
  }
}

/**
 * The images, or the field left off entirely.
 *
 * SAME RULE AS `named`, for the same reason. A payload fetched without the
 * attachment field and a ticket with nothing attached both produce an empty
 * array here, and only one of them is the ticket saying "no pictures" — so
 * neither is drawn as an empty gallery.
 */
function pictures(images: readonly IssueImage[]): { images?: IssueImage[] } {
  return images.length === 0 ? {} : { images: [...images] }
}

/**
 * A field, or nothing at all.
 *
 * ABSENT IS NOT EMPTY. A tracker that did not answer and a tracker that
 * answered "none" are different, and only the first should leave the row off
 * the ticket rather than printing a dash where a name goes.
 */
function named(key: string, value: string): Record<string, string> {
  const trimmed = value.trim()
  return trimmed.length === 0 ? {} : { [key]: trimmed }
}

/** Normalize a GitHub REST issue payload. */
export function normalizeGithubIssue(raw: unknown): NormalizedIssue {
  const obj = asRecord(raw)
  const htmlUrl = str(obj['html_url'])
  const number = typeof obj['number'] === 'number' ? obj['number'] : 0
  const key = keyFromGithubUrl(htmlUrl, number)
  const title = str(obj['title']) || key || 'GitHub issue'
  const description = capDescription(str(obj['body']))
  const status = str(obj['state']) || 'open'
  return {
    key,
    title,
    description,
    status,
    url: htmlUrl,
    // GitHub has no priority field at all, and its "type" is a repo-level
    // label scheme rather than a property — so neither is invented here.
    ...named('reporter', str(asRecord(obj['user'])['login'])),
    ...named('assignee', str(asRecord(obj['assignee'])['login'])),
    // From the RAW body, not the capped one: a screenshot linked past the
    // 8,000-character cap is still a screenshot on this ticket.
    ...pictures(imagesFromMarkdown(str(obj['body']))),
  }
}

/** Normalize an Azure DevOps work-item REST payload. */
export function normalizeAzureIssue(
  raw: unknown,
  ref: { org: string; project: string; id: number; key: string },
): NormalizedIssue {
  const obj = asRecord(raw)
  const fields = asRecord(obj['fields'])
  const title = str(fields['System.Title']) || `Work item ${ref.id}`
  const description = capDescription(htmlToText(str(fields['System.Description'])))
  const status = str(fields['System.State']) || 'Unknown'
  const linkHref = str(asRecord(asRecord(obj['_links'])['html'])['href'])
  const url =
    linkHref ||
    `https://dev.azure.com/${ref.org}/${ref.project}/_workitems/edit/${ref.id}`
  const priority = fields['Microsoft.VSTS.Common.Priority']
  return {
    key: ref.key,
    title,
    description,
    status,
    url,
    ...named('type', str(fields['System.WorkItemType'])),
    // Azure's priority is a NUMBER (1 is highest). Printed as the tracker
    // spells it, prefixed so a bare "2" is not mistaken for a count.
    ...named('priority', typeof priority === 'number' ? `P${String(priority)}` : ''),
    // Azure calls the reporter "created by".
    ...named('reporter', str(asRecord(fields['System.CreatedBy'])['displayName'])),
    ...named('assignee', str(asRecord(fields['System.AssignedTo'])['displayName'])),
    // The description is HTML here, and `htmlToText` above throws the tags
    // away — so the images are read off the markup before it is flattened.
    ...pictures(imagesFromHtml(str(fields['System.Description']))),
  }
}

/** Normalize an Azure DevOps pull-request REST payload. */
export function normalizeAzurePr(
  raw: unknown,
  ref: { org: string; project: string; repo: string; id: number; key: string },
): NormalizedIssue {
  const obj = asRecord(raw)
  const title = str(obj['title']) || `Pull request ${ref.id}`
  // PR descriptions are markdown/plain text (not ADF/HTML) — store as-is, capped.
  const description = capDescription(str(obj['description']))
  const status = str(obj['status']) || 'active' // active | completed | abandoned
  const web = str(asRecord(asRecord(obj['_links'])['web'])['href'])
  const url =
    web || `https://dev.azure.com/${ref.org}/${ref.project}/_git/${ref.repo}/pullrequest/${ref.id}`
  return { key: ref.key, title, description, status, url }
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Crude HTML → text: strip tags, collapse whitespace, decode common entities. */
function htmlToText(html: string): string {
  if (!html) return ''
  return html
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function keyFromGithubUrl(htmlUrl: string, number: number): string {
  const m = GITHUB_URL.exec(htmlUrl)
  if (m) return `${m[1]}/${m[2]}#${m[3]}`
  return number ? `#${number}` : ''
}

/**
 * Jira descriptions are Atlassian Document Format (ADF) — a nested doc tree —
 * or (older APIs) a plain string.
 *
 * IT EMITS MARKDOWN NOW, and that is the whole change. This used to collect
 * `text` nodes and put a newline after paragraphs and headings, which threw
 * away everything that made the description READABLE: a numbered
 * reproduction became an unbroken wall of sentences, a heading became a line
 * like any other, and a link became its label with the address gone. The app
 * renders markdown everywhere it shows a body, so the honest conversion is to
 * the format the renderer already speaks rather than to the flattest thing
 * that could be called text.
 *
 * WHAT IS NOT CONVERTED IS DROPPED, NOT GUESSED. Media, panels and macros have
 * no markdown equivalent that would be true; their text content still comes
 * through, without an invented wrapper claiming a structure ADF did not have.
 */
function extractJiraDescription(description: unknown): string {
  if (typeof description === 'string') return description.trim()
  if (typeof description !== 'object' || description === null) return ''
  return adfBlocks(description, '').replace(/\n{3,}/g, '\n\n').trim()
}

/** The marks Jira puts on a text node, as the markdown that means the same. */
function adfInline(node: unknown): string {
  if (typeof node !== 'object' || node === null) return ''
  const n = node as Record<string, unknown>
  const type = n['type']
  if (type === 'hardBreak') return '\n'
  // An inline card is a bare link Jira renders as a chip — its address is the
  // only thing it carries, and the only thing worth keeping.
  if (type === 'inlineCard') {
    const url = str(asRecord(n['attrs'])['url'])
    return url.length > 0 ? `<${url}>` : ''
  }
  if (type === 'mention') {
    const text = str(asRecord(n['attrs'])['text'])
    return text.length > 0 ? text : '@someone'
  }
  if (type === 'emoji') return str(asRecord(n['attrs'])['shortName'])
  if (type !== 'text') {
    const content = n['content']
    return Array.isArray(content) ? content.map(adfInline).join('') : ''
  }
  let text = str(n['text'])
  if (text.length === 0) return ''
  const marks = Array.isArray(n['marks']) ? n['marks'] : []
  // CODE FIRST AND ALONE: markdown has no emphasis inside a code span, so
  // wrapping one in asterisks would print the asterisks.
  if (marks.some((mark) => asRecord(mark)['type'] === 'code')) return `\`${text}\``
  for (const mark of marks) {
    const m = asRecord(mark)
    const kind = m['type']
    if (kind === 'strong') text = `**${text}**`
    else if (kind === 'em') text = `_${text}_`
    else if (kind === 'strike') text = `~~${text}~~`
    else if (kind === 'link') {
      const href = str(asRecord(m['attrs'])['href'])
      if (href.length > 0) text = `[${text}](${href})`
    }
  }
  return text
}

/** One ADF node's children, as inline markdown. */
function adfText(node: Record<string, unknown>): string {
  const content = node['content']
  return Array.isArray(content) ? content.map(adfInline).join('') : ''
}

/**
 * Block-level ADF, as markdown. `indent` carries list nesting.
 *
 * Ordered lists are numbered `1.` throughout on purpose: markdown renumbers
 * them, and a hand-kept counter is a second source of truth for a number the
 * renderer owns.
 */
function adfBlocks(node: unknown, indent: string): string {
  if (typeof node !== 'object' || node === null) return ''
  const n = node as Record<string, unknown>
  const kids = Array.isArray(n['content']) ? (n['content'] as unknown[]) : []
  switch (n['type']) {
    case 'doc':
      return kids.map((kid) => adfBlocks(kid, indent)).join('')
    case 'paragraph':
      return `${indent}${adfText(n)}\n\n`
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(asRecord(n['attrs'])['level']) || 1))
      return `${'#'.repeat(level)} ${adfText(n)}\n\n`
    }
    case 'rule':
      return '---\n\n'
    case 'codeBlock': {
      const language = str(asRecord(n['attrs'])['language'])
      return `\`\`\`${language}\n${adfText(n)}\n\`\`\`\n\n`
    }
    case 'blockquote':
      return `${kids
        .map((kid) => adfBlocks(kid, indent))
        .join('')
        .trimEnd()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}\n\n`
    case 'bulletList':
    case 'orderedList': {
      const bullet = n['type'] === 'bulletList' ? '- ' : '1. '
      return `${kids.map((kid) => adfListItem(kid, indent, bullet)).join('')}\n`
    }
    case 'table':
      return adfTable(kids)
    default:
      // An unknown block still carries its text — a panel, a macro, a layout
      // column. Nothing is invented around it.
      return kids.length > 0 ? kids.map((kid) => adfBlocks(kid, indent)).join('') : ''
  }
}

/** One list item, with its continuation lines indented under its bullet. */
function adfListItem(node: unknown, indent: string, bullet: string): string {
  const body = adfBlocks(node, `${indent}  `).trimEnd()
  if (body.length === 0) return ''
  const [first, ...rest] = body.split('\n')
  const head = `${indent}${bullet}${(first ?? '').trimStart()}`
  return [head, ...rest].join('\n') + '\n'
}

/**
 * An ADF table as a markdown one.
 *
 * A MARKDOWN TABLE CANNOT HOLD A BLOCK, so each cell is its own text flattened
 * onto one line and its pipes escaped. That is a real loss and it is the
 * honest one: the alternative is emitting a table the renderer would break on,
 * which loses the whole table rather than one cell's line breaks.
 */
function adfTable(rows: readonly unknown[]): string {
  const cells = rows.map((row) => {
    const cols = Array.isArray(asRecord(row)['content']) ? (asRecord(row)['content'] as unknown[]) : []
    return cols.map((cell) =>
      adfBlocks(cell, '')
        .replace(/\s+/g, ' ')
        .replace(/\|/g, '\\|')
        .trim(),
    )
  })
  const header = cells[0]
  if (header === undefined || header.length === 0) return ''
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...cells.slice(1).map((row) => `| ${row.join(' | ')} |`),
  ]
  return `${lines.join('\n')}\n\n`
}

/**
 * Cap a description to keep the DB lean. Exported because the fetched path is
 * no longer the only writer of one: a claimed queue item's body is stored
 * verbatim by the task service, and it must be capped by the SAME rule rather
 * than by a second constant that could drift from this one.
 */
export function capDescription(value: string): string {
  return value.length > MAX_DESCRIPTION ? `${value.slice(0, MAX_DESCRIPTION - 1)}…` : value
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
