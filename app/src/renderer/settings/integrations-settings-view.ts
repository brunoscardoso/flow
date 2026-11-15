// Integrations settings — paste/manage read-only tokens for GitHub, Jira, and
// Azure DevOps, used by the task list to import issues. Tokens are stored in
// main's CredentialsManager and NEVER read back (status returns connected +
// an identity hint only), so token fields always start empty.
//
// THE LAYOUT (2026-11-14, from the approved mockup): one card per tracker. A
// card's closed row says who it is connected as and whether a saved list
// exists, so the page reads as a list; opening it shows the account box (how
// it is connected, Replace token / Disconnect) and the saved-list box. A
// tracker that is not connected opens by itself, on its connect form. The
// close-on-done preference is a switch in its own section below the trackers.

import '../components'
import type {
  IntegrationProvider,
  IntegrationStatus,
  IntegrationTokenInput,
  IssueListConfig,
} from '../../shared/ipc-contract'
import {
  tokenClearFailedToast,
  tokenClearedToast,
  tokenSaveFailedToast,
  type SettingsToast,
} from './settings-feedback'
import { injectSettingsStyles } from './settings-view'
import { inspectListQuery } from './list-query-guard'
import { cardStartsOpen, cardSummary, isCliDerivedConnection } from './integration-connection'
import { submitOnEnter } from './submit-on-enter-dom'
import { isLatestRender } from './render-guard'

const OPEN_EVENT = 'flow:open-integrations'

interface FieldDef {
  key: string
  label: string
  password?: boolean
  placeholder?: string
}

interface ProviderDef {
  provider: IntegrationProvider
  title: string
  /** The letters on the card's badge. */
  badge: string
  /** One line saying what the tracker brings — the closed row of a card that is not connected. */
  blurb: string
  /** What connecting needs, above the connect form. Plain words: no command (forbidden #12). */
  help: string
  fields: FieldDef[]
  /** Build the token input from field values (null → invalid/incomplete). */
  toToken: (values: Record<string, string>) => IntegrationTokenInput | null
  /** What the custom-list query language is called. */
  listSyntax: string
  /** An example query, shown as the field's placeholder and under it. */
  listPlaceholder: string
}

const PROVIDERS: ProviderDef[] = [
  {
    provider: 'github',
    title: 'GitHub',
    badge: 'GH',
    blurb: 'Issues assigned to you, and any search you save.',
    help:
      'Flow uses the GitHub account you are signed in to on this computer when there is one. ' +
      'Otherwise paste a personal access token with read access to issues.',
    fields: [{ key: 'pat', label: 'Personal access token', password: true, placeholder: 'ghp_…' }],
    toToken: (v) => (v['pat'] ? { provider: 'github', pat: v['pat'] } : null),
    listSyntax: 'GitHub search',
    listPlaceholder: 'repo:acme/api is:issue is:open label:bug',
  },
  {
    provider: 'jira',
    title: 'Jira',
    badge: 'J',
    blurb: 'Tickets assigned to you on your Atlassian site.',
    help: 'Your Atlassian site, the email you sign in with, and an API token.',
    fields: [
      { key: 'site', label: 'Site', placeholder: 'your-team.atlassian.net' },
      { key: 'email', label: 'Account email', placeholder: 'you@company.com' },
      { key: 'apiToken', label: 'API token', password: true, placeholder: 'Paste an API token' },
    ],
    toToken: (v) =>
      v['site'] && v['email'] && v['apiToken']
        ? { provider: 'jira', site: v['site'], email: v['email'], apiToken: v['apiToken'] }
        : null,
    listSyntax: 'JQL',
    listPlaceholder: 'project = ACME AND statusCategory != Done ORDER BY updated DESC',
  },
  {
    provider: 'azure',
    title: 'Azure DevOps',
    badge: 'AZ',
    blurb: 'Work items assigned to you in one project.',
    help:
      'Azure scopes a query to one project, so Flow needs the organisation and the project, ' +
      'plus a personal access token with read access to work items.',
    fields: [
      { key: 'org', label: 'Organisation', placeholder: 'contoso' },
      { key: 'project', label: 'Project', placeholder: 'Orbit' },
      { key: 'pat', label: 'Personal access token', password: true, placeholder: 'Paste a token with read access to work items' },
    ],
    // ORG AND PROJECT ARE REQUIRED NOW, and that is the fix for the sentence a
    // person hit trying to use the board's Remote column: "Azure DevOps needs
    // an organisation and project before it can list your work items." It was
    // true, and there was nowhere to say them.
    toToken: (v) =>
      v['pat'] && v['org'] && v['project']
        ? { provider: 'azure', pat: v['pat'], org: v['org'], project: v['project'] }
        : null,
    listSyntax: 'WIQL',
    listPlaceholder:
      "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'Active' ORDER BY [System.ChangedDate] DESC",
  },
]

