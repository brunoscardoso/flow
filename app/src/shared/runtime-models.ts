// Which models belong to which runtime (multi_runtime_support).
//
// The composer offered Opus / Sonnet / Haiku whatever ran the thread, and the
// thread handed that straight to the runtime. Measured, with Copilot selected
// and signed in:
//
//   copilot -p 'say hi' --output-format json … --model opus
//     → Error: Model "opus" from --model flag is not available.
//
// So sending a message did nothing at all: an Anthropic alias, given to
// GitHub's CLI, by an app that had just been told to run GitHub's CLI.
//
// WHAT THE OTHER TWO GET IS 'auto', AND ONLY 'auto'. That is not laziness —
// it is what could be verified. Copilot's `--model` set is account-specific
// and has no headless listing command; on the machine this was written on,
// `claude-sonnet-4.5` and `gpt-5` were both rejected as "not available" while
// `auto` worked. Offering names that fail at send time is worse than offering
// the one that never does; a runtime picking its own model is a normal thing
// for a runtime to do.

export interface RuntimeModelOption {
  value: string
  label: string
}

/** Plan-flow's own value for "let something else choose". */
export const AUTO_MODEL = 'auto'

/**
 * WHAT THE INSTALLED CLI ACTUALLY ACCEPTS, verified rather than assumed — the
 * whole point of this module is that a name the runtime rejects makes a turn do
 * nothing at all. `claude --help` documents the aliases in as many words:
 *
 *   --model <model>  Provide an alias for the latest model (e.g. 'fable',
 *                    'opus', or 'sonnet') or a model's full name
 *                    (e.g. 'claude-fable-5').
 *
 * `fable` was missing here while the CLI had accepted it all along, so an
 * account with it available was offered three models out of four. Newest first,
 * which is the order the CLI's own example uses.
 */
const CLAUDE_MODELS: readonly RuntimeModelOption[] = [
  { value: AUTO_MODEL, label: 'Auto' },
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
]

/**
 * A KNOWN-GOOD GitHub Copilot catalogue, id → display label (#1929).
 *
 * A stand-in until the live `/models` catalogue is reliable (that fetch needs a
 * token exchange that not every machine's auth allows). These are the ids GitHub
 * Copilot offers across plans as of this writing, with the labels its own picker
 * uses — kept here so the composer/settings pickers show the real, current set
 * instead of a four-item guess. The live catalogue, when it answers, SUPERSEDES
 * this (the built-in only fills in when the fetch comes back empty), so this list
 * going stale degrades to "a bit behind", never to a wrong turn.
 *
 * ORDER IS DISPLAY ORDER — newest / most-capable first within each vendor.
 */
export const COPILOT_MODEL_LABELS: Readonly<Record<string, string>> = {
  'claude-opus-5.5': 'Claude Opus 5.5',
  'claude-opus-5': 'Claude Opus 5',
  'claude-sonnet-5.5': 'Claude Sonnet 5.5',
  'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-fable-5.1': 'Claude Fable 5.1',
  'claude-fable-5': 'Claude Fable 5',
  'claude-opus-4.8': 'Claude Opus 4.8',
  'claude-opus-4.8-fast': 'Claude Opus 4.8 Fast',
  'claude-opus-4.7': 'Claude Opus 4.7',
  'claude-haiku-5.5': 'Claude Haiku 5.5',
  'claude-haiku-4.5': 'Claude Haiku 4.5',
  'gpt-6-astra': 'GPT-6 Astra',
  'gpt-6-luna': 'GPT-6 Luna',
  'gpt-6-sol': 'GPT-6 Sol',
  'gpt-5.6-sol': 'GPT-5.6 Sol',
  'gpt-5.6-terra': 'GPT-5.6 Terra',
  'gpt-5.6-luna': 'GPT-5.6 Luna',
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5-mini': 'GPT-5 Mini',
  'mai-code-1.1-flash': 'MAI Code 1.1 Flash',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'gemini-3.7-flash': 'Gemini 3.7 Flash',
  'gemini-3.6-flash': 'Gemini 3.6 Flash',
  'gemini-3.5-flash': 'Gemini 3.5 Flash',
  'grok-4.7': 'Grok 4.7',
  'grok-4.6': 'Grok 4.6',
  'grok-4.5': 'Grok 4.5',
}

/** Every built-in Copilot model id, display order — the keys of the map above. */
export const COPILOT_BUILTIN_MODEL_IDS: readonly string[] = Object.keys(COPILOT_MODEL_LABELS)

/** Auto means the runtime chooses, which is the only verified answer. */
const RUNTIME_CHOOSES: readonly RuntimeModelOption[] = [{ value: AUTO_MODEL, label: 'Auto' }]

/** What the composer offers for `provider`. */
export function modelOptionsFor(provider: string): readonly RuntimeModelOption[] {
  return provider === 'claude' ? CLAUDE_MODELS : RUNTIME_CHOOSES
}

/**
 * A full Anthropic model id — `claude-opus-5`, `claude-fable-5-1[1m]`.
 *
 * The CLI's contract in its own words: "Provide an alias for the latest model
 * (e.g. 'fable', 'opus', or 'sonnet') or a MODEL'S FULL NAME (e.g.
 * 'claude-fable-5')." The alias list below is the short menu; this is the other
 * half, and without it every id discovered from the account's own catalogue
 * would be dropped at send time and the turn would quietly run on something
 * else.
 */
function isClaudeAlias(model: string): boolean {
  return CLAUDE_MODELS.some((option) => option.value === model)
}

function isClaudeModelId(model: string): boolean {
  return /^claude-[a-z0-9._-]+(\[[a-z0-9]+\])?$/i.test(model) && model.length < 80
}

/** True when `model` is one this provider will actually accept. */
export function isModelFor(provider: string, model: string | null | undefined): boolean {
  if (!model) return false
  if (modelOptionsFor(provider).some((option) => option.value === model)) return true
  return provider === 'claude' && isClaudeModelId(model)
}

/**
 * The model to hand a runtime for a turn, or undefined for "your default".
 *
 * A model the provider does not know is dropped rather than passed — the
 * alternative is the failed turn above. Undefined is always safe: every runtime
 * has a default, and Claude's own path keeps its routing (see the caller).
 */
export function modelForRuntime(
  provider: string,
  model: string | null | undefined,
): string | undefined {
  if (!model || model === AUTO_MODEL) return undefined
  if (provider === 'claude') return isModelFor('claude', model) ? model : undefined
  // ANY OTHER ID BELONGS TO THE USER. Codex and Copilot cannot be asked what an
  // account may use, so the ids come from the person (Settings → Models) and
  // this cannot validate them against a list it does not have. The one thing it
  // CAN know is whose model it is not: an Anthropic ALIAS reaching another CLI
  // is the failed turn this function exists to prevent.
  //
  // AN ALIAS, NOT AN ID, and the difference is a capability. `opus` means
  // nothing to Copilot. `claude-sonnet-4.5` means a great deal — it is on
  // Copilot's own candidate list and was measured running a turn there. Testing
  // `isModelFor('claude', …)` here, once that learned to accept full Anthropic
  // ids, silently stopped sending Copilot the Anthropic models it can actually
  // run. Caught by the suite; kept as its own predicate so widening one cannot
  // narrow the other again.
  return isClaudeAlias(model) ? undefined : model
}

/**
 * Does effort→model routing mean anything here?
 *
 * Only for Claude. The map's values ARE Claude models, and a runtime that picks
 * its own model per turn has nothing for the map to say.
 */
export function supportsModelRouting(provider: string): boolean {
  return provider === 'claude'
}
