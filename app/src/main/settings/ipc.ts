// App-wide settings IPC (#48) — onboarding completion + autonomy default, over
// the settings:* channels. Backed by AppSettingsStore (the app_settings table).

import { shouldAskForConsent } from '../../shared/consent-prompt'
import { ipcMain } from 'electron'

import type {
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
  OnboardingState,
  RuntimeLoginProgress,
} from '../../shared/ipc-contract'
import type { AppSettingsStore } from '../store/app-settings-store'
import { isKnownProvider } from '../agent/runtime/runtime-registry'
import { readProjectProvider, resolveProjectProviderChoice } from '../agent/runtime/project-provider'
import { checkRuntimeAuth } from '../agent/runtime/runtime-auth'
import { installRuntime } from '../agent/runtime/runtime-install'
import { cancelRuntimeLogin, startRuntimeLogin } from '../agent/runtime/runtime-login'
import { signOutRuntime } from '../agent/runtime/runtime-logout'
import { readConfiguredModel } from '../agent/runtime/runtime-credentials'
import {
  candidateRuntimeModels,
  discoverRuntimeModels,
} from '../agent/runtime/runtime-model-discovery'
import { fetchCopilotCatalog, type CopilotCatalogModel } from '../agent/runtime/copilot-catalog'

export interface SettingsChannelDependencies {
  appSettings: AppSettingsStore
  /**
   * The signed-in identity, when this build has one (client-sign-in).
   *
   * Optional throughout: a harness without it, and a build with no provider,
   * both behave as "signed out", which is a complete state.
   */
  identity?: {
    load(): { subject: string; displayName: string | null } | null
    signOut(): { removed: boolean; detail: string }
  }
  signIn?: () => Promise<
    { ok: true; subject: string; displayName: string | null } | { ok: false; reason: string }
  >
  signInAvailable?: () => boolean
  /** Push a runtime sign-in's progress to the window that asked for it. */
  broadcast?: (channel: 'settings:runtimeLoginEvent', payload: RuntimeLoginProgress) => void
  /** How many Claude accounts are connected — the Claude runtime's own answer
   *  to "is this signed in", asked without spawning anything. */
  claudeAccountCount?: () => number
}

