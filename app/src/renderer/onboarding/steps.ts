// Onboarding wizard steps (#48, Phase 4) — the five StepViews, each delegating
// to existing IPC (accounts / project / flow / settings). Kept in one module;
// the shell (wizard-view) and gating (wizard-controller) are separate.

import { signInCopy, signInStateFrom } from '../settings/sign-in-model'
import { mountLoginAssist } from '../accounts/login-assist'
import { baseName } from '../project-label'
import { markLoginInFlight, settleLogin, WIZARD_LOGIN_SURFACE } from '../accounts/login-inflight'
import { FLOW_SETTINGS_SECTIONS, readValues } from '../settings/flow-settings-model'
import { markRootOnboarded } from '../settings/flow-settings-view'
import { openConnectRemoteDialog, openJoinDialog } from '../settings/workspace-dialogs-view'
import {
  ONBOARDING_SHARE as WORKSPACE_SHARE,
  ONBOARDING_SHARE_OPTIONAL as WORKSPACE_SHARE_OPTIONAL,
  onboardingSharedLine as workspaceSharedLine,
} from '../settings/workspace-remote-model'
import {
  ACTION_FAILED_LINE as WORKSPACE_ACTION_FAILED,
  NAME_LABEL as WORKSPACE_NAME_LABEL,
  ONBOARDING_JOIN as WORKSPACE_JOIN,
  ONBOARDING_LATER as WORKSPACE_LATER,
  ONBOARDING_QUESTION as WORKSPACE_QUESTION,
  ONBOARDING_RENAME as WORKSPACE_RENAME,
  ONBOARDING_RENAME_CONFIRM as WORKSPACE_RENAME_CONFIRM,
  ONBOARDING_SETTING_UP as WORKSPACE_SETTING_UP,
  ONBOARDING_TITLE as WORKSPACE_STEP_TITLE,
  ONBOARDING_UNAVAILABLE as WORKSPACE_UNAVAILABLE,
  onboardingDoneLine as workspaceDoneLine,
  onboardingWorkspaceLine,
  validateRename,
} from '../settings/workspace-settings-model'
import type { WorkspaceListing } from '../../shared/workspaces-contract'
import { modePersistPayload } from './mode-persist'
import { isSelectedMode, savedModeForProject } from './mode-selection'
import type { AutonomyMode } from './wizard-controller'
import type { StepView } from './wizard-view'
import { summaryRows } from './settings-summary'
import {
  canSignInHere,
  installConfirm,
  installingMessage,
  noCheckAnswer,
  requirementsMet,
  runtimeName,
  runtimeRequirements,
  signInUnconfirmed,
  type RuntimeAuthAnswer,
} from '../settings/runtime-ready'
import {
  mountRuntimeLoginAssist,
  type RuntimeLoginAssist,
} from '../settings/runtime-login-assist'

/** Shared across steps: the project opened during onboarding (for mode/settings). */
interface OnboardingSession {
  rootPath: string | null
}

// ── small DOM helpers ───────────────────────────────────────────────────────

function p(text: string, muted = false): HTMLParagraphElement {
  const el = document.createElement('p')
  el.textContent = text
  el.style.margin = '0 0 var(--fl-space-md)'
  el.style.lineHeight = 'var(--fl-line-height)'
  if (muted) el.style.color = 'var(--fl-color-text-secondary)'
  return el
}

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = label
  btn.className = primary ? 'fl-wizard-btn fl-wizard-btn--primary' : 'fl-wizard-btn'
  btn.addEventListener('click', onClick)
  return btn
}

function status(text: string, kind: 'ok' | 'muted' = 'muted'): HTMLDivElement {
  const el = document.createElement('div')
  el.textContent = text
  el.style.color = kind === 'ok' ? 'var(--fl-color-success)' : 'var(--fl-color-text-secondary)'
  el.style.fontSize = 'var(--fl-text-ui-size)'
  el.style.marginTop = 'var(--fl-space-sm)'
  return el
}

// ── steps ───────────────────────────────────────────────────────────────────

function welcomeStep(): StepView {
  return {
    id: 'welcome',
    title: 'Welcome to Flow',
    render(container) {
      container.appendChild(
        p('Flow is your agentic IDE — it runs the coding agent you choose.'),
      )
      container.appendChild(
        p(
          'The next few steps pick an agent, connect it, open a project, and set how autonomously it works. You can skip and finish later.',
          true,
        ),
      )
    },
  }
}

/**
 * Which coding agent runs — the first real decision of the wizard.
 *
 * BEFORE CONNECT, because it decides what connecting means. "Connect a Claude
 * account" used to be step two and a hard gate, so somebody who came to Flow to
 * work on Codex had to connect an Anthropic account they may not have owned,
 * just to reach the end of onboarding, and only then find the runtime picker
 * buried in Settings.
 *
 * THE SAME GATE THE SETTINGS SCREEN USES. `checkRuntimeAuth` +
 * `runtimeReadyVerdict` decide whether a runtime may be chosen, so the wizard's
 * bar and the settings screen's bar cannot drift apart — including the part
 * that matters most here: an unreadable probe answer refuses AND offers to be
 * overridden, because a config error in the runtime's own file is not a
 * statement about whether anyone is signed in.
 */
