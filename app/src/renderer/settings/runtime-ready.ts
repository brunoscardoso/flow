// What does this runtime still NEED before it can run?
//
// Two questions, and only two: is the tool installed, and is it signed in.
// Each unmet one is a REQUIREMENT carrying the single action that satisfies it.
//
// This replaced a sentence that relayed whatever the CLI said, which produced
// lines like "Flow could not confirm that Codex is signed in — Error loading
// configuration: unknown variant `xhigh`, expected one of `low`, `medium`,
// `high`, `none`". Everything after the dash is a stack trace wearing a
// sentence's clothes: it names a key, in a file the reader did not open, in a
// tool Flow launched itself, to answer a question they asked by picking from a
// dropdown. The decision in front of them is binary — can I use this, and what
// do I press — so that is all this reports.

/** The probe's answer — `settings:checkRuntimeAuth`'s response shape. */
export interface RuntimeAuthAnswer {
  provider: string
  status: 'ready' | 'not-installed' | 'not-signed-in' | 'unknown'
  detail: string
}

/** One thing a runtime needs, and the one press that provides it. */
export interface RuntimeRequirement {
  key: 'installed' | 'signed-in'
  label: string
  met: boolean
  /** Null when the surface, not this row, owns the fix (Claude's accounts). */
  action: 'install' | 'sign-in' | null
}

/**
 * Which "This project" surface the settings page draws, given the runtime the
 * project actually RESOLVES to.
 *
 * Only Claude has a per-project account picker; every other runtime keeps a
 * single global sign-in, so a project pinned to it gets the honest runtime block
 * instead — an Anthropic account list there would answer a question that runtime
 * never asks (forbidden-pattern #12). Pure and DOM-free so the gate is one named
 * decision the view branches on and a test can reach without a renderer
 * (allowed-pattern #14).
 */
export function projectAccountSurface(resolvedProvider: string): 'claude-picker' | 'runtime-block' {
  return resolvedProvider === 'claude' ? 'claude-picker' : 'runtime-block'
}

/** What a runtime is called in a sentence. */
/**
 * The FULL product name, because the short one was ambiguous enough to send
 * somebody to the wrong sign-in.
 *
 * "Copilot" is at least two products: Microsoft Copilot (copilot.microsoft.com,
 * a chat assistant with no agent CLI) and GitHub Copilot (whose `copilot` CLI
 * is the coding agent Flow drives, signed in with a GitHub account). A user
 * reading "Copilot (GitHub)" reasonably expected the Microsoft account they use
 * every day, and read the GitHub device flow as Flow asking for the wrong one.
 *
 * The name in every sentence is now the one on the product.
 */
const RUNTIME_NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
}

export function runtimeName(provider: string): string {
  return RUNTIME_NAMES[provider] ?? provider
}

/**
 * What `provider` still needs, in order.
 *
 * CLAUDE HAS ONE REQUIREMENT, not two: Flow ships the Claude runtime, so
 * "installed" is not a question anybody can answer no to, and listing it would
 * be a permanent tick beside a thing nobody did. Its sign-in is an account in
 * this app — added by the panel below, or by the next step of setup — so the
 * row reports and the surface acts.
 */
export function runtimeRequirements(answer: RuntimeAuthAnswer): RuntimeRequirement[] {
  if (answer.provider === 'claude') {
    return [
      {
        key: 'signed-in',
        label: 'Account connected',
        met: answer.status === 'ready',
        action: null,
      },
    ]
  }
  const installed = answer.status !== 'not-installed'
  return [
    {
      key: 'installed',
      label: 'Installed',
      met: installed,
      action: installPackageName(answer.provider) === null ? null : 'install',
    },
    {
      key: 'signed-in',
      label: 'Signed in',
      // NOT CONFIRMED IS NOT MET. A tool that answered something unreadable has
      // not told us it is signed in, and keeping an unverified runtime out of
      // the first turn is the entire reason this is asked before saving.
      met: installed && answer.status === 'ready',
      action: installed ? 'sign-in' : null,
    },
  ]
}

/** Ready to be selected: everything it needs, it has. */
export function requirementsMet(requirements: readonly RuntimeRequirement[]): boolean {
  return requirements.every((requirement) => requirement.met)
}

/**
 * True when the sign-in question could not be ANSWERED, as opposed to answered
 * no. The rows read the same either way — the reader's next press is the same
 * one — but this is what keeps the escape hatch honest: `codex login status`
 * exiting non-zero over an unrelated config key has not said "logged out", and
 * somebody who IS signed in must not be locked out by it.
 */