/** Register the settings:* invoke handlers. Returns a dispose function. */
export function registerSettingsChannels(deps: SettingsChannelDependencies): () => void {
  const { appSettings } = deps
  const registered: IpcInvokeChannel[] = []

  function handle<C extends IpcInvokeChannel>(
    channel: C,
    handler: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>,
  ): void {
    registered.push(channel)
    ipcMain.handle(channel, (_event, request: IpcRequest<C>) => handler(request))
  }

  handle('settings:getOnboarding', (): OnboardingState => ({
    completed: appSettings.getOnboardingCompleted(),
    autonomyBypassDefault: appSettings.getAutonomyBypassDefault(),
  }))

  handle('settings:setOnboarding', ({ completed, autonomyBypassDefault }) => {
    if (completed !== undefined) appSettings.setOnboardingCompleted(completed)
    if (autonomyBypassDefault !== undefined) {
      appSettings.setAutonomyBypassDefault(autonomyBypassDefault)
    }
  })

  // Consent. `null` until somebody is asked — see the contract for why that is
  // a third state and not a no.
  handle('settings:getTelemetryConsent', () => appSettings.getTelemetryConsent())
  // THE DECISION IS MAIN'S. It holds the use-day count and the ask count, so a
  // renderer cannot decide to raise a question somebody has already answered.
  handle('settings:shouldAskTelemetry', () =>
    shouldAskForConsent({
      consent: appSettings.getTelemetryConsent(),
      useDays: appSettings.getUseDays(),
      timesAsked: appSettings.getConsentAsks(),
    }),
  )
  handle('settings:recordTelemetryAsk', () => {
    appSettings.recordConsentAsk()
  })

  // ── SIGN-IN ───────────────────────────────────────────────────────────────
  //
  // SUBJECT AND DISPLAY NAME ONLY. The token stays in main, which is the
  // contract's own credentials invariant, and is why `whoAmI` builds a fresh
  // object rather than returning what the store holds.
  handle('auth:whoAmI', () => {
    const identity = deps.identity?.load() ?? null
    if (identity === null) return null
    return { subject: identity.subject, displayName: identity.displayName }
  })
  handle('auth:available', () => deps.signInAvailable?.() ?? false)
  handle('auth:signIn', async () => {
    if (deps.signIn === undefined) {
      return { ok: false as const, reason: 'Sign-in is not available in this build of Flow.' }
    }
    return deps.signIn()
  })
  handle('auth:signOut', () => {
    const report = deps.identity?.signOut()
    return report ?? { removed: false, detail: 'You were already signed out on this computer.' }
  })
  handle('settings:setTelemetryConsent', ({ agreed }) => {
    appSettings.setTelemetryConsent(agreed)
  })
  handle('settings:getModelRouting', () => appSettings.getModelRouting())
  handle('settings:setModelRouting', ({ routing }) => appSettings.setModelRouting(routing))

  // The person's worktree defaults — the layer a project inherits until it
  // sets a value of its own. Read and written whole so the panel that just
  // changed one of them never has to guess what the record now holds.
  handle('settings:getWorktreeDefaults', () => ({
    defaults: appSettings.getWorktreeDefaults(),
  }))
  handle('settings:setWorktreeDefaults', ({ patch }) => {
    appSettings.setWorktreeDefaults(patch)
    return { defaults: appSettings.getWorktreeDefaults() }
  })

  // Which provider a specific project resolves to, and which rung answered.
  // Mirrors resolveProvider's precedence (project override ?? global default ??
  // legacy 'claude'); `source` comes from WHICH level answered — key presence,
  // never a value comparison — so a project that merely inherits never reads as
  // pinned. Fail-closed: an unknown project override is skipped (as the resolver
  // would throw on it) rather than reported as a pinned provider.
  handle('settings:getProjectProvider', ({ rootPath }) =>
    resolveProjectProviderChoice(
      readProjectProvider(rootPath),
      appSettings.getDefaultProvider(),
      isKnownProvider,
    ),
  )

  handle('settings:getDefaultProvider', () => ({ provider: appSettings.getDefaultProvider() }))
  handle('settings:setDefaultProvider', ({ provider }) => {
    // Fail-closed: ignore an unknown provider id rather than persisting a value
    // that would later throw at thread creation (resolveProvider validates too).
    if (isKnownProvider(provider)) appSettings.setDefaultProvider(provider)
  })

  // THE GATE IN FRONT OF THAT WRITE. The renderer asks before it saves, so a
  // runtime nobody has authenticated is refused at the moment it is chosen
  // rather than at the first turn, minutes later, in a CLI's stderr.
  handle('settings:checkRuntimeAuth', ({ provider }) =>
    checkRuntimeAuth(provider, {
      ...(deps.claudeAccountCount === undefined
        ? {}
        : { claudeAccountCount: deps.claudeAccountCount }),
    }),
  )

  // The other half of that gate: a refusal you can act on. Install only — the
  // sign-in is interactive and stays in the terminal.
  handle('settings:installRuntime', ({ provider }) => installRuntime(provider))

  // THE SIGN-IN, IN THE APP. The URL and code the tool prints are relayed as
  // they appear, so the panel can show them the way Claude's own login does —
  // rather than handing the user a terminal and calling that an answer.
  handle('settings:startRuntimeLogin', ({ provider }) =>
    startRuntimeLogin(provider, (event) => deps.broadcast?.('settings:runtimeLoginEvent', event)),
  )
  handle('settings:cancelRuntimeLogin', () => {
    cancelRuntimeLogin()
  })
  // `confirmed` because the Copilot path deletes a credential rather than
  // running a tool's own logout — the renderer only calls this after its own
  // confirmation, and the flag makes an accidental call a no-op.
  handle('settings:signOutRuntime', ({ provider }) => signOutRuntime(provider, { confirmed: true }))

  // The models a runtime can be asked for: the one its own config already
  // names, plus whatever the user has added — and, for Copilot, its LIVE
  // catalogue (#1929), the same `/models` list its own IDE shows.
  handle('settings:getRuntimeModels', async ({ provider }) => {
    const models = appSettings.getRuntimeModels(provider)
    // Copilot's live catalogue, when Flow can read it: the account's current
    // per-plan model set WITH context windows. Empty on any failure (no token,
    // non-macOS, network down, moved schema) — the lists below then stand
    // alone, exactly as before this existed.
    const catalog: CopilotCatalogModel[] = provider === 'copilot' ? await fetchCopilotCatalog() : []
    // The runtime's own records: its configured default, plus what its recent
    // sessions actually ran under, plus the live catalogue's ids. Anything
    // already on the user's list is not a suggestion any more.
    const configured = readConfiguredModel(provider)
    const suggested = [
      ...(configured === null ? [] : [configured]),
      // What Flow WATCHED it run — certainly this account's — then the live
      // catalogue, then the db/rollout discovery.
      ...appSettings.getSeenRuntimeModels(provider),
      ...catalog.map((entry) => entry.id),
      ...discoverRuntimeModels(provider),
    ].filter((model, index, all) => all.indexOf(model) === index && !models.includes(model))
    // Candidates are the hand-kept "worth trying" set — only offered for what
    // the live catalogue did NOT already name, so a real catalogue quietly
    // retires the guesses.
    const catalogIds = new Set(catalog.map((entry) => entry.id))
    const candidates = candidateRuntimeModels(provider).filter(
      (model) => !models.includes(model) && !suggested.includes(model) && !catalogIds.has(model),
    )
    const contextPreferences = appSettings.getModelContextPreferences(provider)
    return { models, suggested, candidates, catalog, contextPreferences }
  })
  handle('settings:setRuntimeModels', ({ provider, models }) => {
    appSettings.setRuntimeModels(provider, models)
  })
  handle('settings:setModelContext', ({ provider, model, context }) => {
    appSettings.setModelContextPreference(provider, model, context)
  })

  return function disposeSettingsChannels(): void {
    for (const channel of registered) {
      ipcMain.removeHandler(channel)
    }
    registered.length = 0
  }
}