function runtimeStep(): StepView {
  return {
    id: 'runtime',
    title: 'Choose your agent',
    render(container, ctx) {
      container.appendChild(
        p('Flow runs a coding agent on your machine. Pick the one you want to use.'),
      )

      const options: ReadonlyArray<{ value: string; label: string; note: string }> = [
        { value: 'claude', label: 'Claude (Anthropic)', note: 'Signs in on the next step.' },
        { value: 'codex', label: 'Codex (OpenAI)', note: 'Signs in with your OpenAI account.' },
        {
          value: 'copilot',
          label: 'GitHub Copilot',
          // NOT Microsoft Copilot: two products, one word, and the wrong guess
          // sends somebody to the wrong account entirely.
          note: 'The GitHub coding agent — signs in with your GitHub account.',
        },
      ]

      const list = document.createElement('div')
      list.style.cssText = 'display:flex;flex-direction:column;gap:var(--fl-space-sm);'
      container.appendChild(list)
      const verdictLine = status('')
      container.appendChild(verdictLine)
      const actions = document.createElement('div')
      actions.style.cssText =
        'display:flex;gap:var(--fl-space-sm);flex-wrap:wrap;margin-top:var(--fl-space-sm);'
      container.appendChild(actions)

      const buttons = new Map<string, HTMLButtonElement>()
      let checking = false
      let loginAssist: RuntimeLoginAssist | null = null

      const paintChoice = (chosen: string): void => {
        for (const [value, btn] of buttons) {
          btn.classList.toggle('fl-wizard-btn--primary', value === chosen)
        }
      }

      const check = (chosen: string): void => {
        if (checking) return
        // Re-checking replaces whatever the sign-in was showing; the child
        // process behind it is cancelled rather than left waiting on an OAuth
        // nobody can finish now.
        if (loginAssist !== null) {
          loginAssist.dispose()
          loginAssist = null
          void window.flow.settings.cancelRuntimeLogin?.().catch(() => undefined)
        }
        checking = true
        paintChoice(chosen)
        actions.textContent = ''
        verdictLine.textContent = `Checking ${runtimeName(chosen)}…`
        verdictLine.style.color = 'var(--fl-color-text-secondary)'
        const probe = window.flow.settings.checkRuntimeAuth
        const answer: Promise<RuntimeAuthAnswer> =
          typeof probe === 'function'
            ? probe({ provider: chosen }).catch(() => noCheckAnswer(chosen))
            : Promise.resolve(noCheckAnswer(chosen))
        void answer
          .then((result) => {
            const requirements = runtimeRequirements(result)
            if (requirementsMet(requirements)) {
              verdictLine.textContent = `✓ ${runtimeName(chosen)} is ready`
              verdictLine.style.color = 'var(--fl-color-success)'
              ctx.update({ runtime: chosen, runtimeReady: true })
              // Persisted NOW, not at the end: the wizard can be closed at any
              // step, and a choice that only existed in memory would leave the
              // app running whatever it ran before.
              void window.flow.settings.setDefaultProvider({ provider: chosen })
              return
            }
            ctx.update({ runtime: chosen, runtimeReady: false })
            // CLAUDE'S MISSING ACCOUNT IS NOT A REFUSAL HERE — it is the next
            // step's whole subject. A list of requirements in front of the
            // ordinary first run would be a stop sign where a sentence belongs.
            if (chosen === 'claude') {
              // ANSWER THE PRESS FIRST.
              //
              // The runtime options are primary-styled buttons, so this option
              // is the only thing on the step that looks like a control. It
              // used to reply with a bare instruction — "Connect your Claude
              // account in the next step." — which reads as a refusal rather
              // than a result, so the press got repeated and the app looked
              // dead ("I'm trying to click on the claude button because it's
              // like a button").
              //
              // The remedy is to confirm the choice landed, in the same shape
              // the other runtimes use for their own verdict, and then say what
              // comes next. NOT a second button: the wizard footer's Next is
              // already this step's forward action, and a "Continue to sign-in"
              // beside it was two controls doing one job — which is how the
              // first attempt at this fix was reported back.
              verdictLine.textContent = '✓ Claude selected — connect your account next'
              verdictLine.style.color = 'var(--fl-color-success)'
              void window.flow.settings.setDefaultProvider({ provider: chosen })
              return
            }

            // WHAT IT NEEDS, AND THE PRESS THAT PROVIDES IT — no relayed CLI
            // text. "Flow could not confirm that Codex is signed in — Error
            // loading configuration: unknown variant `xhigh`" asked the reader
            // to debug a file they never opened.
            verdictLine.textContent = `${runtimeName(chosen)} needs:`
            verdictLine.style.color = 'var(--fl-color-text-secondary)'
            for (const requirement of requirements) {
              const row = document.createElement('div')
              row.style.cssText =
                'display:flex;align-items:center;gap:var(--fl-space-xs);width:100%;'
              const mark = document.createElement('span')
              mark.textContent = requirement.met ? '✓' : '○'
              mark.style.color = requirement.met
                ? 'var(--fl-color-success)'
                : 'var(--fl-color-text-secondary)'
              const label = document.createElement('span')
              label.textContent = requirement.label
              label.style.cssText =
                'color:var(--fl-color-text-secondary);font-size:var(--fl-text-ui-size);'
              row.append(mark, label)
              // INSTALL IN PLACE. It asks nothing and opens nothing, so it runs
              // behind this panel and reports back here — setup is not
              // interrupted to do it.
              if (!requirement.met && requirement.action === 'install') {
                row.appendChild(button(`Install ${runtimeName(chosen)}`, () => askToInstall(chosen)))
              }
              // SIGN IN WITHOUT LEAVING SETUP. The first version closed the
              // wizard and ran the login in a terminal, because this overlay
              // covers the shell — so the press either did nothing visible or
              // threw the user out of onboarding.
              if (!requirement.met && requirement.action === 'sign-in' && canSignInHere(chosen)) {
                row.appendChild(
                  button(`Sign in to ${runtimeName(chosen)}`, () => {
                    verdictLine.textContent = ''
                    actions.textContent = ''
                    loginAssist?.dispose()
                    loginAssist = mountRuntimeLoginAssist(actions, chosen, {
                      onFinished: (ok) => {
                        if (ok) check(chosen)
                      },
                    })
                  }),
                )
              }
              actions.appendChild(row)
            }
            const trailing = document.createElement('div')
            trailing.style.cssText =
              'display:flex;gap:var(--fl-space-sm);flex-wrap:wrap;margin-top:var(--fl-space-xs);'
            trailing.appendChild(button('Check again', () => check(chosen)))
            // "COULD NOT TELL" IS NOT "NOT SIGNED IN": a probe that never got
            // an answer must not lock out somebody who is signed in.
            if (signInUnconfirmed(result)) {
              trailing.appendChild(
                button(`Use ${runtimeName(chosen)} anyway`, () => {
                  ctx.update({ runtime: chosen, runtimeReady: true })
                  void window.flow.settings.setDefaultProvider({ provider: chosen })
                  verdictLine.textContent = `${runtimeName(chosen)} selected without a confirmed sign-in.`
                  actions.textContent = ''
                }),
              )
            }
            actions.appendChild(trailing)
          })
          .finally(() => {
            checking = false
          })
      }

      /** Ask before installing software on someone's machine, then do it. */
      const askToInstall = (chosen: string): void => {
        const confirmed = installConfirm(chosen)
        verdictLine.textContent = `${confirmed.question} ${confirmed.detail}`
        verdictLine.style.color = 'var(--fl-color-text-secondary)'
        actions.textContent = ''
        actions.appendChild(
          button(confirmed.accept, () => {
            const run = window.flow.settings.installRuntime
            if (typeof run !== 'function') {
              verdictLine.textContent = `This build of Flow cannot install ${runtimeName(chosen)}.`
              actions.textContent = ''
              return
            }
            verdictLine.textContent = installingMessage(chosen)
            actions.textContent = ''
            void run({ provider: chosen })
              .then((result) => {
                // Installed is not signed in — re-probe rather than assume.
                if (result.ok) {
                  check(chosen)
                  return
                }
                verdictLine.textContent = `Flow could not install ${runtimeName(chosen)} — ${result.detail}`
                verdictLine.style.color = 'var(--fl-color-danger, #d9534f)'
                actions.appendChild(button('Try again', () => askToInstall(chosen)))
              })
              .catch(() => {
                verdictLine.textContent = `Flow could not install ${runtimeName(chosen)}.`
                verdictLine.style.color = 'var(--fl-color-danger, #d9534f)'
                actions.appendChild(button('Try again', () => askToInstall(chosen)))
              })
          }),
        )
        actions.appendChild(button('Not now', () => check(chosen)))
      }

      for (const option of options) {
        const row = document.createElement('div')
        row.style.cssText = 'display:flex;align-items:center;gap:var(--fl-space-sm);'
        const btn = button(option.label, () => check(option.value))
        buttons.set(option.value, btn)
        const note = document.createElement('span')
        note.textContent = option.note
        note.style.cssText =
          'color:var(--fl-color-text-secondary);font-size:var(--fl-text-ui-size);'
        row.append(btn, note)
        list.appendChild(row)
      }

      // Start on whatever the app already runs — a re-run of the wizard shows
      // the current answer rather than an empty question.
      void window.flow.settings
        .getDefaultProvider()
        .then((result) => check(result.provider ?? 'claude'))
        .catch(() => check('claude'))
    },
  }
}

