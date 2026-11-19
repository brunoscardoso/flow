/**
 * The renderer's one cache of connector lists (plan_connectors, Phase 6).
 *
 * Main's connector service owns the list; this keeps the LAST answer per
 * project (and chat), so the composer chip, the conversation's sign-in card and
 * every chat icon read one copy instead of each asking main (allowed-pattern
 * #14). It never polls:
 *
 *   - a list is read when a surface asks (`ensure` — the cached answer when it
 *     is still good; `refresh` — always);
 *   - `connectors:changed` only MARKS the concerned lists stale and tells the
 *     surfaces; each surface refetches only while it is on screen
 *     (allowed-pattern #17, forbidden-pattern #14).
 *
 * It also installs the app-wide icon loader and display names
 * (`connector-icon.ts`), so a chat's tool cards draw connector icons whether or
 * not a composer has opened. A chat card asks for the server part of a tool
 * name (`claude_ai_Linear`); the loader maps it to the configured name through
 * the same sanitising rule the label uses (`findConnectorEntry`).
 */
import type {
  ConnectorChangeEvent,
  ConnectorEntry,
  ConnectorIconTheme,
  ConnectorListAnswer,
} from '../../shared/connectors'
import type { FlowConnectorsApi } from '../../shared/ipc-contract'
import { getEffectiveTheme } from '../theme/theme-controller'
import { changeConcerns, findConnectorEntry, type ConnectorScopeKey } from './connector-chip-model'
import { setConnectorDisplayNames, setConnectorIconLoader } from './connector-icon'

export type { ConnectorScopeKey } from './connector-chip-model'

type ChangeListener = (event: ConnectorChangeEvent) => void

interface CachedList {
  scope: ConnectorScopeKey
  answer: ConnectorListAnswer
  stale: boolean
}

/** How many lists are remembered — one per project and open chat is plenty. */
const MAX_LISTS = 24

function keyOf(scope: ConnectorScopeKey): string {
  return `${scope.projectRoot}\u0000${scope.threadId ?? ''}`
}

/** On screen: attached, laid out, and the window not hidden. */
export function isOnScreen(element: Element): boolean {
  if (!element.isConnected) return false
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false
  return element.getClientRects().length > 0
}

class ConnectorStore {
  readonly #lists = new Map<string, CachedList>()
  readonly #inflight = new Map<string, Promise<ConnectorListAnswer>>()
  readonly #listeners = new Set<ChangeListener>()
  readonly #icons = new Map<string, Promise<string | null>>()
  #active: ConnectorScopeKey | null = null
  #started = false

