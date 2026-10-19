// Login assist (#972) — the shared in-flight sign-in UI for onboarding's
// Connect step and Settings' Add-account / Re-login flows. `claude auth login`
// always uses paste-the-code OAuth: it prints a fallback sign-in URL, then
// blocks on "Paste code here if prompted >" waiting for the authorization code
// on stdin. This widget listens to `accounts:loginEvent` and progressively
// renders: a status line → the fallback link → a code field + Submit/Cancel
// wired to `accounts.submitLoginCode` / `accounts.cancelLogin`.
//
// Dependency-free and DOM-only so both surfaces reuse it; styling reuses the
// globally-injected settings classes (both surfaces call injectSettingsStyles).

import {
  INITIAL_LOGIN_ASSIST_STATE,
  reduceLoginEvent,
  type AccountLoginEvent,
  type LoginAssistState,
} from './login-assist-model'

export interface LoginAssist {
  /** Unsubscribe from login events and clear the rendered UI. */
  dispose(): void
}

function statusLine(text: string): HTMLDivElement {
  const el = document.createElement('div')
  el.textContent = text
  el.style.color = 'var(--fl-color-text-secondary)'
  el.style.fontSize = 'var(--fl-text-ui-size)'
  el.style.marginTop = 'var(--fl-space-sm)'
  return el
}

/**
 * Mount the assist into `slot`. It immediately shows "Opening browser
 * sign-in…" and upgrades itself as `accounts:loginEvent`s arrive. The caller
 * disposes it when the surrounding add()/relogin() promise settles.
 */
export function mountLoginAssist(slot: HTMLElement): LoginAssist {
  let state: LoginAssistState = INITIAL_LOGIN_ASSIST_STATE
  let disposed = false

  const root = document.createElement('div')
  slot.appendChild(root)

  const render = (): void => {
    root.replaceChildren()
    root.appendChild(
      statusLine(
        state.awaitingCode
          ? 'Waiting for your authorization code…'
          : 'Opening browser sign-in…',
      ),
    )

    if (state.url !== null) {
      const linkRow = statusLine("If the browser didn't open, open: ")
      const anchor = document.createElement('a')
      anchor.href = state.url
      // target=_blank → main's setWindowOpenHandler → shell.openExternal
      // (same route as chat markdown links).
      anchor.target = '_blank'
      anchor.rel = 'noreferrer noopener'
      anchor.textContent = 'sign-in page'
      linkRow.appendChild(anchor)
      root.appendChild(linkRow)
    }

    if (state.awaitingCode) {
      const label = statusLine('Paste the authorization code from the browser:')
      root.appendChild(label)

      const row = document.createElement('div')
      row.style.display = 'flex'
      row.style.gap = 'var(--fl-space-xs)'
      row.style.marginTop = 'var(--fl-space-xs)'

      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'fl-settings-input'
      input.placeholder = 'Authorization code'
      input.setAttribute('aria-label', 'Authorization code')

      const submit = document.createElement('button')
      submit.type = 'button'
      submit.className = 'fl-settings-btn'
      submit.textContent = 'Submit code'
      const submitCode = (): void => {
        const code = input.value.trim()
        if (code.length === 0) {
          input.focus()
          return
        }
        submit.setAttribute('disabled', '')
        void window.flow.accounts
          .submitLoginCode({ code })
          .then(({ ok }) => {
            // Rejected = nothing was waiting (already finished / canceled) —
            // re-enable so a retry is possible if a new prompt arrives.
            if (!ok) submit.removeAttribute('disabled')
          })
          .catch(() => submit.removeAttribute('disabled'))
      }
      submit.addEventListener('click', submitCode)
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') submitCode()
      })

      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'fl-settings-btn'
      cancel.textContent = 'Cancel'
      cancel.addEventListener('click', () => {
        void window.flow.accounts.cancelLogin().catch(() => undefined)
      })

      row.appendChild(input)
      row.appendChild(submit)
      row.appendChild(cancel)
      root.appendChild(row)
      input.focus()
    }
  }

  render()

  const unsubscribe = window.flow.accounts.onLoginEvent((event: AccountLoginEvent) => {
    if (disposed) return
    const next = reduceLoginEvent(state, event)
    if (next === state) return
    state = next
    render()
  })

  return {
    dispose(): void {
      if (disposed) return
      disposed = true
      unsubscribe()
      root.remove()
    },
  }
}