function connectStep(): StepView {
  return {
    id: 'connect',
    title: 'Connect an account',
    // Name the runtime the user picked. "Connect a Claude account" in front of
    // someone who chose Codex is a step that misdescribes itself.
    titleFor: (state) =>
      (state.runtime ?? 'claude') === 'claude' ? 'Connect a Claude account' : 'Connect an account',
    render(container, ctx) {
      // WHOSE ACCOUNT, and whether one is needed at all. Under Codex or Copilot
      // the sign-in already happened at the previous step, in that CLI's own
      // login — there is no Flow-side account to connect, and asking for one
      // was the gate that made this step impassable for them.
      const runtime = ctx.state.runtime ?? 'claude'
      if (runtime !== 'claude') {
        container.appendChild(
          p(
            `${runtimeName(runtime)} signs in through its own command-line tool, which you did in the previous step. There is no account to add here.`,
          ),
        )
        container.appendChild(
          p('Claude accounts can still be added later in Settings, if you switch back.', true),
        )
        return
      }
      container.appendChild(p('Flow needs a Claude account to run the agent.'))
      const slot = document.createElement('div')
      container.appendChild(slot)

      const showConnected = (label: string): void => {
        slot.replaceChildren(status(`✓ Connected as ${label}`, 'ok'))
      }

      // #1408: the explanatory line for an expired session, rendered ALONGSIDE
      // the connect button rather than replaced by it.
      let signedOutNote: HTMLElement | null = null
      void window.flow.accounts
        .list()
        .then(async (accounts) => {
          if (accounts.length > 0) {
            // #1319: this certified from a bare ROW COUNT, and named
            // `accounts[0]` — the OLDEST account, not the one the app will
            // actually use. Two things it never read, both already available:
            // which account is the DEFAULT, and whether that account is still
            // logged in. So the step could say "✓ Connected as <someone
            // else>" over an expired session and ungate Next on it.
            const account = accounts.find((candidate) => candidate.isDefault) ?? accounts[0]
            if (account !== undefined) {
              const probe = await window.flow.accounts
                .status({ id: account.id })
                .catch(() => null)
              // A probe that could not run is not a failure — it means
              // unknown, and the pre-#1319 behaviour (trust the row) is the
              // right fallback. Only a probe that ran and said "logged out"
              // withholds the ✓.
              if (probe === null || !probe.checked || probe.loggedIn) {
                ctx.update({ accountConnected: true })
                showConnected(probe?.identity ?? account.label)
                return
              }
              // #1408: HOLD the line — don't render it here. My #1319 comment
              // said "fall through to the connect button rather than
              // dead-ending", and the fall-through ends in
              // `slot.replaceChildren(connectBtn)`, which wiped the line I had
              // just put there. So the user saw a bare "Connect a Claude
              // account" button — byte-identical to a true first run — on a
              // hard-gated step, with no hint that the account they already
              // have is why Next is dead. There was no "below" for
              // "connect it again below" to point at.
              signedOutNote = status(
                `${account.label} is signed out — connect it again below`,
                'muted',
              )
            }
          }
          const connectBtn = button(
            'Connect a Claude account',
            () => {
              connectBtn.disabled = true
              // #972: the login is interactive — `claude auth login` prints a
              // sign-in URL then blocks on a paste-the-code prompt. The assist
              // renders the status line, the URL fallback, and the code field.
              const assistHost = document.createElement('div')
              slot.replaceChildren(connectBtn, assistHost)
              const assist = mountLoginAssist(assistHost)
              // #1167: the wizard's overlay can be dismissed (Skip for now /
              // Escape) while this interactive child is still blocked on stdin.
              // Record ownership so wizard-view.close() can cancel it instead
              // of stranding the orchestrator's single slot for 5 minutes and
              // locking the user out of connecting an account at all.
              markLoginInFlight(WIZARD_LOGIN_SURFACE)
              const fail = (detail?: string): void => {
                settleLogin(WIZARD_LOGIN_SURFACE)
                assist.dispose()
                connectBtn.disabled = false
                slot.replaceChildren(
                  connectBtn,
                  status(detail ?? 'Sign-in failed — try again.', 'muted'),
                )
              }
              void window.flow.accounts
                .add({ label: 'Claude Code' })
                .then((result) => {
                  if ('error' in result) {
                    // Surface the orchestrator's specific reason (canceled /
                    // timed out / already-in-progress) instead of a blanket line.
                    fail(result.error)
                    return
                  }
                  settleLogin(WIZARD_LOGIN_SURFACE)
                  assist.dispose()
                  ctx.update({ accountConnected: true })
                  showConnected(result.account.label)
                })
                .catch(() => fail())
            },
            true,
          )
          slot.replaceChildren(...(signedOutNote ? [signedOutNote] : []), connectBtn)
        })
        .catch(() => slot.replaceChildren(status('Could not read accounts.', 'muted')))
    },
  }
}

