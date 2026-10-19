/**
 * THE IO HALF OF SIGN-IN: bind a port, open the system browser, wait for one
 * callback, exchange the code.
 *
 * Everything that DECIDES anything lives in `oauth-desktop.ts` and is tested
 * there. This is the part that cannot be meaningfully unit-tested — a socket, a
 * browser, an HTTP round trip — so it is kept as thin and as boring as it can
 * be, and every dependency is injectable so the orchestration can still be
 * driven end to end without a provider.
 *
 * ── THE RULES THIS FILE EXISTS TO HOLD ──────────────────────────────────────
 *
 * ONE CALLBACK, THEN THE DOOR SHUTS. The server is closed the moment a
 * callback arrives, on every path including failure. A loopback listener left
 * running is a local endpoint any process on the machine can talk to.
 *
 * 127.0.0.1, NEVER 0.0.0.0. Binding the wildcard would accept the callback from
 * the network, which turns a local-only flow into a remote one.
 *
 * IT ALWAYS ENDS. A person who closes the browser tab, or never finishes,
 * leaves a promise nobody settles and a port nobody frees — so there is a
 * deadline, and it is enforced here rather than hoped for.
 *
 * THE BROWSER GETS A PAGE, NOT A BLANK. Whatever happens, the tab shows a
 * sentence in the person's own terms, because the alternative is a spinner that
 * never resolves and an app that silently knows better.
 */

import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'

import {
  authorizationUrl,
  judgeHandBack,
  createPkcePair,
  createState,
  judgeCallback,
  loopbackRedirectUri,
  type PkcePair,
} from './oauth-desktop'

export interface OAuthProviderConfig {
  authorizationEndpoint: string
  tokenEndpoint: string
  clientId: string
  scopes: readonly string[]
  /** Some providers insist on a fixed path; most accept anything. */
  redirectPath?: string
}

export interface SignInDeps {
  /** Opens a URL in the SYSTEM browser — Electron's `shell.openExternal`. */
  openExternal: (url: string) => Promise<void>
  /** Exchanges the authorization code. Injected so no provider is assumed. */
  exchange: (input: {
    tokenEndpoint: string
    clientId: string
    code: string
    verifier: string
    redirectUri: string
    /** The state this authorization ran under, so a server can retire it. */
    state: string
  }) => Promise<ExchangedToken>
  /** How long a person has to finish. */
  timeoutMs?: number
  /** Injected for tests; defaults to node's http server. */
  listen?: (handler: CallbackHandler) => Promise<BoundServer>
  /**
   * Let a SERVER mint the authorization URL and the state.
   *
   * Absent, this builds both itself — which is what every test of this module
   * does and what a provider spoken to directly would want. Present, the state
   * the callback is judged against is one a server issued and can retire, so a
   * replayed callback is refusable by something that keeps records. See the
   * ingest function's auth routes.
   *
   * It takes the redirect because the port is not known until the loopback has
   * bound, which is why this is a callback rather than a value.
   */
  begin?: (redirectUri: string) => Promise<{ url: string; state: string }>
}

export interface ExchangedToken {
  subject: string
  displayName: string | null
  token: string
  expiresAt: number | null
}

export type SignInOutcome =
  | { ok: true; identity: ExchangedToken }
  | { ok: false; reason: string }

export type CallbackHandler = (url: string) => { status: number; body: string }
export interface BoundServer {
  port: number
  /** What the socket is actually bound to — the security claim, checkable. */
  address: string
  close(): void
  /** Resolves with the first callback URL, or rejects on timeout/close. */
  firstCallback: Promise<string>
}

/** THE DEADLINE. Long enough to find a password, short enough to end. */
export const DEFAULT_TIMEOUT_MS = 5 * 60_000

