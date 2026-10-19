// Integrations settings — paste/manage read-only tokens for GitHub, Jira, and
// Azure DevOps, used by the task list to import issues. Tokens are stored in
// main's CredentialsManager and NEVER read back (status returns connected +
// an identity hint only), so token fields always start empty.

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
import { isCliDerivedConnection } from './integration-connection'
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
  help: string
  fields: FieldDef[]
  /** Build the token input from field values (null → invalid/incomplete). */
  toToken: (values: Record<string, string>) => IntegrationTokenInput | null
  /** CLI logout command, for providers whose Connected state can come from a CLI
   *  login the app can't revoke (#419). Absent for token-only providers. */
  cliLogout?: string
  /** What the custom-list query language is called, for the field's label. */
  listSyntax: string
  /** An example query, shown as the field's placeholder. */
  listPlaceholder: string
}

const PROVIDERS: ProviderDef[] = [
  {
    provider: 'github',
    title: 'GitHub',
    help: "Reuses your gh CLI login if you're signed in (gh auth login). Otherwise paste a Personal Access Token with read access to issues.",
    fields: [{ key: 'pat', label: 'Personal Access Token', password: true, placeholder: 'ghp_…' }],
    toToken: (v) => (v['pat'] ? { provider: 'github', pat: v['pat'] } : null),
    cliLogout: 'gh auth logout',
    listSyntax: 'GitHub search',
    listPlaceholder: 'repo:acme/api is:issue is:open label:bug',
  },
  {
    provider: 'jira',
    title: 'Jira',
    help: 'Your Atlassian site, account email, and an API token.',
    fields: [
      { key: 'site', label: 'Site', placeholder: 'your-team.atlassian.net' },
      { key: 'email', label: 'Account email', placeholder: 'you@company.com' },
      { key: 'apiToken', label: 'API token', password: true, placeholder: '…' },
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
    help:
      'Your organisation and project, plus a Personal Access Token with read access to work items. ' +
      'Azure scopes a query to one project, so both are needed before Flow can list what is assigned to you.',
    fields: [
      { key: 'org', label: 'Organisation', placeholder: 'contoso' },
      { key: 'project', label: 'Project', placeholder: 'Orbit' },
      { key: 'pat', label: 'Personal Access Token', password: true, placeholder: '…' },
    ],
    // ORG AND PROJECT ARE REQUIRED NOW, and that is the fix for the sentence a
    // person hit trying to use the board's Remote column: "Azure DevOps needs
    // an organisation and project before it can list your work items." It was
    // true, and there was nowhere to say them.
    toToken: (v) =>
      v['pat'] && v['org'] && v['project']
        ? { provider: 'azure', pat: v['pat'], org: v['org'], project: v['project'] }
        : null,
    cliLogout: 'az logout',
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
 *  (#1069). Split out of #section so the state machine isn't a nested ternary. */
function pillLabel(status: IntegrationStatus | null): string {
  if (status === null) return 'Checking…'
  if (!status.connected) return 'Not connected'
  return status.identityHint ? `Connected · ${status.identityHint}` : 'Connected'
}

/** Pill modifier class for the same three states (pending / on / off). */
function pillClass(status: IntegrationStatus | null): string {
  if (status === null) return 'fl-int-pill pending'
  return status.connected ? 'fl-int-pill on' : 'fl-int-pill'
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
    // gh/az probes take ~5s on a machine with the CLIs installed, and until now
    // the panel spent that whole window as an empty box holding one sentence —
    // no spinner, no skeleton, nothing. It read as broken, which is exactly what
    // pushed users into closing and re-clicking (the #1068 duplication path).
    this.#paint(
      PROVIDERS.map(() => null),
      PROVIDERS.map(() => null),
      null,
    )

    // Resolve all providers CONCURRENTLY — status is non-blocking on main now
    // (#174), so there's no reason to serialize; paint in PROVIDERS order so
    // the layout stays deterministic regardless of which resolves first. The
    // list config rides along: it is a fast local read, so there is no reason
    // to make the query field wait on a second pass. The close-on-done toggle
    // (#1885) is a fast local read too, so it rides the same pass.
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
    const fragment = document.createDocumentFragment()
    const intro = document.createElement('div')
    intro.className = 'fl-settings-empty'
    intro.textContent =
      'Connect an issue tracker to import tasks. Tokens are stored locally and never leave your machine.'
    fragment.appendChild(intro)
    // The global behaviour toggle (#1885) — one preference for every tracker, so
    // it sits above the per-provider cards rather than inside any one of them.
    fragment.appendChild(this.#closeOnDoneToggle(closeOnDone))
    PROVIDERS.forEach((def, i) => {
      fragment.appendChild(this.#section(def, statuses[i] ?? null, configs[i] ?? null))
    })
    this.#body.replaceChildren(fragment)
  }

  /**
   * "Close the remote ticket when a task moves to Done" (#1885).
   *
   * A global, non-secret preference (default on), so it reads back and pre-checks.
   * `null` is the pending state — the checkbox is inert until the real value lands,
   * so a click in the probe window is not written against a value that has not
   * loaded. GitHub only closes today; the help text says so rather than implying
   * every tracker does (forbidden-pattern #12 — plain language, no config key).
   */
  #closeOnDoneToggle(enabled: boolean | null): HTMLElement {
    const section = document.createElement('div')
    section.className = 'fl-settings-section'

    const row = document.createElement('label')
    row.className = 'fl-int-toggle'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = enabled === true
    input.disabled = enabled === null
    const text = document.createElement('span')
    text.textContent = 'Close the remote ticket when a task moves to Done'
    row.append(input, text)
    section.appendChild(row)

    const help = document.createElement('div')
    help.className = 'fl-int-help'
    help.textContent =
      'When you move a task imported from a tracker into the Done column, Flow closes the ' +
      'original ticket. Only GitHub issues are closed today; Jira and Azure DevOps are left open.'
    section.appendChild(help)

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

    return section
  }

  /** One provider's card. `status === null` renders the pending (probing) state:
   *  a "Checking…" pill and inert controls — inert because the repaint that
   *  lands the real status replaces this DOM, so a token typed into a pending
   *  field would be silently discarded. */
  #section(
    def: ProviderDef,
    status: IntegrationStatus | null,
    config: IssueListConfig | null,
  ): HTMLElement {
    const pending = status === null
    const connected = status?.connected === true
    const hint = status?.identityHint

    const section = document.createElement('div')
    section.className = 'fl-settings-section'

    const heading = document.createElement('div')
    heading.className = 'fl-settings-heading fl-int-heading'
    const name = document.createElement('span')
    name.textContent = def.title
    const pill = document.createElement('span')
    pill.className = pillClass(status)
    pill.textContent = pillLabel(status)
    heading.append(name, pill)
    section.appendChild(heading)

    const help = document.createElement('div')
    help.className = 'fl-int-help'
    help.textContent = def.help
    section.appendChild(help)

    const inputs = new Map<string, HTMLInputElement>()
    for (const field of def.fields) {
      const row = document.createElement('label')
      row.className = 'fl-int-field'
      const label = document.createElement('span')
      label.textContent = field.label
      const input = document.createElement('input')
      input.type = field.password ? 'password' : 'text'
      input.className = 'fl-settings-input'
      input.placeholder = field.placeholder ?? ''
      input.disabled = pending
      row.append(label, input)
      section.appendChild(row)
      inputs.set(field.key, input)
    }

    const actions = document.createElement('div')
    actions.className = 'fl-int-actions'
    const save = document.createElement('button')
    save.type = 'button'
    save.className = 'fl-int-save'
    const saveLabel = connected ? 'Update token' : 'Connect'
    save.textContent = saveLabel
    save.disabled = pending
    // Clear the transient 'Fill every field' hint as soon as the user edits a
    // field, instead of leaving it stuck on the button (#217).
    for (const [, input] of inputs) {
      input.addEventListener('input', () => {
        if (save.textContent === 'Fill every field') save.textContent = saveLabel
      })
      // #1396: Enter in any Connect field does what the button does — the same
      // wiring as the Account name box (#1554: the original fix claimed the
      // whole settings family but only landed there), so validation, the
      // disabled state and the feedback contract stay the button's.
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

    if (connected && isCliDerivedConnection(hint)) {
      // The Connected state comes from a CLI login the app can't revoke, so a
      // Disconnect button would be a dead no-op (clearToken deletes a stored
      // token that isn't there, and status re-resolves the CLI login). Explain
      // it and point at the real logout instead (#419).
      const note = document.createElement('div')
      note.className = 'fl-int-cli-note'
      const logout = def.cliLogout ?? 'the CLI'
      note.textContent = `Connected through the CLI — run \`${logout}\` in a terminal to disconnect.`
      actions.appendChild(note)
    } else if (connected) {
      const disconnect = document.createElement('button')
      disconnect.type = 'button'
      disconnect.className = 'fl-int-disconnect'
      disconnect.textContent = 'Disconnect'
      disconnect.addEventListener('click', () => {
        this.#confirmDisconnect(disconnect, def, hint)
      })
      actions.appendChild(disconnect)
    }
    section.appendChild(actions)

    // THE CUSTOM LIST QUERY — only once the tracker is connected, because a list
    // needs a credential to read. Unlike the token, this is non-secret, so it is
    // read back and pre-filled (the token fields never are). It is a GLOBAL
    // preference; the board's Assigned / My list / Both selector is what turns it
    // on, so this only saves the query the selector will draw from.
    if (connected) section.appendChild(this.#listQueryField(def, config))

    return section
  }

  /**
   * The saved-query field for a provider's custom list.
   *
   * SAVED EXPLICITLY, not on every keystroke: a JQL/WIQL query is edited a
   * character at a time into an invalid state, and persisting each of those
   * would fire a board re-read against a half-written query. The button writes
   * the query (trimmed by the store); clearing it and saving removes the list,
   * which the board reads as "assigned only".
   */
  #listQueryField(def: ProviderDef, config: IssueListConfig | null): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'fl-int-list'

    const label = document.createElement('div')
    label.className = 'fl-int-list-label'
    label.textContent = `Custom list query (${def.listSyntax})`
    wrap.appendChild(label)

    const help = document.createElement('div')
    help.className = 'fl-int-help'
    // THE EXAMPLE STAYS VISIBLE. It used to live only in the input's
    // placeholder, which vanishes the instant the field has a value — so a
    // person who typed a wrong query had nothing left to compare it against.
    help.textContent =
      "A saved query in the tracker's own language. Pick it on the board with the " +
      `Assigned / My list / Both selector. For example: ${def.listPlaceholder}`
    wrap.appendChild(help)

    const input = document.createElement('textarea')
    input.className = 'fl-settings-input fl-int-list-input'
    input.rows = 2
    input.placeholder = def.listPlaceholder
    input.value = config?.query ?? ''
    wrap.appendChild(input)

    // THE GUARD NOTICE — a URL or repo-path pasted here is not a search, and
    // the board would silently draw free-text matches for it. We say so and
    // OFFER a scoped rewrite; we never apply it silently (allowed-pattern #22).
    const notice = document.createElement('div')
    notice.className = 'fl-int-list-notice'
    notice.hidden = true
    notice.setAttribute('role', 'status')
    wrap.appendChild(notice)

    // THE PREVIEW LINE — a count for the exact query, shown after a save, so a
    // divergence between what the query returns and what the user expected is
    // visible here rather than discovered later on the board. Fail-soft: a
    // failed preview shows its sentence, never a broken frame.
    const preview = document.createElement('div')
    preview.className = 'fl-int-list-preview'
    preview.hidden = true
    preview.setAttribute('role', 'status')
    wrap.appendChild(preview)

    const runPreview = (): void => {
      const query = input.value.trim()
      if (query.length === 0 || window.flow.integrations.previewList === undefined) {
        preview.hidden = true
        return
      }
      preview.hidden = false
      preview.textContent = 'Checking what this returns…'
      void window.flow.integrations
        .previewList({ provider: def.provider, query })
        .then((result) => {
          if (!result.ok) {
            preview.textContent = result.reason ?? 'Could not check this query.'
            return
          }
          const head = `${String(result.count)} ${result.count === 1 ? 'result' : 'results'}`
          preview.textContent =
            result.sample.length > 0 ? `${head} — e.g. ${result.sample.join('; ')}` : head
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
        const use = document.createElement('button')
        use.type = 'button'
        use.className = 'fl-int-list-fix'
        use.textContent = `Use ${verdict.suggestion}`
        use.addEventListener('click', () => {
          // PROPOSE, THEN APPLY ON THE CLICK — the user chose this value, so
          // now it is theirs; re-validate (it should clear) and let them Save.
          input.value = verdict.suggestion ?? ''
          if (save.textContent === 'Saved') save.textContent = 'Save list'
          revalidate()
          input.focus()
        })
        notice.appendChild(use)
      }
    }

    const save = document.createElement('button')
    save.type = 'button'
    save.className = 'fl-int-save'
    save.textContent = 'Save list'
    save.addEventListener('click', () => {
      save.disabled = true
      save.textContent = 'Saving…'
      void window.flow.integrations
        .setListConfig?.({ provider: def.provider, query: input.value })
        .then(() => {
          save.disabled = false
          save.textContent = 'Saved'
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
    // A pending "Saved" reverts to the verb as soon as the query is edited again,
    // the guard re-checks what is now in the field, and a now-stale preview (for
    // the previously-saved query) is cleared.
    input.addEventListener('input', () => {
      if (save.textContent === 'Saved') save.textContent = 'Save list'
      preview.hidden = true
      revalidate()
    })
    // Check whatever was pre-filled from the stored config on first paint.
    revalidate()
    const listActions = document.createElement('div')
    listActions.className = 'fl-int-actions'
    listActions.appendChild(save)
    wrap.appendChild(listActions)

    return wrap
  }

  /**
   * Swap Disconnect for an inline "Disconnect <provider>? [Cancel] [Disconnect]"
   * — the same gate #216 put on Remove account, for a stricter reason (#1505).
   *
   * A Claude login can be re-run; the button for it is right there. GitHub and
   * Atlassian show a PAT exactly ONCE at creation, so a user whose only copy
   * lived in this write-only field has to go mint a new one. The panel can
   * neither show what it is about to destroy nor give it back, which is
   * precisely when a single unconfirmed click is the wrong interface.
   */
  #confirmDisconnect(
    disconnectBtn: HTMLButtonElement,
    def: ProviderDef,
    hint: string | null | undefined,
  ): void {
    const confirm = document.createElement('div')
    confirm.className = 'fl-int-confirm'
    const label = document.createElement('span')
    label.className = 'fl-int-confirm-label'
    // Name the identity when there is one: "Disconnect Jira (me@acme.example)?"
    // is answerable in a way that "Disconnect Jira?" is not when several
    // accounts have been through this field.
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
            // Same signal as connecting: the board drops the Remote toggle now,
            // not on the next project switch.
            document.dispatchEvent(new CustomEvent('flow:integrations-changed'))
            this.#render()
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
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'fl-int-mini'
    if (danger) btn.classList.add('danger')
    btn.textContent = label
    btn.addEventListener('click', onClick)
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
    .fl-int-heading { display: flex; align-items: center; justify-content: space-between; }
    .fl-int-pill {
      padding: 1px 8px; border-radius: 9px; font-size: var(--fl-text-caption-size);
      text-transform: none; letter-spacing: 0; font-weight: var(--fl-text-ui-weight);
      color: var(--fl-color-text-secondary); background: var(--fl-color-surface-raised);
    }
    .fl-int-pill.on { color: var(--fl-color-success); background: var(--fl-color-accent-muted); }
    /* Probing (#1069) — a quiet pulse so the ~5s CLI wait reads as work in
       progress rather than as an empty panel. */
    .fl-int-pill.pending { animation: fl-int-probing 1.3s ease-in-out infinite; }
    @keyframes fl-int-probing { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
    /* Reduced motion: hold the pill at its mid opacity — the "Checking…" text
       still says work is in progress without the pulse. */
    @media (prefers-reduced-motion: reduce) {
      .fl-int-pill.pending { animation: none; opacity: 0.7; }
    }
    .fl-int-field input:disabled { opacity: 0.55; }
    .fl-int-save:disabled { opacity: 0.5; cursor: default; filter: none; }
    .fl-int-help { color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); margin: 2px 0 8px; }
    .fl-int-field { display: flex; flex-direction: column; gap: 3px; margin-bottom: var(--fl-space-sm); }
    .fl-int-field > span { color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); }
    .fl-int-actions { display: flex; gap: var(--fl-space-sm); margin-top: 2px; }
    .fl-int-save {
      border: var(--fl-border-width) solid var(--fl-color-accent); background: var(--fl-color-accent);
      color: #fff; border-radius: var(--fl-radius-sm); padding: 5px 12px; cursor: pointer;
      font-family: var(--fl-font-ui); font-size: var(--fl-text-ui-size);
    }
    .fl-int-save:hover:not(:disabled) { filter: brightness(1.08); }
    .fl-int-disconnect {
      border: var(--fl-border-width) solid var(--fl-color-border); background: transparent;
      color: var(--fl-color-text-secondary); border-radius: var(--fl-radius-sm); padding: 5px 12px; cursor: pointer;
      font-family: var(--fl-font-ui); font-size: var(--fl-text-ui-size);
    }
    .fl-int-disconnect:hover { color: var(--fl-color-error); border-color: var(--fl-color-error); }
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
    .fl-int-cli-note { color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); align-self: center; }
    .fl-int-toggle { display: flex; align-items: center; gap: var(--fl-space-sm); cursor: pointer; }
    .fl-int-toggle input { cursor: pointer; }
    .fl-int-toggle input:disabled { cursor: default; opacity: 0.55; }
    .fl-int-toggle > span { font-size: var(--fl-text-ui-size); color: var(--fl-color-text); }
    .fl-int-list { margin-top: var(--fl-space-sm); padding-top: var(--fl-space-sm); border-top: var(--fl-border-width) solid var(--fl-color-border); }
    .fl-int-list-label { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); margin-bottom: 2px; }
    .fl-int-list-input { width: 100%; box-sizing: border-box; resize: vertical; font-family: var(--fl-font-mono, monospace); margin-bottom: var(--fl-space-xs); }
    .fl-int-list-notice {
      display: flex; flex-wrap: wrap; align-items: center; gap: var(--fl-space-xs);
      font-size: var(--fl-text-caption-size); color: var(--fl-color-warning, var(--fl-color-text-secondary));
      margin-bottom: var(--fl-space-xs);
    }
    .fl-int-list-notice[hidden], .fl-int-list-preview[hidden] { display: none; }
    .fl-int-list-fix {
      border: var(--fl-border-width) solid var(--fl-color-border); background: transparent;
      color: var(--fl-color-text); border-radius: var(--fl-radius-sm); padding: 2px 8px; cursor: pointer;
      font-family: var(--fl-font-mono, monospace); font-size: var(--fl-text-caption-size);
    }
    .fl-int-list-preview { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); margin-bottom: var(--fl-space-xs); }
  `
  document.head.appendChild(style)
}