function projectStep(session: OnboardingSession): StepView {
  return {
    id: 'project',
    title: 'Open a project',
    render(container, ctx) {
      container.appendChild(p('Choose the project you want to work on.'))
      const slot = document.createElement('div')
      container.appendChild(slot)

      const showOpened = (rootPath: string, provisioning: boolean): void => {
        const name = baseName(rootPath) || rootPath
        // A picked project isn't final — offer to switch to a different folder
        // right here, so the first-run choice is never a trap (#504). Disabled
        // while setup is in flight so a mid-provision switch can't race.
        const change = button('Change project…', () => openProject(), false)
        change.disabled = provisioning
        slot.replaceChildren(
          status(`✓ ${name}`, 'ok'),
          status(provisioning ? 'Setting up project…' : 'Ready.', 'muted'),
          change,
        )
      }

      const provision = (rootPath: string): void => {
        showOpened(rootPath, true)
        // Kicks ensureProjectInitialized + first derive under the hood; fail-soft.
        void window.flow.blueprint
          .derive({ rootId: rootPath })
          .catch(() => undefined)
          .finally(() => showOpened(rootPath, false))
      }

      // Pick (or re-pick) the project folder, then set it up. Shared by the first
      // "Open project…" button and the "Change project…" affordance (#504).
      const openProject = (): void => {
        void window.flow.project.open().then((root) => {
          if (!root) return
          session.rootPath = root.rootPath
          markRootOnboarded(root.rootPath)
          ctx.update({ projectOpen: true })
          provision(root.rootPath)
        })
      }

      // Reopen target: the ACTIVE project first (ADR-002 — what the titlebar
      // switcher, Files tree, editor and terminals all bind to), falling back to
      // the first-added root only when nothing is active (#1038). ONE resolution
      // feeds the confirmation label, markRootOnboarded AND session.rootPath, so
      // the step's text and the mode step's write can never disagree about which
      // project the wizard is configuring.
      void Promise.all([
        window.flow.project.list(),
        window.flow.project.active().catch(() => null),
      ])
        .then(([allRoots, active]) => {
          // #1407: only REACHABLE roots. This threw the `available` flag away,
          // so a project whose folder had been moved, deleted or unmounted
          // rendered the full green "✓ <name>" + "Ready." and ungated Next on
          // it — and accepting it is not inert: session.rootPath (a path that
          // does not exist) is what the mode step writes to, so the next click
          // failed with a raw ENOENT. The sidebar has skipped unavailable
          // roots for exactly this reason since #263.
          const roots = allRoots.filter((root) => root.available !== false)
          if (roots.length > 0) {
            const activeRoot = roots.find((root) => root.rootPath === active?.rootPath)
            const target = (activeRoot ?? roots[0]).rootPath
            session.rootPath = target
            markRootOnboarded(target)
            ctx.update({ projectOpen: true })
            showOpened(target, false)
            return
          }
          // #1407: with roots that all point at missing folders, say so —
          // an "Open project…" button alone reads as "you have none", which
          // is a different (and confusing) claim.
          const unreachable = allRoots.length > 0
          slot.replaceChildren(
            ...(unreachable
              ? [
                  status(
                    `${allRoots.length === 1 ? 'Your project folder is' : 'Your project folders are'} not reachable — pick one again.`,
                    'muted',
                  ),
                ]
              : []),
            button('Open project…', () => openProject(), true),
          )
        })
        .catch(() => slot.replaceChildren(status('Could not read projects.', 'muted')))
    },
  }
}