/** What the browser tab says when it is done. No jargon, no next step. */
export const DONE_PAGE = (message: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Flow</title>` +
  `<body style="font:16px system-ui;padding:3rem;max-width:32rem;margin:auto">` +
  `<p>${message}</p><p style="color:#666">You can close this tab.</p></body>`

export async function signIn(
  config: OAuthProviderConfig,
  deps: SignInDeps,
): Promise<SignInOutcome> {
  const pkce: PkcePair = createPkcePair()
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // HELD, NOT CAPTURED. The handler below closes over this, and when a server
  // mints the state the real value is not known until after the port is bound —
  // which is after the handler exists. The handler only ever runs once a
  // callback arrives, which is strictly after `begin` has answered.
  const held = { state: createState() }
  // ONE JUDGEMENT, USED TWICE — by the page below and by the outcome further
  // down. Choosing it once is what keeps them from disagreeing.
  const judge = deps.begin === undefined ? judgeCallback : judgeHandBack

  let server: BoundServer
  try {
    server = await (deps.listen ?? listenOnLoopback)((url) => respondTo(url, held.state, judge))
  } catch {
    return { ok: false, reason: "Flow couldn't start the sign-in on this computer." }
  }

  try {
    const redirectUri = loopbackRedirectUri(server.port, config.redirectPath)
    let url: string
    if (deps.begin !== undefined) {
      const started = await deps.begin(redirectUri)
      held.state = started.state
      url = started.url
    } else {
      url = authorizationUrl({
        authorizationEndpoint: config.authorizationEndpoint,
        clientId: config.clientId,
        scopes: config.scopes,
        redirectUri,
        state: held.state,
        pkce,
      })
    }

    await deps.openExternal(url)

    const callbackUrl = await withDeadline(server.firstCallback, timeoutMs)
    if (callbackUrl === null) {
      return { ok: false, reason: 'The sign-in timed out. You can try again whenever you like.' }
    }

    const query = new URL(callbackUrl, 'http://127.0.0.1').searchParams
    // A SERVER-DRIVEN FLOW HANDS BACK A STATE, NOT A CODE. When `begin` is
    // present the server is the registered redirect party and has already done
    // the exchange; the app collects the result afterwards. Without it this is
    // a provider's own redirect and carries a code.
    const judged = judge(query, held.state)
    if (!judged.ok) return { ok: false, reason: judged.reason }

    const identity = await deps.exchange({
      tokenEndpoint: config.tokenEndpoint,
      clientId: config.clientId,
      code: 'code' in judged ? judged.code : '',
      verifier: pkce.verifier,
      redirectUri,
      state: held.state,
    })
    return { ok: true, identity }
  } catch {
    // A provider that is down, a network that is gone, a malformed token
    // response. None of them is something the person can act on beyond
    // retrying, and none of them may carry a provider's raw message into the UI.
    return { ok: false, reason: "The sign-in didn't complete. You can try again." }
  } finally {
    // ONE CALLBACK, THEN THE DOOR SHUTS — on every path, including the ones
    // that threw.
    try {
      server.close()
    } catch {
      // Already closed.
    }
  }
}

/**
 * The page the browser gets, judged the same way the outcome is.
 *
 * THE SAME WAY IS THE WHOLE POINT, and it stopped being true once: this kept
 * using `judgeCallback` — which requires a code — after `signIn` moved to
 * `judgeHandBack` for server-driven flows, which carry only a state. A real
 * sign-in then SUCCEEDED while the browser tab said "That sign-in could not be
 * completed", and the person reasonably believed it had failed.
 *
 * The docstring above already claimed these agreed. A claim is not a mechanism,
 * so the judgement is now passed IN rather than chosen again here.
 */
function respondTo(
  url: string,
  state: string,
  judge: (query: URLSearchParams, state: string) => { ok: boolean },
): { status: number; body: string } {
  const query = new URL(url, 'http://127.0.0.1').searchParams
  return judge(query, state).ok
    ? { status: 200, body: DONE_PAGE('Signed in. You can go back to Flow.') }
    : { status: 400, body: DONE_PAGE('That sign-in could not be completed.') }
}

/** Resolves null at the deadline rather than leaving a promise unsettled. */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Bind 127.0.0.1 on an OS-chosen port and wait for the first request. */
export async function listenOnLoopback(handler: CallbackHandler): Promise<BoundServer> {
  let resolveCallback: (url: string) => void = () => {}
  let rejectCallback: (error: Error) => void = () => {}
  const firstCallback = new Promise<string>((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })

  const server: Server = createServer((request, response) => {
    const url = request.url ?? '/'
    // A browser asks for the favicon on the same origin; answering it as the
    // callback would settle the flow with a URL carrying no code at all.
    if (url.startsWith('/favicon.ico')) {
      response.writeHead(404).end()
      return
    }
    const { status, body } = handler(url)
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
    response.end(body)
    resolveCallback(url)
  })

  server.on('error', (error) => rejectCallback(error))

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // 127.0.0.1 EXPLICITLY. The wildcard would accept this callback from the
    // network and turn a local-only flow into a remote one.
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address() as AddressInfo | null
  if (address === null) {
    server.close()
    throw new Error('the sign-in listener did not bind')
  }

  return {
    port: address.port,
    address: address.address,
    close: () => server.close(),
    firstCallback,
  }
}
