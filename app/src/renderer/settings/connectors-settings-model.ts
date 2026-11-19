/**
 * Settings → Connectors, the pure half (plan_connectors Phase 7, FR-10..14).
 *
 * Every sentence and decision the Connectors group shows comes from here:
 * which section a connector belongs to, its one status pill, its one main
 * action, whether Flow may remove it, where it is managed when Flow may not,
 * and whether the add form's answers make a connector. DOM-free, so the app's
 * node-env jest runs it; the view (`connectors-settings-section.ts`) only
 * draws what this returns.
 *
 * WHERE A PROJECT-LOCAL CONNECTOR GOES. Claude keeps "only this project, just
 * for me" connectors in the ACCOUNT's own file, keyed by the project — it is
 * private to this person and never reaches the team. So it is listed with the
 * account's connectors, carrying an "Only this project" tag, rather than with
 * the project's shared ones: the project heading says "shared with the team",
 * and a private connector under it would make that heading false.
 *
 * No string here names a command, a file, a config key or an address
 * (forbidden-pattern #12); the tests scan every one of them.
 */
import type {
  ConnectorAddConfig,
  ConnectorEntry,
  ConnectorScope,
  ConnectorSignInOutcome,
  ConnectorStatus,
  ConnectorSuggestion,
} from '../../shared/connectors'
import { suggestionFingerprint } from '../../shared/connectors'

// ── Fixed strings ───────────────────────────────────────────────────────────

export const CONNECTORS_TITLE = 'Connectors'
export const CONNECTORS_DESCRIPTION =
  'Services the agent can use as tools. A connector belongs to an account, a project, or comes from your Claude.ai settings.'
export const ADD_CONNECTOR_LABEL = 'Add connector'
export const SHOWING_FOR_LABEL = 'Showing connectors for'
export const ONLY_THIS_PROJECT_TAG = 'Only this project'
export const NO_PROJECT_LINE = 'Open a project to see the connectors its conversations can use.'
export const EMPTY_LINE = 'No connectors are set up for this project yet.'
export const LOADING_LINE = 'Reading connectors…'
export const LIST_FAILED_LINE = 'Flow could not read the connectors right now. Try again in a moment.'
export const STATUS_UNREAD_LINE =
  'Flow could not check whether these connectors are working, so they are shown without a status.'
export const UNAVAILABLE_LINE = 'Connectors are not available in this version of Flow.'
export const WAITING_SIGN_IN_LINE = 'Finish signing in in your browser'
export const FINISH_ON_CLAUDE_AI_LINE = 'Finish signing in on Claude.ai, then press Retry.'
export const TOOLS_LABEL = 'Tools'
export const NO_TOOLS_LINE = 'No tools are listed until the connector is working.'
export const ASK_FIRST_LABEL = 'Ask first'
export const CANCEL_LABEL = 'Cancel'
export const ADD_LABEL = 'Add'
export const ADDING_LABEL = 'Adding…'
export const WORKING_LABEL = 'Working…'

export const FORM_LABELS = {
  name: 'Name',
  connectsBy: 'Connects by',
  web: 'Web address',
  program: 'Program on this computer',
  address: 'Address',
  programField: 'Program',
  args: 'Arguments',
  argsHint: 'Separated by spaces. Put an argument with spaces in quotes.',
  availableIn: 'Available in',
} as const

export type ConnectorAvailability = 'account' | 'project-local' | 'project-shared'

export const AVAILABILITY_LABELS: Record<ConnectorAvailability, string> = {
  account: 'Every project on this account',
  'project-local': 'Only this project',
  'project-shared': 'This project, shared with the team',
}

// ── Rows and sections ───────────────────────────────────────────────────────

export type PillTone = 'ok' | 'warn' | 'error' | 'neutral' | 'off'

export interface ConnectorPill {
  tone: PillTone
  label: string
}

/** The one main action a row offers. */
export type ConnectorRowAction = 'sign-in' | 'retry' | 'sign-out' | null

export const ACTION_LABELS: Record<Exclude<ConnectorRowAction, null>, string> = {
  'sign-in': 'Sign in',
  retry: 'Retry',
  'sign-out': 'Sign out',
}

export interface ConnectorRowTool {
  name: string
  askFirst: boolean
}

export interface ConnectorRow {
  name: string
  displayName: string
  /** One quiet line: the error sentence, else the tool count or state. */
  detail: string
  /** "Only this project", for a private connector listed with the account. */
  tag?: string
  pill: ConnectorPill
  action: ConnectorRowAction
  removable: boolean
  /** Where it is removed from when not removable, as a sentence. */
  managedElsewhere?: string
  /** Facts shown when the row opens. */
  facts: string[]
  tools: ConnectorRowTool[]
  /** What Remove sends back. */
  scope?: ConnectorScope
}