function modeStep(session: OnboardingSession): StepView {
  return {
    id: 'mode',
    title: 'Choose a mode',
    render(container, ctx) {
      container.appendChild(p('How autonomously should the agent work? You can change this later.'))
      const choices: Array<{ mode: AutonomyMode; label: string; desc: string }> = [
        { mode: 'manual', label: 'Manual', desc: 'Approve each action. Autopilot off.' },
        {
          mode: 'autonomous',
          label: 'Autonomous',
          desc: 'Autopilot on and permission prompts skipped for new threads.',
        },
      ]
      const buttons: HTMLButtonElement[] = []
      const statusSlot = document.createElement('div')
      const failureMessage = (): HTMLDivElement =>
        status("Couldn't save your choice — try again.", 'muted')
      // A mode click persists ONLY the per-project autopilot flag — it is visible
      // and revertable in the status line / flow settings. The app-wide
      // permission-prompt bypass (autonomyBypassDefault) is CONFIRM-GATED: the
      // wizard holds the pick in state and commits it on Finish (onboarding/
      // index.ts onComplete), never on click. So abandoning the wizard via
      // Skip/Escape cannot leave the bypass silently on (#1116), and a failed
      // project write cannot leave the app store half-written behind a
      // "couldn't save" message (#1077) — the writes are no longer a two-step
      // transaction with no rollback. Awaited (not fire-and-forget) per #229.
      const persist = async (mode: AutonomyMode): Promise<boolean> => {
        if (!session.rootPath) return true
        try {
          await window.flow.flow.setConfig({
            rootId: session.rootPath,
            updates: modePersistPayload(mode).config,
          })
          return true
        } catch (error) {
          console.error('flow: onboarding mode persist failed', error)
          return false
        }
      }
      for (const choice of choices) {
        const btn = button(`${choice.label} — ${choice.desc}`, () => {
          void (async () => {
            statusSlot.replaceChildren()
            const ok = await persist(choice.mode)
            if (!ok) {
              // Don't present the mode as confirmed — record the failure in
              // wizard STATE so Next stays gated even though #716's reflection
              // already set a mode, and so the message survives Back/Next
              // re-renders until a retry succeeds (#229, #1078).
              ctx.update({ modePersistFailed: true })
              statusSlot.replaceChildren(failureMessage())
              return
            }
            ctx.update({ mode: choice.mode, modePersistFailed: false })
            for (const b of buttons) b.classList.remove('fl-wizard-btn--primary')
            btn.classList.add('fl-wizard-btn--primary')
          })()
        })
        btn.style.display = 'block'
        btn.style.width = '100%'
        btn.style.textAlign = 'left'
        btn.style.marginBottom = 'var(--fl-space-sm)'
        // Restore the highlight from wizard state so a previously-chosen mode still
        // shows selected after Back-navigation re-renders the step (#320) — mirroring
        // how the Connect/Project steps re-derive their confirmation on every render.
        if (isSelectedMode(choice.mode, ctx.state.mode)) {
          btn.classList.add('fl-wizard-btn--primary')
        }
        buttons.push(btn)
        container.appendChild(btn)
      }
      container.appendChild(statusSlot)
      // An unresolved persist failure is rendered FROM STATE, like the highlight
      // (#320) — Back → Next re-renders the step, and the error must not
      // evaporate while it still gates Next (#1078).
      if (ctx.state.modePersistFailed) statusSlot.replaceChildren(failureMessage())
      // Reflect the SAVED autonomy mode on reopen (#716), mirroring how Connect/
      // Project auto-detect existing state: read persisted onboarding, map it to
      // a mode, highlight it and ungate Next. Reflection only — nothing persists
      // until the user clicks. Skipped when the wizard already holds a choice
      // (Back-navigation, #320) or on a true first run (savedMode → null).
      if (ctx.state.mode === null) {
        // #1206: reflect the mode of the PROJECT this step writes to, not the
        // app-wide default it doesn't. Reading only `autonomyBypassDefault`
        // meant the step pre-selected, confirmed and walked past a mode derived
        // from a store it never writes — so on a second project (or after
        // autopilot was toggled in Flow settings) it stated the wrong autonomy
        // for the active project and accepting it wrote nothing at all.
        const root = session.rootPath
        void Promise.all([
          window.flow.settings.getOnboarding(),
          root
            ? window.flow.flow
                .state({ rootId: root })
                .then((state) => state.autopilot)
                .catch(() => null)
            : Promise.resolve(null),
        ])
          .then(([saved, projectAutopilot]) => {
            if (ctx.state.mode !== null) return // user picked while we fetched
            const mode = savedModeForProject(projectAutopilot, saved)
            ctx.update({ mode })
            for (const [index, choice] of choices.entries()) {
              buttons[index].classList.toggle('fl-wizard-btn--primary', choice.mode === mode)
            }
          })
          .catch(() => undefined) // fail-soft: step just requires a manual pick
      }
    },
  }
}

