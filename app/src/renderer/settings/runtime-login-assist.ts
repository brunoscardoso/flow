// The in-app sign-in for an external runtime — the widget both surfaces mount.
//
// Same shape as Claude's login assist (accounts/login-assist.ts): a status
// line that upgrades itself as the tool speaks, a link that opens in the real
// browser, the device code to type there, and a Cancel that actually stops the
// child process. Rendering is a pure function of runtime-login-model's state.

import { initialRuntimeLoginState, reduceRuntimeLogin, type RuntimeLoginState } from './runtime-login-model'

export interface RuntimeLoginAssist {
  /** Stop listening and remove the UI. Does not cancel the login. */
  dispose(): void
}

export interface RuntimeLoginAssistOptions {
  /** Called when the sign-in ends, with the tool's own verdict. */
  onFinished(ok: boolean): void
}

function line(text: string): HTMLDivElement {
  const el = document.createElement('div')
  el.textContent = text
  el.style.cssText =
    'color:var(--fl-color-text-secondary);font-size:var(--fl-text-ui-size);margin-top:var(--fl-space-xs);'
  return el
}

/**
 * Mount the assist into `slot` and START the sign-in.
 *
 * The caller keeps the returned handle to tear the UI down; cancelling is a
 * button here, because the person who started it is the only one who knows
 * they have changed their mind.
 */
export function mountRuntimeLoginAssist(
  slot: HTMLElement,
  provider: string,
  options: RuntimeLoginAssistOptions,
): RuntimeLoginAssist {
  let state: RuntimeLoginState = initialRuntimeLoginState(provider)
  let disposed = false

  const root = document.createElement('div')
  slot.appendChild(root)

  const render = (): void => {
    root.replaceChildren()
    root.appendChild(line(state.status))

    if (state.url !== null && !state.finished) {
      const row = line('')
      const anchor = document.createElement('a')
      anchor.href = state.url
      // target=_blank → main's window-open handler → the real browser, the same
      // route chat links take.
      anchor.target = '_blank'
      anchor.rel = 'noreferrer noopener'
      anchor.textContent = 'Open the sign-in page'
      row.appendChild(anchor)
      root.appendChild(row)
    }

    if (state.code !== null && !state.finished) {
      const codeRow = line('Enter this code there: ')
      const code = document.createElement('code')
      code.textContent = state.code
      code.style.cssText =
        'font-family:var(--fl-font-mono);font-size:var(--fl-text-ui-size);padding:1px 4px;border-radius:3px;background:var(--fl-color-surface-2);'
      codeRow.appendChild(code)
      const copy = document.createElement('button')
      copy.type = 'button'
      copy.className = 'fl-settings-inline-btn'
      copy.textContent = 'Copy'
      copy.style.marginLeft = 'var(--fl-space-xs)'
      copy.addEventListener('click', () => {
        void navigator.clipboard?.writeText(state.code ?? '')
        copy.textContent = 'Copied'
      })
      codeRow.appendChild(copy)
      root.appendChild(codeRow)
    }

    if (!state.finished) {
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'fl-settings-inline-btn'
      cancel.textContent = 'Cancel'
      cancel.style.marginTop = 'var(--fl-space-xs)'
      cancel.addEventListener('click', () => {
        void window.flow.settings.cancelRuntimeLogin?.()
      })
      root.appendChild(cancel)
    }
  }

  render()

  const unsubscribe =
    window.flow.settings.onRuntimeLoginEvent?.((event) => {
      if (disposed || event.provider !== provider) return
      state = reduceRuntimeLogin(state, event)
      render()
    }) ?? (() => undefined)

  const start = window.flow.settings.startRuntimeLogin
  if (typeof start !== 'function') {
    state = { ...state, finished: true, ok: false, status: 'This build of Flow cannot sign in here.' }
    render()
    options.onFinished(false)
  } else {
    void start({ provider })
      .then((result) => {
        if (disposed) return
        // The invoke's own answer is the authority — the event may have been
        // missed (a reload, a late subscription), the exit code never is.
        state = reduceRuntimeLogin(state, {
          provider,
          kind: result.ok ? 'done' : 'error',
          ...(result.reason === undefined ? {} : { reason: result.reason }),
        })
        render()
        options.onFinished(result.ok)
      })
      .catch(() => {
        if (disposed) return
        state = { ...state, finished: true, ok: false, status: 'The sign-in could not be started.' }
        render()
        options.onFinished(false)
      })
  }

  return {
    dispose(): void {
      disposed = true
      unsubscribe()
      root.remove()
    },
  }
}