export type ConnectorSectionKey = 'account' | 'project' | 'claudeai' | 'plugin'

export interface ConnectorSection {
  key: ConnectorSectionKey
  heading: string
  rows: ConnectorRow[]
}

export interface SectionContext {
  /** The account's label, as the person named it. */
  accountLabel: string
  /** The project's display name. */
  projectName: string
}

const PILLS: Record<ConnectorStatus, ConnectorPill> = {
  connected: { tone: 'ok', label: 'Connected' },
  'needs-auth': { tone: 'warn', label: 'Needs sign-in' },
  failed: { tone: 'error', label: 'Not working' },
  pending: { tone: 'neutral', label: 'Starting' },
  disabled: { tone: 'off', label: 'Off' },
  off: { tone: 'off', label: 'Off' },
}

export function pillOf(status: ConnectorStatus): ConnectorPill {
  return PILLS[status] ?? PILLS.pending
}

/**
 * The one main action. Sign in when it asks; Retry when it failed; Sign out
 * only for a connected one that signs in at all (a program on this computer
 * never does); nothing otherwise.
 */
export function actionOf(entry: Pick<ConnectorEntry, 'status' | 'transport'>): ConnectorRowAction {
  switch (entry.status) {
    case 'needs-auth':
      return 'sign-in'
    case 'failed':
      return 'retry'
    case 'connected':
      return entry.transport === 'program' ? null : 'sign-out'
    default:
      return null
  }
}

function toolCount(count: number): string {
  return count === 1 ? '1 tool' : `${count} tools`
}

/** The quiet line under a row's name. */
export function detailOf(entry: Pick<ConnectorEntry, 'status' | 'error' | 'tools' | 'source'>): string {
  if (entry.error !== undefined && entry.error.trim() !== '') return entry.error
  switch (entry.status) {
    case 'connected':
      return toolCount(entry.tools.length)
    case 'needs-auth':
      return entry.source === 'claudeai' ? 'Sign in on Claude.ai to use it.' : 'Sign in to use it.'
    case 'failed':
      return 'This connector could not start.'
    case 'pending':
      return 'Starting…'
    case 'disabled':
      return entry.source === 'claudeai' ? 'Turned off on Claude.ai.' : 'Turned off.'
    case 'off':
      return 'Turned off for this conversation.'
  }
}

/** Where a connector Flow may not remove is managed, in plain words. */
export function managedElsewhereOf(entry: Pick<ConnectorEntry, 'source' | 'removable'>): string | undefined {
  if (entry.removable) return undefined
  switch (entry.source) {
    case 'claudeai':
      return 'This connector comes from your Claude.ai account. Add, remove or turn it on in your Claude.ai settings.'
    case 'plugin':
      return 'This connector comes with a plugin installed in Claude. It goes away when that plugin is removed.'
    default:
      return 'This connector is set up outside Flow, so Flow cannot remove it.'
  }
}

function connectsByFact(entry: Pick<ConnectorEntry, 'transport'>): string {
  switch (entry.transport) {
    case 'web':
      return 'Connects by web address'
    case 'program':
      return 'Runs as a program on this computer'
    case 'claudeai':
      return 'Connects through Claude.ai'
  }
}

function usedInFact(entry: Pick<ConnectorEntry, 'source' | 'scope'>, projectName: string): string {
  if (entry.scope === 'project-local') return `Used only in ${projectName}, just for you`
  if (entry.scope === 'project-shared' || entry.source === 'project') {
    return `Shared with the team in ${projectName}`
  }
  if (entry.source === 'plugin') return 'Used in every project where the plugin is installed'
  return 'Used in every project on this account'
}

export function rowOf(entry: ConnectorEntry, context: SectionContext): ConnectorRow {
  const managedElsewhere = managedElsewhereOf(entry)
  const askFirst = new Set(entry.askFirst)
  return {
    name: entry.name,
    displayName: entry.displayName,
    detail: detailOf(entry),
    ...(entry.scope === 'project-local' ? { tag: ONLY_THIS_PROJECT_TAG } : {}),
    pill: pillOf(entry.status),
    action: actionOf(entry),
    removable: entry.removable,
    ...(managedElsewhere !== undefined ? { managedElsewhere } : {}),
    facts: [connectsByFact(entry), usedInFact(entry, context.projectName)],
    tools: entry.tools.map((tool) => ({ name: tool.name, askFirst: askFirst.has(tool.name) })),
    ...(entry.scope !== undefined ? { scope: entry.scope } : {}),
  }
}