function settingsStep(session: OnboardingSession): StepView {
  return {
    id: 'settings',
    title: 'Your project settings',
    render(container) {
      // #1207: report THIS project's values. The step used to list field labels
      // and help text — identical for every project and every choice — while
      // claiming "Flow configured your project with these settings", including
      // for `autopilot`, which the user had chosen one step earlier. A summary
      // that can't differ between an autopilot-on and an autopilot-off project
      // is a brochure for the settings screen, not a report.
      container.appendChild(
        p('Flow configured your project with these settings — change any anytime in Settings.'),
      )
      const rows = new Map<string, HTMLElement>()
      for (const section of FLOW_SETTINGS_SECTIONS) {
        // A section with no keys (Knowledge sync) has nothing to summarize.
        if (section.fields.length === 0) continue
        const heading = document.createElement('div')
        heading.textContent = section.title
        heading.style.fontWeight = 'var(--fl-text-ui-weight-medium)'
        heading.style.margin = 'var(--fl-space-md) 0 var(--fl-space-xs)'
        container.appendChild(heading)
        for (const field of section.fields) {
          const row = document.createElement('div')
          row.className = 'fl-wizard-summary-row'
          row.dataset['settingKey'] = field.key
          row.style.color = 'var(--fl-color-text-secondary)'
          row.style.fontSize = 'var(--fl-text-ui-size)'
          // Rendered before the read resolves, so the step never blocks; the
          // value lands in place a moment later.
          row.textContent = field.help ? `${field.label} — ${field.help}` : field.label
          container.appendChild(row)
          rows.set(field.key, row)
        }
      }
      const root = session.rootPath
      if (!root) return
      void window.flow.flow
        .state({ rootId: root })
        .then((state) => {
          const values = readValues(state.flowconfig ?? {})
          for (const section of FLOW_SETTINGS_SECTIONS) {
            for (const entry of summaryRows(section.fields, values)) {
              const field = section.fields.find((candidate) => candidate.label === entry.label)
              const row = field ? rows.get(field.key) : undefined
              if (row) row.textContent = `${entry.label} — ${entry.value}`
            }
          }
        })
        .catch(() => undefined) // fail-soft: the labels above still stand
    },
  }
}