/**
 * Route every "connect a tracker" request to the Settings page's own group.
 *
 * THE OVERLAY IS GONE. Integrations were a modal you reached from Settings by
 * pressing a button — a door inside a door — and the user's own instruction was
 * to stop doing that: "don't show that 'manage integrations' when the user
 * click on integrations, show everything there". The provider sections are
 * rendered INTO the Settings page now (`mountIntegrations`), so the two other
 * callers of this event — the palette, and the board's "Connect GitHub" remedy
 * — open the page on that group instead of raising a dialog over it.
 */
export function initIntegrationsSettings(): void {
  if (!window.flow?.integrations) {
    console.warn('flow: integrations bridge missing — integrations settings disabled')
    return
  }
  document.addEventListener(OPEN_EVENT, () => {
    document.dispatchEvent(
      new CustomEvent('flow:open-settings', { detail: { group: 'integrations' } }),
    )
  })
}

/**
 * Render the provider sections into a host, and keep them live.
 *
 * ONE RENDERER, WHEREVER IT IS MOUNTED. What this used to be — an overlay class
 * owning its own chrome — is now the same paint into somebody else's element,
 * so the settings page shows the real thing rather than a button that opens it.
 * Returns a disposer, because the host is rebuilt on every settings render and
 * an orphaned probe must not paint into a node that has left the document.
 */
export function mountIntegrations(host: HTMLElement): () => void {
  injectSettingsStyles()
  injectIntegrationStyles()
  const view = new IntegrationsSettingsView(host)
  void view.open()
  return () => view.close()
}

/** Pill text for a provider's probe state. `null` = the status promise has not
 *  settled yet, which must READ as work-in-progress rather than as an absence
 *  (#1069). The identity lives on the card's summary line now, so the pill is
 *  the state alone. */
function pillLabel(status: IntegrationStatus | null): string {
  if (status === null) return 'Checking…'
  return status.connected ? 'Connected' : 'Not connected'
}

/** Pill modifier class for the same three states (pending / on / off). */
function pillClass(status: IntegrationStatus | null): string {
  if (status === null) return 'fl-int-pill pending'
  return status.connected ? 'fl-int-pill on' : 'fl-int-pill'
}

const CHEVRON_DOWN =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>'

function button(label: string, className: string, onClick?: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = className
  btn.textContent = label
  if (onClick !== undefined) btn.addEventListener('click', onClick)
  return btn
}