/** Which section an entry is listed in (see the header on project-local). */
export function sectionKeyOf(entry: Pick<ConnectorEntry, 'source' | 'scope'>): ConnectorSectionKey {
  if (entry.source === 'claudeai') return 'claudeai'
  if (entry.source === 'plugin') return 'plugin'
  if (entry.scope === 'project-shared') return 'project'
  if (entry.scope === 'project-local' || entry.scope === 'account') return 'account'
  return entry.source === 'project' ? 'project' : 'account'
}

export function sectionHeading(key: ConnectorSectionKey, context: SectionContext): string {
  switch (key) {
    case 'account':
      return `${context.accountLabel} · every project on this account`
    case 'project':
      return `${context.projectName} · shared with the team`
    case 'claudeai':
      return 'From Claude.ai · the connectors on your Claude.ai account'
    case 'plugin':
      return 'From plugins'
  }
}

const SECTION_ORDER: readonly ConnectorSectionKey[] = ['account', 'project', 'claudeai', 'plugin']

/**
 * Entries → the sections to draw, in order, each sorted by name. A section
 * with nothing in it is left out. Within the account section, the account's
 * own connectors come before the ones kept for this project only.
 */
export function connectorSections(entries: readonly ConnectorEntry[], context: SectionContext): ConnectorSection[] {
  const grouped = new Map<ConnectorSectionKey, ConnectorEntry[]>()
  for (const entry of entries) {
    const key = sectionKeyOf(entry)
    const list = grouped.get(key) ?? []
    list.push(entry)
    grouped.set(key, list)
  }
  const out: ConnectorSection[] = []
  for (const key of SECTION_ORDER) {
    const list = grouped.get(key)
    if (list === undefined || list.length === 0) continue
    const sorted = [...list].sort((a, b) => {
      const localA = a.scope === 'project-local' ? 1 : 0
      const localB = b.scope === 'project-local' ? 1 : 0
      if (localA !== localB) return localA - localB
      return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
    })
    out.push({ key, heading: sectionHeading(key, context), rows: sorted.map((entry) => rowOf(entry, context)) })
  }
  return out
}

/** What a project's account is called in the headings. */
export function accountLabelOf(
  resolution: { status: 'legacy' } | { status: 'ready'; label: string } | { status: 'dangling' } | null,
): string {
  if (resolution !== null && resolution.status === 'ready' && resolution.label.trim() !== '') return resolution.label
  return 'Your Claude account'
}

// ── Suggested for <project> ─────────────────────────────────────────────────

export const SUGGESTED_SUBTEXT = 'not set up yet, and this project looks like it uses them'
export const NOT_NOW_LABEL = 'Not now'
/** At most this many suggestions are shown. */
export const MAX_SUGGESTIONS_SHOWN = 3

export function suggestedHeading(projectName: string): string {
  return `Suggested for ${projectName}`
}

export interface SuggestedRow {
  name: string
  displayName: string
  /** The one line saying why. */
  reason: string
}

export interface SuggestedSection {
  heading: string
  subtext: string
  rows: SuggestedRow[]
  /** Every fingerprint "Not now" keeps dismissed — the shown rows AND the ones past the cap, so the section stays hidden. */
  fingerprints: string[]
}

/**
 * The "Suggested for" section, or null when there is nothing to suggest.
 * `hidden` = fingerprints dismissed here and not yet re-read from main, so a
 * "Not now" hides the section at once. Rows that are no longer waiting for a
 * sign-in in the held list (`stillNeedsSignIn`) are left out too, so a
 * finished sign-in removes its row before the next read.
 */
export function suggestedSection(
  suggestions: readonly ConnectorSuggestion[],
  projectName: string,
  hidden: ReadonlySet<string> = new Set(),
  stillNeedsSignIn: (name: string) => boolean = () => true,
): SuggestedSection | null {
  const visible = suggestions.filter(
    (suggestion) => !hidden.has(suggestionFingerprint(suggestion)) && stillNeedsSignIn(suggestion.name),
  )
  if (visible.length === 0) return null
  return {
    heading: suggestedHeading(projectName),
    subtext: SUGGESTED_SUBTEXT,
    rows: visible
      .slice(0, MAX_SUGGESTIONS_SHOWN)
      .map((suggestion) => ({ name: suggestion.name, displayName: suggestion.displayName, reason: suggestion.reason })),
    fingerprints: visible.map((suggestion) => suggestionFingerprint(suggestion)),
  }
}

// ── Confirmations ───────────────────────────────────────────────────────────

export function removeLabel(displayName: string): string {
  return `Remove ${displayName}`
}

export function removeConfirmText(displayName: string): string {
  return `Remove ${displayName}? The agent stops using it in the places it was available.`
}