/**
 * "Your Workspace" — always present (decision 2026-10-06): every project lives
 * in a Workspace, and the first launch made the Default one with the projects
 * that were here. This step SHOWS it (or says it is being set up), lets the
 * person rename it, or join their team's Workspace instead — the project
 * opened in this wizard then moves there. It can also be shared with the
 * team ("Share with your team…" — the Settings Connect dialog). There is no
 * "Not now": Next is already a complete answer, and nothing here gates.
 *
 * Every word is in `workspace-settings-model.ts`, scanned for #12.
 */
function workspaceStep(session: OnboardingSession): StepView {
  let unsubscribe: (() => void) | null = null
  const release = (): void => {
    unsubscribe?.()
    unsubscribe = null
  }
  return {
    id: 'workspace',
    title: WORKSPACE_STEP_TITLE,
    leave: release,
    render(container) {
      release()
      const question = p(WORKSPACE_QUESTION)
      question.style.fontWeight = 'var(--fl-text-ui-weight-medium)'
      container.append(question)

      const api = window.flow.workspaces
      if (api === undefined) {
        container.appendChild(p(WORKSPACE_UNAVAILABLE, true))
        return
      }
      const current = document.createElement('div')
      current.className = 'fl-wizard-workspace-current'
      const actions = document.createElement('div')
      actions.className = 'fl-wizard-workspace-actions'
      actions.style.display = 'flex'
      actions.style.flexWrap = 'wrap'
      actions.style.gap = 'var(--fl-space-sm)'
      const result = document.createElement('div')
      result.className = 'fl-wizard-workspace-result'
      const later = p(WORKSPACE_LATER, true)
      later.style.marginTop = 'var(--fl-space-md)'
      container.append(current, actions, result, later)

      /** Set once a join succeeded — the step then just says where the person is. */
      let joinedName: string | null = null

      const paint = (workspace: WorkspaceListing | null, migrating: boolean): void => {
        if (joinedName !== null) return
        if (workspace === null) {
          current.replaceChildren(status(migrating ? WORKSPACE_SETTING_UP : WORKSPACE_ACTION_FAILED))
          actions.replaceChildren()
          return
        }
        const line = status(onboardingWorkspaceLine(workspace.name), 'ok')
        line.dataset['workspace'] = workspace.slug
        current.replaceChildren(line)
        const rename = button(WORKSPACE_RENAME, () => showRename(workspace))
        rename.dataset['action'] = 'rename-workspace'
        const join = button(WORKSPACE_JOIN, () => void joinInstead(workspace))
        join.dataset['action'] = 'join-workspace'
        actions.replaceChildren(rename, join)
        if (workspace.remote === null) {
          // Optional and skippable: Next is a complete answer without it.
          const share = button(WORKSPACE_SHARE, () => void shareWithTeam(workspace))
          share.dataset['action'] = 'share-workspace'
          actions.appendChild(share)
          result.replaceChildren(status(WORKSPACE_SHARE_OPTIONAL))
        } else {
          result.replaceChildren(status(workspaceSharedLine(workspace.name), 'ok'))
        }
      }

      /** "Share with your team…": the same Connect dialog Settings opens. */
      const shareWithTeam = async (workspace: WorkspaceListing): Promise<void> => {
        const shared = await openConnectRemoteDialog({ slug: workspace.slug, name: workspace.name })
        if (shared) void read()
      }

      const showRename = (workspace: WorkspaceListing): void => {
        const input = document.createElement('input')
        input.type = 'text'
        input.className = 'fl-wizard-input'
        input.value = workspace.name
        input.setAttribute('aria-label', WORKSPACE_NAME_LABEL)
        const save = button(
          WORKSPACE_RENAME_CONFIRM,
          () => {
            const checked = validateRename(input.value, workspace.name)
            if (!checked.ok) {
              result.replaceChildren(status(checked.message))
              return
            }
            save.disabled = true
            void api
              .rename({ slug: workspace.slug, name: checked.name })
              .then((answer) => {
                save.disabled = false
                if (!answer.ok) {
                  result.replaceChildren(status(answer.detail))
                  return
                }
                result.replaceChildren()
                void read()
              })
              .catch(() => {
                save.disabled = false
                result.replaceChildren(status(WORKSPACE_ACTION_FAILED))
              })
          },
          true,
        )
        save.dataset['action'] = 'save-workspace-name'
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            save.click()
          }
        })
        actions.replaceChildren(input, save)
        input.focus()
        input.select()
      }

      /** Join the team's Workspace; the project opened in this wizard moves there. */
      const joinInstead = async (from: WorkspaceListing): Promise<void> => {
        const joined = await openJoinDialog()
        if (joined === null) return
        const root = session.rootPath
        if (root !== null) {
          const membership = await api.membership({ roots: [root] }).catch(() => null)
          const entry = membership?.ok === true ? membership.roots[0] : undefined
          if (entry !== undefined && entry.workspace === from.slug && entry.project !== null) {
            const moved = await api.moveProject({ project: entry.project, to: joined.slug, from: from.slug }).catch(() => null)
            if (moved !== null && !moved.ok) result.replaceChildren(status(moved.detail))
          }
        }
        joinedName = joined.name
        actions.replaceChildren()
        current.replaceChildren(status(workspaceDoneLine(joined.name), 'ok'))
      }

      const read = async (): Promise<void> => {
        const [listed, placement] = await Promise.all([
          api.list().catch(() => null),
          api.placement().catch(() => null),
        ])
        const workspaces = listed?.ok === true ? listed.workspaces : []
        const workspace = workspaces.find((candidate) => candidate.isDefault) ?? workspaces[0] ?? null
        paint(workspace, placement?.migrating !== false)
      }
      // Rendered before the read resolves so the step never blocks on it.
      current.appendChild(status(WORKSPACE_SETTING_UP))
      // The first launch's migration may still be running: the Workspace
      // appears here the moment main says it changed.
      unsubscribe = api.onChanged(() => void read())
      void read()
    },
  }
}