  #api(): FlowConnectorsApi | undefined {
    return typeof window === 'undefined' ? undefined : window.flow?.connectors
  }

  /** Install the icon loader and subscribe once. Safe to call more than once. */
  start(): void {
    if (this.#started) return
    this.#started = true
    setConnectorIconLoader((name) => this.#loadIcon(name))
    const api = this.#api()
    if (api === undefined) return
    api.onChanged((event) => this.#onChanged(event))
  }

  /** The chat on screen — where a chat card's icon is looked up first. */
  setActive(scope: ConnectorScopeKey | null): void {
    this.#active = scope
  }

  /** The cached answer for a scope, stale or not. */
  get(scope: ConnectorScopeKey): ConnectorListAnswer | undefined {
    return this.#lists.get(keyOf(scope))?.answer
  }

  /** The cached answer is missing or a change made it stale. */
  isStale(scope: ConnectorScopeKey): boolean {
    return this.#lists.get(keyOf(scope))?.stale ?? true
  }

  /** The cached answer when it is still good, else a fresh read. */
  ensure(scope: ConnectorScopeKey): Promise<ConnectorListAnswer> {
    const cached = this.#lists.get(keyOf(scope))
    if (cached !== undefined && !cached.stale) return Promise.resolve(cached.answer)
    return this.refresh(scope)
  }

  /** Read the list now. Concurrent reads of one scope share one call. */
  refresh(scope: ConnectorScopeKey): Promise<ConnectorListAnswer> {
    const key = keyOf(scope)
    const running = this.#inflight.get(key)
    if (running !== undefined) return running
    const api = this.#api()
    if (api === undefined) return Promise.resolve({ entries: [] })
    const read = api
      .list(scope.threadId === undefined ? { projectRoot: scope.projectRoot } : { projectRoot: scope.projectRoot, threadId: scope.threadId })
      .catch((error: unknown): ConnectorListAnswer => {
        console.warn('flow: could not read the connectors', error)
        return { entries: this.#lists.get(key)?.answer.entries ?? [], error: 'Flow could not read the connectors.' }
      })
      .then((answer) => {
        this.#remember(key, scope, answer)
        return answer
      })
      .finally(() => {
        if (this.#inflight.get(key) === read) this.#inflight.delete(key)
      })
    this.#inflight.set(key, read)
    return read
  }

  /** Hear every change event (after the concerned lists are marked stale). */
  subscribe(listener: ChangeListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #remember(key: string, scope: ConnectorScopeKey, answer: ConnectorListAnswer): void {
    this.#lists.delete(key)
    this.#lists.set(key, { scope, answer, stale: false })
    while (this.#lists.size > MAX_LISTS) {
      const oldest = this.#lists.keys().next().value
      if (oldest === undefined) break
      this.#lists.delete(oldest)
    }
    this.#publishNames()
  }

  /** One display-name map from every remembered list; the active chat's wins. */
  #publishNames(): void {
    const names = new Map<string, string>()
    const active = this.#active === null ? undefined : this.#lists.get(keyOf(this.#active))
    for (const cached of this.#lists.values()) {
      for (const entry of cached.answer.entries) names.set(entry.name, entry.displayName)
    }
    for (const entry of active?.answer.entries ?? []) names.set(entry.name, entry.displayName)
    setConnectorDisplayNames(names.size === 0 ? undefined : names)
  }

  #onChanged(event: ConnectorChangeEvent): void {
    for (const cached of this.#lists.values()) {
      if (changeConcerns(event, cached.scope)) cached.stale = true
    }
    // An icon may arrive with a connector that was just added or signed in to.
    if (event.threadId === undefined || event.signIn !== undefined) this.#dropIcons(event.projectRoot)
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch (error) {
        console.error('flow: a connectors listener failed', error)
      }
    }
  }

  #dropIcons(projectRoot: string | undefined): void {
    if (projectRoot === undefined) {
      this.#icons.clear()
      return
    }
    const prefix = `${projectRoot}\u0000`
    for (const key of [...this.#icons.keys()]) if (key.startsWith(prefix)) this.#icons.delete(key)
  }

  /** Where a name is listed: the active chat's list first, then any other. */
  #locate(name: string): { projectRoot: string; entry: ConnectorEntry } | null {
    const ordered: CachedList[] = []
    const active = this.#active === null ? undefined : this.#lists.get(keyOf(this.#active))
    if (active !== undefined) ordered.push(active)
    for (const cached of this.#lists.values()) if (cached !== active) ordered.push(cached)
    for (const cached of ordered) {
      const entry = findConnectorEntry(cached.answer.entries, name)
      if (entry !== null) return { projectRoot: cached.scope.projectRoot, entry }
    }
    return null
  }

  async #loadIcon(name: string): Promise<string | null> {
    const api = this.#api()
    if (api === undefined) return null
    let found = this.#locate(name)
    // A chat card can draw before anything has listed the chat's connectors;
    // main resolves an icon only from a list it has read, so read it once.
    if (found === null && this.#active !== null && !this.#lists.has(keyOf(this.#active))) {
      await this.refresh(this.#active)
      found = this.#locate(name)
    }
    if (found === null) return null
    const theme: ConnectorIconTheme = getEffectiveTheme()
    const key = `${found.projectRoot}\u0000${found.entry.name}\u0000${theme}`
    let pending = this.#icons.get(key)
    if (pending === undefined) {
      pending = api
        .icon({ projectRoot: found.projectRoot, name: found.entry.name, theme })
        .then((answer) => answer.dataUri)
        .catch(() => null)
      this.#icons.set(key, pending)
    }
    return pending
  }
}

/** The app's one connector store. */
export const connectorStore = new ConnectorStore()

/** Install the icon loader and the change subscription (app start). */
export function initConnectorStore(): void {
  connectorStore.start()
}