export function signInUnconfirmed(answer: RuntimeAuthAnswer): boolean {
  return answer.provider !== 'claude' && answer.status === 'unknown'
}

/**
 * The published package for a runtime's CLI — the renderer's copy of main's
 * list, kept here so the BUTTON only appears when an install would really run.
 * Verified against the live npm registry, not documentation (#11).
 */
function installPackageName(provider: string): string | null {
  if (provider === 'codex') return '@openai/codex'
  if (provider === 'copilot') return '@github/copilot'
  return null
}

/** What the install confirmation asks, in the reader's terms. */
export interface InstallConfirm {
  question: string
  detail: string
  accept: string
}

/**
 * The question before an install.
 *
 * ASKING IS THE POINT. Installing software on someone's machine because they
 * clicked a settings row is a decision they did not make; a plain question they
 * can decline turns it into one they did. It names the installer (npm) and where
 * the tool lands, because "Install Copilot" alone hides how much is happening.
 */
export function installConfirm(provider: string): InstallConfirm {
  const name = runtimeName(provider)
  return {
    question: `Install ${name} on this machine?`,
    detail: `Flow will install the ${name} command-line tool globally with npm. This can take a minute, and it does not sign you in — you do that after it lands.`,
    accept: `Install ${name}`,
  }
}

/** While it runs. Named here so both surfaces say the same thing. */
export function installingMessage(provider: string): string {
  return `Installing ${runtimeName(provider)}… this can take a minute.`
}

/**
 * Can Flow run this runtime's sign-in itself?
 *
 * Both external CLIs have a real `login` command that prints a URL (and, for
 * Copilot, a device code) and exits when the browser side finishes — measured,
 * not assumed. That is enough to run it here, the way Claude's own sign-in
 * runs here, instead of handing over a terminal. Claude is absent because its
 * login is Flow's own orchestrator, one screen away.
 */
export function canSignInHere(provider: string): boolean {
  return provider === 'codex' || provider === 'copilot'
}

/**
 * What a build with no check at all reports.
 *
 * An older preload knows nothing about the runtime's actual state, which is the
 * same "could not tell" as an unreadable CLI answer — and gets the same
 * treatment: the requirement is unmet, and the escape hatch stays open.
 */
export function noCheckAnswer(provider: string): RuntimeAuthAnswer {
  return { provider, status: 'unknown', detail: '' }
}

/**
 * What the rest of Settings says when the runtime is not Claude.
 *
 * TWO SECTIONS BELOW MODEL SETTINGS ARE CLAUDE'S, and both went on rendering as
 * if the choice above them had not been made: "This project" assigns a Claude
 * ACCOUNT, and "Model routing" maps effort to Haiku/Sonnet/Opus. A person who
 * had just switched to Codex was shown Anthropic model names as their routing
 * and an Anthropic account as their project's identity.
 *
 * Neither is hidden. The settings still EXIST — they are what Claude threads
 * use, and this project may well have Claude threads in it — so they are shown
 * with the one fact that makes them readable: they belong to Claude, and Claude
 * is not what is selected. Hiding them would make switching back a hunt for
 * settings that appeared to have been deleted.
 */
export function claudeOnlyNote(provider: string, subject: 'accounts' | 'routing'): string | null {
  if (provider === 'claude') return null
  const name = runtimeName(provider)
  return subject === 'accounts'
    ? `New threads here run on ${name}, which keeps its own login — these accounts apply to Claude threads.`
    : `New threads here run on ${name}, which picks its own model for each effort level. This mapping applies to Claude threads.`
}

/**
 * Can Flow sign this runtime out?
 *
 * Codex runs its own `logout`. Copilot has none (measured: `copilot logout` →
 * "Invalid command format"), so Flow removes what it stored — its keychain
 * item and its signed-in record — which the confirmation says out loud, because
 * it is a bigger promise than running a tool's own command. Claude's accounts
 * are removed in their own section, where they have always been.
 */
export function canSignOutHere(provider: string): boolean {
  return provider === 'codex' || provider === 'copilot'
}

/** What the sign-out confirmation asks — different per runtime, because what
 *  happens is different. */
export function signOutConfirm(provider: string): string {
  const name = runtimeName(provider)
  return provider === 'copilot'
    ? `Sign out of ${name} on this machine? ${name} has no sign-out command, so Flow removes the login it saved — its keychain entry and its record of who is signed in. You can sign back in from here.`
    : `Sign out of ${name} on this machine? You can sign back in from here.`
}