/** Build the ordered onboarding steps, sharing the opened-project session. */


/**
 * The sign-in step — offered, never required.
 *
 * NOTHING HERE GATES. `canAdvance` has no case for this step, so Next works
 * whether somebody signs in or not, and the controller's own test asserts that
 * no step gates on identity. The app's ONLY account gate is `connect`, and a
 * second one would break the promise that signing in gates nothing.
 *
 * IT DOES NOT PROMISE SYNC. Sync is the reason people will want to sign in and
 * it does not exist yet; the discovery recorded that tension rather than
 * resolving it, and the wording is where it is honoured. What this says is what
 * signing in DOES today.
 */
function signInStep(): StepView {
  return {
    id: 'signIn',
    title: 'Sign in to Flow',
    render(container) {
      container.appendChild(
        p(
          'Signing in ties this installation to you. Flow works exactly the same either way — nothing here unlocks a feature, and you can sign out whenever you like.',
        ),
      )

      const row = document.createElement('div')
      row.className = 'fl-settings-row'
      const status = document.createElement('div')
      status.className = 'fl-settings-add-status'
      status.hidden = true

      const paint = async (): Promise<void> => {
        row.replaceChildren()
        const settings = window.flow.settings
        if (settings.whoAmI === undefined || settings.authAvailable === undefined) {
          status.hidden = false
          status.textContent = "Signing in isn't available in this build of Flow."
          return
        }
        const [available, identity] = await Promise.all([
          settings.authAvailable(),
          settings.whoAmI(),
        ])
        const state = signInStateFrom(available, identity)
        const copy = signInCopy(state)
        if (copy.who !== null) {
          const who = document.createElement('div')
          who.className = 'fl-settings-account-identity'
          who.textContent = copy.who
          row.appendChild(who)
        }
        if (copy.action === null) {
          status.hidden = false
          status.textContent = copy.hint
          return
        }
        if (state.kind === 'signed-in') {
          status.hidden = false
          status.textContent = 'You can change this later in Settings.'
          return
        }
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'fl-settings-btn'
        button.textContent = copy.action
        button.addEventListener('click', () => {
          button.disabled = true
          button.textContent = 'Opening browser…'
          status.hidden = false
          status.textContent = 'Finish signing in in your browser, then come back.'
          void window.flow.settings
            .signIn?.()
            .then((result) => {
              if (result !== undefined && !result.ok) status.textContent = result.reason
              void paint()
            })
            .catch(() => {
              status.textContent = "The sign-in didn't complete. You can try again."
              void paint()
            })
        })
        row.appendChild(button)
      }

      container.append(row, status)
      // SKIPPING IS THE SAME GESTURE AS CONTINUING. There is no "skip" control
      // because Next already is one — a second way to decline would imply the
      // first was not really available.
      const note = document.createElement('div')
      note.className = 'fl-settings-hint'
      note.textContent = 'You can do this later, or not at all.'
      container.appendChild(note)
      void paint()
    },
  }
}

export function createOnboardingSteps(): StepView[] {
  const session: OnboardingSession = { rootPath: null }
  return [
    welcomeStep(),
    runtimeStep(),
    connectStep(),
    projectStep(session),
    modeStep(session),
    signInStep(),
    settingsStep(session),
    workspaceStep(session),
  ]
}