export function signOutConfirmText(displayName: string): string {
  return `Sign out of ${displayName}? The agent cannot use it until you sign in again.`
}

export const CONFIRM_REMOVE_LABEL = 'Remove'
export const CONFIRM_SIGN_OUT_LABEL = 'Sign out'

// ── Sign-in ─────────────────────────────────────────────────────────────────

/** The line a watched sign-in leaves behind when it ends, or null for none. */
export function signInOutcomeLine(outcome: ConnectorSignInOutcome): string | null {
  switch (outcome) {
    case 'connected':
    case 'cancelled':
      return null
    case 'timed-out':
      return 'Signing in took too long. Try again.'
    case 'failed':
      return 'Signing in did not finish. Try again.'
  }
}

// ── The add form ────────────────────────────────────────────────────────────

export type ConnectsBy = 'web' | 'program'

export interface AddFormInput {
  name: string
  connectsBy: ConnectsBy
  address: string
  program: string
  args: string
  availableIn: ConnectorAvailability
}

export type AddFormResult =
  | { ok: true; name: string; config: ConnectorAddConfig; scope: ConnectorScope }
  | { ok: false; problem: string; field: 'name' | 'address' | 'program' | 'args' }

/** The name Flow keeps for itself (main refuses it too; this says so early). */
const RESERVED_NAME = 'flow'
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Split an arguments line on spaces, keeping a quoted argument whole. Null
 * when a quote is left open.
 */
export function splitArgs(line: string): string[] | null {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      has = true
      continue
    }
    if (/\s/.test(ch)) {
      if (has) out.push(current)
      current = ''
      has = false
      continue
    }
    current += ch
    has = true
  }
  if (quote !== null) return null
  if (has) out.push(current)
  return out
}

/** Read the add form: a connector to add, or the first problem as a sentence. */
export function validateAddForm(input: AddFormInput, existingNames: readonly string[] = []): AddFormResult {
  const name = input.name.trim()
  if (name === '') return { ok: false, field: 'name', problem: 'Give the connector a name.' }
  if (name.toLowerCase() === RESERVED_NAME) {
    return { ok: false, field: 'name', problem: 'That name is reserved for Flow. Choose another name.' }
  }
  if (!NAME_PATTERN.test(name)) {
    return {
      ok: false,
      field: 'name',
      problem: 'A connector name uses letters, numbers, dashes and underscores only, up to 64 characters.',
    }
  }
  if (existingNames.some((existing) => existing.toLowerCase() === name.toLowerCase())) {
    return { ok: false, field: 'name', problem: 'A connector with that name is already set up. Choose another name.' }
  }
  const scope: ConnectorScope = input.availableIn
  if (input.connectsBy === 'web') {
    const address = input.address.trim()
    let url: URL | null = null
    try {
      url = new URL(address)
    } catch {
      url = null
    }
    if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname === '') {
      return { ok: false, field: 'address', problem: 'Enter the full web address of the connector.' }
    }
    const type = /\/sse\/?$/i.test(url.pathname) ? 'sse' : 'http'
    return { ok: true, name, scope, config: { type, url: address } }
  }
  const command = input.program.trim()
  if (command === '') return { ok: false, field: 'program', problem: 'Enter the program to run.' }
  const args = splitArgs(input.args)
  if (args === null) return { ok: false, field: 'args', problem: 'An argument has an opening quote with no closing one.' }
  return { ok: true, name, scope, config: args.length > 0 ? { type: 'stdio', command, args } : { type: 'stdio', command } }
}

/** Every fixed string, for the forbidden-pattern #12 scan. */
export const FIXED_STRINGS: readonly string[] = [
  CONNECTORS_TITLE,
  CONNECTORS_DESCRIPTION,
  ADD_CONNECTOR_LABEL,
  SHOWING_FOR_LABEL,
  ONLY_THIS_PROJECT_TAG,
  NO_PROJECT_LINE,
  EMPTY_LINE,
  LOADING_LINE,
  LIST_FAILED_LINE,
  STATUS_UNREAD_LINE,
  UNAVAILABLE_LINE,
  WAITING_SIGN_IN_LINE,
  FINISH_ON_CLAUDE_AI_LINE,
  TOOLS_LABEL,
  NO_TOOLS_LINE,
  ASK_FIRST_LABEL,
  CANCEL_LABEL,
  ADD_LABEL,
  ADDING_LABEL,
  WORKING_LABEL,
  CONFIRM_REMOVE_LABEL,
  CONFIRM_SIGN_OUT_LABEL,
  SUGGESTED_SUBTEXT,
  NOT_NOW_LABEL,
  ...Object.values(FORM_LABELS),
  ...Object.values(AVAILABILITY_LABELS),
  ...Object.values(ACTION_LABELS),
]
