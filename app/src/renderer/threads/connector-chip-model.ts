/**
 * The composer's connectors chip and its per-chat list, as data
 * (plan_connectors, Phase 6). Pure and DOM-free: the app's renderer jest runs
 * CJS under a node environment, so everything the chip decides lives here and
 * the view only draws it.
 *
 * TWO MODES, ONE QUESTION ("is this connector on for this chat?"):
 *
 *   - thread: the chat exists. The answer is main's — an entry the chat turned
 *     off arrives with `offInThread: true` and `status: 'off'`.
 *   - draft: the new-chat page. No chat exists yet, so main's list carries no
 *     per-chat answer; the page keeps the names a person switched off and they
 *     are written onto the chat once it is created.
 *
 * A CONNECTOR THE RUNTIME REPORTS `disabled` IS OFF AND CANNOT BE SWITCHED ON.
 * `disabled` means the runtime itself has it switched off — a Claude.ai
 * connector that is not enabled on Claude.ai, which Flow does not manage (the
 * plan rules that out). Flow's per-chat switch only removes a connector from a
 * session; it cannot add one the runtime will not load. So the row shows an
 * off switch that cannot be pressed, with a sentence saying where it is turned
 * on — never a live switch that would flip and change nothing.
 *
 * THE LIST SHOWS WHAT THIS CHAT CAN USE, NOT EVERYTHING THE ACCOUNT KNOWS.
 * An account linked to Claude.ai can carry dozens of connectors nobody signed
 * in to; listing them all buried the few that work (user report, 2026-11-18).
 * A connector that needs sign-in or is off on Claude.ai is left out of the
 * list, the counts and the filter — Settings → Connectors lists everything,
 * suggests what fits the project, and is where those are signed in to. This
 * list holds only what is enabled (user decision, 2026-11-18).
 */
import type { ConnectorChangeEvent, ConnectorEntry, ConnectorSource } from '../../shared/connectors'
import { toolNameForm } from './connector-label'

/** What the right side of a row is. */
export type ConnectorRowControl = 'switch' | 'sign-in' | 'not-working'

export interface ConnectorChipRow {
  name: string
  displayName: string
  /** One line under the name: the tool count, or the status sentence. */
  detail: string
  control: ConnectorRowControl
  /** On for this chat. */
  on: boolean
  /** The switch can be pressed (false for a connector the runtime has off). */
  toggleable: boolean
}

export interface ConnectorChipGroup {
  source: ConnectorSource
  label: string
  rows: ConnectorChipRow[]
}

export interface ConnectorChipIcon {
  name: string
  displayName: string
}

export interface ConnectorChipView {
  /** False when the project has no connectors: the chip is not drawn. */
  visible: boolean
  onCount: number
  total: number
  /** The chip's label: "3 connectors", "1 connector". */
  label: string
  /** Up to three connectors that are on, by name. */
  icons: ConnectorChipIcon[]
  /** A connector that is on needs sign-in or is not working. */
  attention: boolean
  groups: ConnectorChipGroup[]
  /** A filter was typed and nothing matched it. */
  noMatch: boolean
  /** Connectors left out of the list (need sign-in, or off on Claude.ai). */
  hiddenCount: number
}

export interface ConnectorChipInput {
  entries: readonly ConnectorEntry[]
  mode: 'thread' | 'draft'
  /** draft mode: the names switched off on the new-chat page. */
  draftOff?: ReadonlySet<string>
  filter?: string
}

const MAX_ICONS = 3

const GROUP_ORDER: readonly ConnectorSource[] = ['account', 'project', 'claudeai', 'plugin']

const GROUP_LABEL: Record<ConnectorSource, string> = {
  account: 'This account',
  project: 'This project',
  claudeai: 'From Claude.ai',
  plugin: 'From a plugin',
}

function byName(a: { displayName: string }, b: { displayName: string }): number {
  return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
}

/** On for this chat, in either mode. A runtime-disabled connector is never on. */
export function connectorOn(entry: ConnectorEntry, mode: 'thread' | 'draft', draftOff?: ReadonlySet<string>): boolean {
  if (entry.status === 'disabled') return false
  if (mode === 'draft') return draftOff?.has(entry.name) !== true
  return entry.offInThread !== true && entry.status !== 'off'
}

/**
 * Usable here: it can run in this chat, or it did and this chat turned it off.
 * Needs sign-in and runtime-disabled are not — they belong to Settings.
 */
export function connectorUsable(entry: ConnectorEntry): boolean {
  if (entry.offInThread === true || entry.status === 'off') return true
  return entry.status === 'connected' || entry.status === 'pending' || entry.status === 'failed'
}

/** Needs a person: on, and asking for sign-in or not starting. */
function needsAttention(entry: ConnectorEntry, on: boolean): boolean {
  return on && (entry.status === 'needs-auth' || entry.status === 'failed')
}

function toolCount(count: number): string {
  if (count === 0) return 'No tools'
  return count === 1 ? '1 tool' : `${String(count)} tools`
}