function div(className: string, text?: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

class IntegrationsSettingsView {
  #body: HTMLElement
  /**
   * Monotonic render generation — the #308 render guard, ported here (#1068).
   * `#render()` awaits the three `integrations:status` probes (which shell out
   * to the `gh` / `az` CLIs — ~5s with `gh` installed) before it can paint real
   * statuses. With no guard a superseded render still owned `#body` when it
   * resolved and appended ON TOP of the newer one: an impatient close/re-open
   * inside the probe window left two full copies of every provider section
   * (three cycles → nine), permanently, on the app's credential-entry surface.
   */
  #renderSeq = 0
  /** Cards a person opened or closed — kept across repaints (a save re-renders). */
  readonly #open = new Map<IntegrationProvider, boolean>()

  constructor(host: HTMLElement) {
    this.#body = host
  }

  async open(): Promise<void> {
    await this.#render()
  }

  /**
   * Stop painting.
   *
   * IT HAS NO CHROME TO HIDE any more — the host belongs to whoever mounted it.
   * What still matters is the render guard: a status probe shells out to the
   * `gh` / `az` CLIs, and one that resolves after the host has been replaced
   * would paint into a node that has left the document. Bumping the generation
   * retires it (#1068).
   */
  close(): void {
    this.#renderSeq++
  }

  async #render(): Promise<void> {
    const generation = ++this.#renderSeq

    // Paint the provider sections IMMEDIATELY in a pending state (#1069). The
    // gh/az probes take ~5s on a machine with the CLIs installed; an empty box
    // for that long read as broken and pushed people into closing and
    // re-clicking (the #1068 duplication path).
    this.#paint(
      PROVIDERS.map(() => null),
      PROVIDERS.map(() => null),
      null,
    )

    // Resolve all providers CONCURRENTLY — status is non-blocking on main now
    // (#174); paint in PROVIDERS order so the layout stays deterministic. The
    // list config and the close-on-done toggle (#1885) are fast local reads,
    // so they ride the same pass.
    const [statuses, configs, closeOnDone] = await Promise.all([
      Promise.all(
        PROVIDERS.map((def) =>
          window.flow.integrations
            .status({ provider: def.provider })
            .catch((): IntegrationStatus => ({ provider: def.provider, connected: false })),
        ),
      ),
      Promise.all(
        PROVIDERS.map((def) =>
          window.flow.integrations.getListConfig?.({ provider: def.provider }).catch(() => null) ??
          Promise.resolve(null),
        ),
      ),
      window.flow.integrations
        .getCloseOnDone?.({})
        .then((r) => r.enabled)
        .catch(() => true) ?? Promise.resolve(true),
    ])
    // A superseded render must not write into the panel — #308's contract (#1068).
    if (!isLatestRender(generation, this.#renderSeq)) return
    this.#paint(statuses, configs, closeOnDone)
  }

  /**
   * Swap the panel body atomically: build into a detached fragment and
   * `replaceChildren`, as `settings-view.#render()` does. Nothing is ever
   * cleared before its replacement exists, so there is no blank window and no
   * partially-appended state a competing render could interleave with.
   *
   * A `null` entry is a provider whose status has not landed yet.
   */
  #paint(
    statuses: readonly (IntegrationStatus | null)[],
    configs: readonly (IssueListConfig | null)[],
    closeOnDone: boolean | null,
  ): void {
    const page = div('fl-int-page')

    const intro = div('fl-int-intro')
    const title = document.createElement('h2')
    title.className = 'fl-int-title'
    title.textContent = 'Integrations'
    const sub = div(
      'fl-int-sub',
      'Connect your trackers so their tickets show on the Tasks board. Tokens stay on this computer.',
    )
    intro.append(title, sub)
    page.appendChild(intro)

    page.appendChild(div('fl-int-group-label', 'Trackers'))
    const cards = div('fl-int-cards')
    PROVIDERS.forEach((def, i) => {
      cards.appendChild(this.#card(def, statuses[i] ?? null, configs[i] ?? null))
    })
    page.appendChild(cards)

    // The global behaviour toggle (#1885) — one preference for every tracker, so
    // it sits in its own section rather than inside any one card.
    page.appendChild(div('fl-int-group-label', 'When a task is done'))
    page.appendChild(this.#closeOnDoneToggle(closeOnDone))

    const fragment = document.createDocumentFragment()
    fragment.appendChild(page)
    this.#body.replaceChildren(fragment)
  }

  /**
   * "Close the ticket in its tracker" (#1885), drawn as a switch.
   *
   * A global, non-secret preference (default on), so it reads back and pre-checks.
   * `null` is the pending state — the switch is inert until the real value lands,
   * so a click in the probe window is not written against a value that has not
   * loaded. GitHub only closes today; the help text says so rather than implying
   * every tracker does (forbidden-pattern #12 — plain language, no config key).
   */
  #closeOnDoneToggle(enabled: boolean | null): HTMLElement {
    // A <label>, so the whole row toggles; NOT a `.fl-settings-section` with a
    // heading — tests find provider cards by that shape.
    const row = document.createElement('label')
    row.className = 'fl-int-card fl-int-toggle'

    const text = div('fl-int-toggle-text')
    text.append(
      div('fl-int-toggle-title', 'Close the ticket in its tracker'),
      div(
        'fl-int-help',
        'Moving an imported task to Done closes the original ticket. ' +
          'Works for GitHub today; Jira and Azure DevOps tickets stay open.',
      ),
    )

    const input = document.createElement('input')
    input.type = 'checkbox'
    input.className = 'fl-int-switch'
    input.setAttribute('role', 'switch')
    input.checked = enabled === true
    input.disabled = enabled === null
    row.append(text, input)

    input.addEventListener('change', () => {
      const next = input.checked
      input.disabled = true
      void window.flow.integrations
        .setCloseOnDone?.({ enabled: next })
        .then((result) => {
          input.disabled = false
          // Trust the store's echo over the optimistic value.
          input.checked = result?.enabled ?? next
        })
        .catch((error: unknown) => {
          console.error('flow: setCloseOnDone failed', error)
          input.disabled = false
          input.checked = !next // revert
          this.#notify({
            title: "Couldn't save that setting",
            body: error instanceof Error ? error.message : String(error),
            level: 'error',
          })
        })
    })

    return row
  }

  /**
   * One tracker's card. `status === null` renders the pending (probing) state:
   * a "Checking…" pill and a closed card — closed because the repaint that
   * lands the real status replaces this DOM, so a token typed into a pending
   * field would be silently discarded.
   */
  #card(def: ProviderDef, status: IntegrationStatus | null, config: IssueListConfig | null): HTMLElement {
    const pending = status === null
    const connected = status?.connected === true

    // `.fl-settings-section` with a `.fl-settings-heading` — the shape the
    // end-to-end specs find a provider card by.
    const card = div(`fl-settings-section fl-int-card fl-int-${def.provider}`)

    const head = div('fl-settings-heading fl-int-heading')
    const badge = div('fl-int-badge', def.badge)
    badge.setAttribute('aria-hidden', 'true')
    const names = div('fl-int-names')
    names.append(
      div('fl-int-name', def.title),
      div(
        'fl-int-summary',
        cardSummary({
          title: def.title,
          blurb: def.blurb,
          connected: pending ? null : connected,
          identityHint: status?.identityHint ?? null,
          listQuery: config?.query ?? null,
        }),
      ),
    )
    const pill = document.createElement('span')
    pill.className = pillClass(status)
    pill.textContent = pillLabel(status)
    const toggle = button('', 'fl-int-chevron')
    toggle.innerHTML = CHEVRON_DOWN
    head.append(badge, names, pill, toggle)
    card.appendChild(head)

    const body = div('fl-int-body')
    if (!pending) {
      if (connected) {
        body.appendChild(this.#accountBox(def, status))
        body.appendChild(this.#listBox(def, config))
      } else {
        body.appendChild(div('fl-int-help', def.help))
        body.appendChild(this.#tokenForm(def, 'Connect'))
      }
    }
    card.appendChild(body)

    const setOpen = (open: boolean): void => {
      body.hidden = !open || pending
      card.classList.toggle('open', open && !pending)
      toggle.setAttribute('aria-expanded', String(open && !pending))
      toggle.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} ${def.title}`)
    }
    let open = this.#open.get(def.provider) ?? cardStartsOpen(pending ? null : connected)
    setOpen(open)
    toggle.disabled = pending
    const flip = (): void => {
      if (pending) return
      open = !open
      this.#open.set(def.provider, open)
      setOpen(open)
    }
    toggle.addEventListener('click', (event) => {
      event.stopPropagation()
      flip()
    })
    // The whole row opens the card, like the chevron does.
    head.addEventListener('click', flip)

    return card
  }

  /**
   * How a connected tracker is connected, and what can be done about it.
   *
   * A CLI sign-in the app reuses can't be revoked from here, so it gets no
   * Disconnect (it would be a dead no-op, #419) and no instruction to go type a
   * command (forbidden #12) — it offers a token instead. A stored token offers
   * Replace token and a confirmed Disconnect (#1505).
   */
  #accountBox(def: ProviderDef, status: IntegrationStatus | null): HTMLElement {
    const wrap = div('fl-int-block')
    const hint = status?.identityHint ?? undefined
    const viaSignIn = isCliDerivedConnection(hint)

    const box = div('fl-int-box')
    const text = div(
      'fl-int-box-text',
      viaSignIn
        ? `Flow uses the ${def.title} account you are already signed in to on this computer.`
        : 'Connected with a token saved on this computer.',
    )
    box.appendChild(text)

    const form = this.#tokenForm(def, 'Update token')
    form.hidden = true
    const reveal = button(viaSignIn ? 'Use a token instead' : 'Replace token', 'fl-int-secondary', () => {
      form.hidden = !form.hidden
      if (!form.hidden) form.querySelector('input')?.focus()
    })
    box.appendChild(reveal)

    if (!viaSignIn) {
      const disconnect = button('Disconnect', 'fl-int-disconnect')
      disconnect.addEventListener('click', () => {
        this.#confirmDisconnect(disconnect, def, hint)
      })
      box.appendChild(disconnect)
    }
    wrap.append(div('fl-int-block-label', 'Account'), box, form)
    return wrap
  }

  /** The token fields and their submit — connecting, or replacing a token. */
  #tokenForm(def: ProviderDef, saveLabel: string): HTMLElement {
    const form = div('fl-int-form')
    const grid = div('fl-int-fields')
    const inputs = new Map<string, HTMLInputElement>()
    for (const field of def.fields) {
      const row = document.createElement('label')
      row.className = field.password ? 'fl-int-field wide' : 'fl-int-field'
      const label = document.createElement('span')
      label.textContent = field.label
      const input = document.createElement('input')
      input.type = field.password ? 'password' : 'text'
      input.className = 'fl-settings-input'
      input.placeholder = field.placeholder ?? ''
      input.spellcheck = false
      row.append(label, input)
      grid.appendChild(row)
      inputs.set(field.key, input)
    }
    form.appendChild(grid)

    const actions = div('fl-int-actions')
    actions.appendChild(div('fl-int-note', 'Saved on this computer only.'))
    const save = button(saveLabel, 'fl-int-save')
    // Clear the transient 'Fill every field' hint as soon as the user edits a
    // field, instead of leaving it stuck on the button (#217).
    for (const [, input] of inputs) {
      input.addEventListener('input', () => {
        if (save.textContent === 'Fill every field') save.textContent = saveLabel
      })
      // #1396: Enter in any field does what the button does.
      submitOnEnter(input, save)
    }
    save.addEventListener('click', () => {
      const values: Record<string, string> = {}
      for (const [key, input] of inputs) values[key] = input.value.trim()
      const token = def.toToken(values)
      if (!token) {
        save.textContent = 'Fill every field'
        return
      }
      // Disable during the in-flight write (no double-submit); a successful save
      // re-renders the whole panel, a failure restores the button + toasts (#217).
      save.disabled = true
      save.textContent = 'Saving…'
      void window.flow.integrations
        .setToken(token)
        .then(() => {
          // The tasks board reads connection state; tell it a tracker just
          // connected so its Remote toggle appears without a project switch.
          document.dispatchEvent(new CustomEvent('flow:integrations-changed'))
          // The card closes on its connected summary, which says it worked.
          this.#open.delete(def.provider)
          return this.#render()
        })
        .catch((error: unknown) => {
          console.error('flow: setToken failed', error)
          save.disabled = false
          save.textContent = saveLabel
          this.#notify(tokenSaveFailedToast(def.provider, error))
        })
    })
    actions.appendChild(save)
    form.appendChild(actions)
    return form
  }

  /**
   * The saved list — only once the tracker is connected, because a list needs
   * a credential to read. Non-secret, so it is read back (the token never is).
   * It is a GLOBAL preference; the board's Assigned / My list / Both selector
   * turns it on, so this only saves the query the selector draws from.
   *
   * Read mode shows the query and Edit; edit mode is the field. SAVED
   * EXPLICITLY, not per keystroke: a JQL/WIQL query is edited a character at a
   * time into an invalid state, and persisting each would fire a board re-read
   * against a half-written query. Clearing it and saving removes the list.
   */
  #listBox(def: ProviderDef, config: IssueListConfig | null): HTMLElement {
    const wrap = div('fl-int-block fl-int-list')
    let saved = config?.query ?? ''

    const label = div('fl-int-block-label')
    const name = document.createElement('span')
    name.textContent = 'Saved list'
    const caption = document.createElement('span')
    caption.className = 'fl-int-caption'
    caption.textContent = `A ${def.listSyntax} query, shown on the board as “My list”.`
    label.append(name, caption)
    wrap.appendChild(label)

    // ── read mode ──
    const view = div('fl-int-box')
    const shown = div('fl-int-query')
    const edit = button('', 'fl-int-secondary')
    view.append(shown, edit)
    const showSaved = (): void => {
      shown.textContent = saved !== '' ? saved : 'No saved list yet.'
      shown.classList.toggle('empty', saved === '')
      edit.textContent = saved !== '' ? 'Edit' : 'Add a list'
    }
    showSaved()
    wrap.appendChild(view)

    // ── edit mode ──
    const editor = div('fl-int-editor')
    editor.hidden = true
    const input = document.createElement('textarea')
    input.className = 'fl-settings-input fl-int-list-input'
    input.rows = 3
    input.placeholder = def.listPlaceholder
    input.spellcheck = false
    editor.appendChild(input)
    // THE EXAMPLE STAYS VISIBLE. A placeholder vanishes the instant the field
    // has a value, so a person who typed a wrong query had nothing to compare.
    editor.appendChild(div('fl-int-help', `For example: ${def.listPlaceholder}`))

    // THE GUARD NOTICE — a URL or repo-path pasted here is not a search, and
    // the board would silently draw free-text matches for it. We say so and
    // OFFER a scoped rewrite; we never apply it silently (allowed-pattern #22).
    const notice = div('fl-int-list-notice')
    notice.hidden = true
    notice.setAttribute('role', 'status')
    editor.appendChild(notice)

    const editActions = div('fl-int-actions')
    editActions.appendChild(div('fl-int-note'))
    const cancel = button('Cancel', 'fl-int-secondary')
    const save = button('Save list', 'fl-int-save')
    editActions.append(cancel, save)
    editor.appendChild(editActions)
    wrap.appendChild(editor)

    // THE PREVIEW LINE — a count for the exact query, shown after a save, so a
    // divergence between what the query returns and what the user expected is
    // visible here rather than discovered later on the board. Fail-soft.
    const preview = div('fl-int-list-preview')
    preview.hidden = true
    preview.setAttribute('role', 'status')
    wrap.appendChild(preview)

    const runPreview = (): void => {
      const query = saved.trim()
      if (query.length === 0 || window.flow.integrations.previewList === undefined) {
        preview.hidden = true
        return
      }
      preview.hidden = false
      preview.classList.remove('ok')
      preview.textContent = 'Checking what this returns…'
      void window.flow.integrations
        .previewList({ provider: def.provider, query })
        .then((result) => {
          if (!result.ok) {
            preview.textContent = result.reason ?? 'Could not check this query.'
            return
          }
          const head = `This list finds ${String(result.count)} ${result.count === 1 ? 'ticket' : 'tickets'}`
          preview.classList.add('ok')
          preview.textContent = result.sample.length > 0 ? `${head} — e.g. ${result.sample.join('; ')}` : `${head}.`
        })
        .catch(() => {
          preview.textContent = 'Could not check this query.'
        })
    }

    const revalidate = (): void => {
      const verdict = inspectListQuery(def.provider, input.value)
      notice.textContent = ''
      if (!verdict.looksMalformedForSearch || verdict.reason === null) {
        notice.hidden = true
        return
      }
      notice.hidden = false
      const said = document.createElement('span')
      said.textContent = verdict.reason
      notice.appendChild(said)
      if (verdict.suggestion !== null) {
        const use = button(`Use ${verdict.suggestion}`, 'fl-int-list-fix', () => {
          // PROPOSE, THEN APPLY ON THE CLICK — the user chose this value.
          input.value = verdict.suggestion ?? ''
          revalidate()
          input.focus()
        })
        notice.appendChild(use)
      }
    }

    const setEditing = (editing: boolean): void => {
      view.hidden = editing
      editor.hidden = !editing
      if (editing) {
        input.value = saved
        preview.hidden = true
        revalidate()
        input.focus()
      }
    }
    edit.addEventListener('click', () => setEditing(true))
    cancel.addEventListener('click', () => setEditing(false))
    input.addEventListener('input', revalidate)
    save.addEventListener('click', () => {
      save.disabled = true
      save.textContent = 'Saving…'
      void window.flow.integrations
        .setListConfig?.({ provider: def.provider, query: input.value })
        .then(() => {
          save.disabled = false
          save.textContent = 'Save list'
          saved = input.value.trim()
          showSaved()
          setEditing(false)
          // Show what the just-saved query actually returns.
          runPreview()
        })
        .catch((error: unknown) => {
          console.error('flow: setListConfig failed', error)
          save.disabled = false
          save.textContent = 'Save list'
          this.#notify(tokenSaveFailedToast(def.provider, error))
        })
    })

    return wrap
  }

  /**
   * Swap Disconnect for an inline "Disconnect <provider>? [Cancel] [Disconnect]"
   * — the same gate #216 put on Remove account, for a stricter reason (#1505).
   *
   * GitHub and Atlassian show a PAT exactly ONCE at creation, so a user whose
   * only copy lived in this write-only field has to go mint a new one. The panel
   * can neither show what it is about to destroy nor give it back, which is
   * precisely when a single unconfirmed click is the wrong interface.
   */
  #confirmDisconnect(
    disconnectBtn: HTMLButtonElement,
    def: ProviderDef,
    hint: string | null | undefined,
  ): void {
    const confirm = div('fl-int-confirm')
    const label = document.createElement('span')
    label.className = 'fl-int-confirm-label'
    // Name the identity when there is one: "Disconnect Jira (me@acme.example)?"
    label.textContent = hint ? `Disconnect ${def.title} (${hint})?` : `Disconnect ${def.title}?`
    const cancel = this.#miniButton('Cancel', () => confirm.replaceWith(disconnectBtn))
    const yes = this.#miniButton(
      'Disconnect',
      () => {
        yes.disabled = true
        void window.flow.integrations
          .clearToken({ provider: def.provider })
          .then(() => {
            this.#notify(tokenClearedToast(def.provider))
            // Same signal as connecting: the board drops the Remote toggle now.
            document.dispatchEvent(new CustomEvent('flow:integrations-changed'))
            this.#open.delete(def.provider)
            void this.#render()
          })
          .catch((error: unknown) => {
            console.error('flow: clearToken failed', error)
            yes.disabled = false
            this.#notify(tokenClearFailedToast(def.provider, error))
          })
      },
      true,
    )
    confirm.append(label, cancel, yes)
    disconnectBtn.replaceWith(confirm)
  }

  /** A small inline button for the confirm row — mirrors the accounts panel's
   *  own helper so both confirms look and behave identically (#216, #1505). */
  #miniButton(label: string, onClick: () => void, danger = false): HTMLButtonElement {
    const btn = button(label, danger ? 'fl-int-mini danger' : 'fl-int-mini', onClick)
    return btn
  }

  /** Surface a toast via the flow:notify bridge (→ NotificationCenter) so a
   *  failed token save/clear isn't swallowed (#217). */
  #notify(toast: SettingsToast): void {
    document.dispatchEvent(
      new CustomEvent('flow:notify', {
        detail: {
          kind: 'state-change',
          rootId: '',
          title: toast.title,
          body: toast.body,
          timestamp: new Date().toISOString(),
          level: toast.level,
        },
      }),
    )
  }
}

let stylesInjected = false

function injectIntegrationStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-int-page { max-width: 760px; display: flex; flex-direction: column; gap: var(--fl-space-sm); }
    .fl-int-intro { display: flex; flex-direction: column; gap: 4px; margin-bottom: var(--fl-space-md, 12px); }
    .fl-int-title { margin: 0; font-size: var(--fl-text-heading-size, 16px); font-weight: var(--fl-text-ui-weight-medium, 600); color: var(--fl-color-text); }
    .fl-int-sub { color: var(--fl-color-text-secondary); font-size: var(--fl-text-ui-size); }
    .fl-int-group-label {
      margin-top: var(--fl-space-md, 12px);
      font-size: var(--fl-text-caption-size); font-weight: var(--fl-text-ui-weight-medium, 600);
      letter-spacing: 0.06em; text-transform: uppercase; color: var(--fl-color-text-secondary);
    }
    .fl-int-cards { display: flex; flex-direction: column; gap: var(--fl-space-sm); }

    .fl-int-card {
      margin: 0; background: var(--fl-color-surface-raised);
      border: var(--fl-border-width) solid var(--fl-color-border); border-radius: 10px; overflow: hidden;
    }
    /* The card's head reuses .fl-settings-heading for the specs' sake; undo
       that heading's caption look here. */
    .fl-int-card .fl-int-heading {
      display: flex; align-items: center; gap: 12px; margin: 0; padding: 12px 14px;
      text-transform: none; letter-spacing: 0; font-size: var(--fl-text-ui-size);
      font-weight: var(--fl-text-ui-weight); color: var(--fl-color-text); cursor: pointer;
    }
    .fl-int-badge {
      flex: none; width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center;
      font-weight: 600; font-size: 12px; background: var(--fl-color-bg); color: var(--fl-color-text);
      border: var(--fl-border-width) solid var(--fl-color-border);
    }
    .fl-int-jira .fl-int-badge, .fl-int-azure .fl-int-badge { color: var(--fl-color-accent); }
    .fl-int-names { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .fl-int-name { font-weight: var(--fl-text-ui-weight-medium, 600); }
    .fl-int-summary {
      color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .fl-int-pill {
      flex: none; padding: 2px 9px; border-radius: 10px; font-size: var(--fl-text-caption-size);
      color: var(--fl-color-text-secondary); background: var(--fl-color-bg);
    }
    .fl-int-pill.on { color: var(--fl-color-success); background: var(--fl-color-accent-muted); }
    /* Probing (#1069) — a quiet pulse so the ~5s CLI wait reads as work in progress. */
    .fl-int-pill.pending { animation: fl-int-probing 1.3s ease-in-out infinite; }
    @keyframes fl-int-probing { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) {
      .fl-int-pill.pending { animation: none; opacity: 0.7; }
      .fl-int-chevron svg { transition: none; }
    }
    .fl-int-chevron {
      flex: none; width: 28px; height: 28px; display: grid; place-items: center; padding: 0;
      background: transparent; border: 0; border-radius: var(--fl-radius-sm);
      color: var(--fl-color-text-secondary); cursor: pointer;
    }
    .fl-int-chevron:hover:not(:disabled) { color: var(--fl-color-text); background: var(--fl-color-bg); }
    .fl-int-chevron:disabled { opacity: 0.4; cursor: default; }
    .fl-int-chevron svg { transition: transform 120ms ease; }
    .fl-int-card.open .fl-int-chevron svg { transform: rotate(180deg); }

    .fl-int-body {
      display: flex; flex-direction: column; gap: 14px; padding: 14px;
      border-top: var(--fl-border-width) solid var(--fl-color-border);
    }
    .fl-int-body[hidden] { display: none; }
    .fl-int-block { display: flex; flex-direction: column; gap: 6px; }
    .fl-int-block-label { display: flex; align-items: baseline; gap: 8px; font-weight: var(--fl-text-ui-weight-medium, 600); }
    .fl-int-caption { font-weight: var(--fl-text-ui-weight); color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); }
    .fl-int-box {
      display: flex; align-items: center; gap: var(--fl-space-sm); padding: 10px 12px;
      background: var(--fl-color-bg); border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: 8px;
    }
    .fl-int-box[hidden] { display: none; }
    .fl-int-box-text { flex: 1; min-width: 0; color: var(--fl-color-text); }
    .fl-int-query {
      flex: 1; min-width: 0; font-family: var(--fl-font-mono, monospace); font-size: var(--fl-text-mono-size, 12px);
      color: var(--fl-color-text); overflow-wrap: anywhere;
    }
    .fl-int-query.empty { font-family: var(--fl-font-ui); color: var(--fl-color-text-secondary); }
    .fl-int-help { color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); line-height: 1.45; overflow-wrap: anywhere; }

    .fl-int-form { display: flex; flex-direction: column; gap: var(--fl-space-sm); }
    .fl-int-form[hidden], .fl-int-editor[hidden] { display: none; }
    .fl-int-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--fl-space-sm) 12px; }
    .fl-int-field { display: flex; flex-direction: column; gap: 4px; }
    .fl-int-field.wide, .fl-int-fields > .fl-int-field:only-child { grid-column: 1 / -1; }
    .fl-int-field > span { color: var(--fl-color-text); font-size: var(--fl-text-caption-size); font-weight: var(--fl-text-ui-weight-medium, 600); }
    .fl-int-field input { height: 30px; box-sizing: border-box; }
    .fl-int-field input:disabled { opacity: 0.55; }
    .fl-int-editor { display: flex; flex-direction: column; gap: 6px; }
    .fl-int-list-input { width: 100%; box-sizing: border-box; resize: vertical; font-family: var(--fl-font-mono, monospace); }
    .fl-int-actions { display: flex; align-items: center; gap: var(--fl-space-sm); }
    .fl-int-note { flex: 1; color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); }

    .fl-int-save, .fl-int-secondary, .fl-int-disconnect {
      flex: none; height: 28px; padding: 0 12px; border-radius: var(--fl-radius-sm); cursor: pointer;
      font-family: var(--fl-font-ui); font-size: var(--fl-text-ui-size);
    }
    .fl-int-save { border: 0; background: var(--fl-color-accent); color: #fff; font-weight: var(--fl-text-ui-weight-medium, 600); }
    .fl-int-save:hover:not(:disabled) { filter: brightness(1.08); }
    .fl-int-save:disabled { opacity: 0.5; cursor: default; filter: none; }
    .fl-int-secondary {
      border: var(--fl-border-width) solid var(--fl-color-border); background: transparent; color: var(--fl-color-text);
    }
    .fl-int-secondary:hover { border-color: var(--fl-color-accent); }
    .fl-int-disconnect {
      border: var(--fl-border-width) solid var(--fl-color-border); background: transparent; color: var(--fl-color-error);
    }
    .fl-int-disconnect:hover { border-color: var(--fl-color-error); }
    /* Own classes on purpose (#1505): the accounts panel's .fl-settings-btn is
       defined in ITS sheet, and redefining it from this one would silently
       restyle that panel from whichever <style> happened to land last. */
    .fl-int-confirm { display: flex; align-items: center; gap: var(--fl-space-xs); }
    .fl-int-confirm-label { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); }
    .fl-int-mini {
      border: var(--fl-border-width) solid var(--fl-color-border); background: transparent;
      color: var(--fl-color-text); border-radius: var(--fl-radius-sm); padding: 4px 10px; cursor: pointer;
      font-family: var(--fl-font-ui); font-size: var(--fl-text-caption-size);
    }
    .fl-int-mini:hover:not(:disabled) { border-color: var(--fl-color-accent); }
    .fl-int-mini:disabled { opacity: 0.5; cursor: default; }
    .fl-int-mini.danger { color: var(--fl-color-error); border-color: var(--fl-color-error); }

    .fl-int-list-notice {
      display: flex; flex-wrap: wrap; align-items: center; gap: var(--fl-space-xs);
      font-size: var(--fl-text-caption-size); color: var(--fl-color-warning, var(--fl-color-text-secondary));
    }
    .fl-int-list-notice[hidden], .fl-int-list-preview[hidden] { display: none; }
    .fl-int-list-fix {
      border: var(--fl-border-width) solid var(--fl-color-border); background: transparent;
      color: var(--fl-color-text); border-radius: var(--fl-radius-sm); padding: 2px 8px; cursor: pointer;
      font-family: var(--fl-font-mono, monospace); font-size: var(--fl-text-caption-size);
    }
    .fl-int-list-preview { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); }
    .fl-int-list-preview.ok { color: var(--fl-color-success); }

    .fl-int-toggle { display: flex; align-items: center; gap: 14px; padding: 12px 14px; cursor: pointer; }
    .fl-int-toggle-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .fl-int-toggle-title { font-weight: var(--fl-text-ui-weight-medium, 600); color: var(--fl-color-text); }
    .fl-int-switch {
      flex: none; appearance: none; -webkit-appearance: none; margin: 0; cursor: pointer;
      width: 34px; height: 20px; border-radius: 10px; position: relative;
      background: var(--fl-color-border); transition: background 120ms ease;
    }
    .fl-int-switch::after {
      content: ''; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px;
      border-radius: 7px; background: #fff; transition: left 120ms ease;
    }
    .fl-int-switch:checked { background: var(--fl-color-accent); }
    .fl-int-switch:checked::after { left: 17px; }
    .fl-int-switch:focus-visible { outline: 2px solid var(--fl-color-focus-ring, var(--fl-color-accent)); outline-offset: 2px; }
    .fl-int-switch:disabled { opacity: 0.5; cursor: default; }
  `
  document.head.appendChild(style)
}