function detailOf(entry: ConnectorEntry, on: boolean): string {
  switch (entry.status) {
    case 'needs-auth':
      if (!on) return 'Off for this chat'
      return entry.error ?? 'Needs you to sign in.'
    case 'failed':
      if (!on) return 'Off for this chat'
      return entry.error ?? 'This connector could not start.'
    case 'disabled':
      return entry.source === 'claudeai' ? 'Turned off on Claude.ai' : 'Turned off'
    case 'off':
      return 'Off for this chat'
    case 'pending':
      if (!on) return 'Off for this chat'
      return entry.tools.length > 0 ? toolCount(entry.tools.length) : 'Connecting'
    case 'connected':
      return on ? toolCount(entry.tools.length) : 'Off for this chat'
  }
}

function rowOf(entry: ConnectorEntry, mode: 'thread' | 'draft', draftOff: ReadonlySet<string> | undefined): ConnectorChipRow {
  const on = connectorOn(entry, mode, draftOff)
  let control: ConnectorRowControl = 'switch'
  if (on && entry.status === 'needs-auth') control = 'sign-in'
  else if (on && entry.status === 'failed') control = 'not-working'
  return {
    name: entry.name,
    displayName: entry.displayName,
    detail: detailOf(entry, on),
    control,
    on,
    toggleable: entry.status !== 'disabled',
  }
}

function matches(entry: ConnectorEntry, filter: string): boolean {
  if (filter === '') return true
  return entry.displayName.toLowerCase().includes(filter) || entry.name.toLowerCase().includes(filter)
}

/** The chip and its list, from the connector list and this chat's choices. */
export function connectorChipView(input: ConnectorChipInput): ConnectorChipView {
  const { entries, mode, draftOff } = input
  const filter = (input.filter ?? '').trim().toLowerCase()
  const usable = entries.filter(connectorUsable)
  const onEntries = usable.filter((entry) => connectorOn(entry, mode, draftOff))
  const onCount = onEntries.length
  const icons = [...onEntries]
    .sort(byName)
    .slice(0, MAX_ICONS)
    .map((entry) => ({ name: entry.name, displayName: entry.displayName }))
  const attention = usable.some((entry) => needsAttention(entry, connectorOn(entry, mode, draftOff)))
  const listed = usable

  const groups: ConnectorChipGroup[] = []
  for (const source of GROUP_ORDER) {
    const rows = listed
      .filter((entry) => entry.source === source && matches(entry, filter))
      .map((entry) => rowOf(entry, mode, draftOff))
      .sort(byName)
    if (rows.length > 0) groups.push({ source, label: GROUP_LABEL[source], rows })
  }

  return {
    visible: entries.length > 0,
    onCount,
    total: usable.length,
    label: onCount === 0 ? 'Connectors' : onCount === 1 ? '1 connector' : `${String(onCount)} connectors`,
    icons,
    attention,
    groups,
    noMatch: filter !== '' && usable.length > 0 && groups.length === 0,
    hiddenCount: entries.length - usable.length,
  }
}

/** The list's empty state when nothing is enabled for this chat, or null. */
export function emptySentence(view: Pick<ConnectorChipView, 'total'>): string | null {
  return view.total === 0 ? 'No connector is set up yet. Manage connectors to sign in to one.' : null
}

/** "2 of 5 on" — the popover's count. */
export function onOfTotal(view: Pick<ConnectorChipView, 'onCount' | 'total'>): string {
  return `${String(view.onCount)} of ${String(view.total)} on`
}

/**
 * The entry a name stands for. Chat surfaces ask for a connector by the
 * server part of its tool name (`claude_ai_Linear`); the list knows it by its
 * configured name (`claude.ai Linear`). An exact name wins; otherwise the
 * tool-name form is compared, with the same sanitising rule the label uses.
 */
export function findConnectorEntry(entries: readonly ConnectorEntry[], name: string): ConnectorEntry | null {
  const exact = entries.find((entry) => entry.name === name)
  if (exact !== undefined) return exact
  const form = toolNameForm(name)
  return entries.find((entry) => toolNameForm(entry.name) === form) ?? null
}

/** The scope a list was read for: a project, and a chat when one exists. */
export interface ConnectorScopeKey {
  projectRoot: string
  threadId?: string
}

/**
 * Whether a `connectors:changed` event may have changed the list read for a
 * scope.
 *
 *  - A chat's on/off (a threadId, no sign-in) changes that chat's list only.
 *  - A sign-in's end changes the connector's status for the whole project.
 *  - A write names only the project it was made from, but an account entry
 *    reaches every project — so an event with no chat concerns every scope.
 */
export function changeConcerns(event: ConnectorChangeEvent, scope: ConnectorScopeKey): boolean {
  if (event.signIn !== undefined) {
    return (
      event.projectRoot === undefined ||
      event.projectRoot === scope.projectRoot ||
      (event.threadId !== undefined && event.threadId === scope.threadId)
    )
  }
  if (event.threadId !== undefined) return scope.threadId === event.threadId
  return true
}

/** The sentence a watched sign-in that did not connect leaves behind, or null. */
export function signInOutcomeSentence(displayName: string, outcome: NonNullable<ConnectorChangeEvent['signIn']>['outcome']): string | null {
  switch (outcome) {
    case 'connected':
      return null
    case 'timed-out':
      return `Signing in to ${displayName} took too long. Try again.`
    case 'cancelled':
      return `Signing in to ${displayName} was stopped.`
    case 'failed':
      return `Signing in to ${displayName} did not finish. Try again.`
  }
}
