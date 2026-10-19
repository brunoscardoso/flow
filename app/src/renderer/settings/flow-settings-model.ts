// flow-settings-model — pure, DOM-free description of the Flow settings v1
// surface: which keys, how they group, their control types + defaults, and the
// dependency guardrails. Keeping this separate keeps flow-settings-view.ts thin
// and lets the rules be unit-tested without a renderer.
//
// Maps to flow/.flowconfig string values; engines are the one non-boolean
// toggle (stored as enabled|declined, read as pending/absent = off).

import type {
  ProvisioningState,
  ResolvedWorktreeSettings,
  WorktreeDefaults,
  WorktreeSettingKey,
  WorktreeSettingSource,
} from '../../shared/ipc-contract'
import { readAliasedKey } from '../../shared/worktree-config-aliases'

export type FieldType = 'toggle' | 'text' | 'number' | 'select'

/**
 * One choice a `select` field offers.
 *
 * `companion` is for a choice that is not complete on its own — "a branch I
 * name" is a decision plus a name, and the two are stored as one value
 * (`<value>:<companion>`) because they are one setting. The alternative was a
 * second key nothing else in the file knows about, which would have made the
 * grammar of the stored value depend on which surface wrote it.
 */
export interface SelectOptionDef {
  value: string
  label: string
  companion?: { placeholder: string }
}

export interface FieldDef {
  key: string
  label: string
  type: FieldType
  help?: string
  /** toggle only — the string written for on/off (defaults 'true'/'false'). */
  onValue?: string
  offValue?: string
  /** toggle default when the key is absent from .flowconfig. */
  defaultOn?: boolean
  /** number only. */
  min?: number
  max?: number
  default?: number
  /**
   * number only — what the stored value is, per unit of what a person types.
   *
   * The refresh wait is stored in milliseconds because that is what a timer
   * takes, and typed in seconds because that is what a person waits. One
   * factor, declared beside the bounds it applies to, so `min`/`max`/`default`
   * are all in the unit shown on screen and nothing has to remember which side
   * of the conversion it is on.
   */
  scale?: number
  /**
   * What a BLANK value falls back to, in the units shown — display only.
   *
   * The project panel never needs it: the resolver hands that surface the value
   * actually in effect, built-in included. The defaults panel has no resolver
   * and no project, so an unset field there is genuinely empty, and a person
   * reading it has no way to know what Flow will do instead unless the control
   * says so. It is a placeholder, never a value: nothing writes it.
   */
  builtin?: string
  /** select only — the choices, in the order they are offered. */
  options?: SelectOptionDef[]
  /**
   * The worktree setting this field IS, when it is one.
   *
   * Presence of this marks the field as inheritable: it has an effective value
   * resolved from three layers (this project, the person's defaults, the
   * built-in), and the panel shows where that value came from plus a way to
   * take it over or hand it back. A field without it is a plain project key.
   */
  setting?: WorktreeSettingKey
}

/**
 * A block a section renders that is NOT a `.flowconfig` key/value.
 *
 * Every field above maps to one key with one value, which is the whole shape
 * `readValues` / `toConfigUpdates` are built around. `learn-budget` does not fit
 * that and must not be bent into it: it is a CONSTANT, read-only — a number the
 * orchestrator owns, surfaced so the user understands why background re-learns
 * stop.
 *
 * A `loops` marker lived here too, for a section listing every loop with its own
 * switch. It is GONE, and not because it was wrong: loops are configured in the
 * Loops screen now, opened from the board strip that shows their status, because
 * a setting two overlays away from the thing it configures is a setting nobody
 * finds. Nothing about this file's key machinery changed with it — that section
 * never held a key.
 *
 * `thread-worktrees` is the second: a way IN to the list of every copy this
 * project is holding. It is not a key either — it configures nothing, it opens
 * something. It lives here because this section is where "should a conversation
 * work on a branch of its own" is already decided, and it is reachable from any
 * conversation, including one that has no files of its own and therefore never
 * sees the Source Control door.
 *
 * The view renders each block after its section's fields. This is the Learning
 * block's own special-casing, promoted from a title string-compare to a typed
 * marker: a title is display copy, and behaviour keyed on display copy breaks
 * silently the day somebody rewords a heading.
 */
export type SectionExtra = 'learn-budget' | 'thread-worktrees'

export interface SectionDef {
  /**
   * A stable id for a section another surface opens the panel AT. Display
   * copy is never the address.
   */
  id?: string
  title: string
  fields: FieldDef[]
  /** A non-key block this section renders below its fields, if any. */
  extra?: SectionExtra
}

/**
 * The section heading the three remaining inheritable fields live under.
 *
 * IT IS DECLARED ABOVE THE TABLE THAT USES IT, and the table reads it rather
 * than repeating the string. The heading used to be the word this change
 * removed from the product, in the one place a person would still have read
 * it: a tab, a section title and a defaults heading all spelling out the
 * internal noun for a directory Flow makes. What the section actually decides
 * is what a conversation keeps on disk, which is what it now says.
 */
export const WORKTREE_SECTION_TITLE = 'Conversation files'

/** The section heading the per-project runtime provider select lives under. */
export const RUNTIME_SECTION_TITLE = 'Runtime'

/** v1 sections — Notifications (webhook/telegram) deferred to v2. */
export const FLOW_SETTINGS_SECTIONS: SectionDef[] = [
  {
    // Runtime — which agent runtime this project runs under. A plain project
    // key (`provider`), NOT an inheritable worktree setting: it has no `setting`
    // key and must not go through the three-layer resolver. The `inherit` option
    // is FIRST so an absent `provider:` key reads back as inherit through
    // `splitSelectValue`'s options[0] fallback, and choosing it UNSETS the key
    // (the view maps 'inherit' → null) rather than writing the literal string.
    title: RUNTIME_SECTION_TITLE,
    fields: [
      {
        key: 'provider',
        label: 'Agent runtime',
        type: 'select',
        help: 'Which agent runtime this project runs under. Pin one here, or inherit the app-wide default.',
        options: [
          { value: 'inherit', label: 'Inherit app default' },
          { value: 'claude', label: 'Claude (Anthropic)' },
          { value: 'codex', label: 'Codex (OpenAI)' },
          { value: 'copilot', label: 'GitHub Copilot' },
        ],
      },
    ],
  },
  {
    title: 'Autopilot',
    fields: [
      { key: 'autopilot', label: 'Autopilot', type: 'toggle', help: 'Auto-chain commands through the flow' },
    ],
  },
  {
    title: 'Git & PR',
    fields: [
      { key: 'commit', label: 'Auto-commit per task', type: 'toggle' },
      { key: 'push', label: 'Auto-push when done', type: 'toggle' },
      // The base branch used to live here, called the "target branch". It moved
      // to Conversation files, where it says what it does: it is what a worktree is CUT
      // FROM as well as what a pull request opens against, and only the second
      // half of that has anything to do with pushing.
      { key: 'pr', label: 'Auto-create PR', type: 'toggle', help: 'Requires push + commit' },
    ],
  },
  {
    title: 'Execution',
    fields: [
      // defaultOn mirrors the CLI's DEFAULT_CONFIG (#1957). Without it an
      // absent key renders OFF while /execute-plan routes — the panel would
      // show the opposite of what runs.
      { key: 'model_routing', label: 'Model routing', type: 'toggle', defaultOn: true },
      { key: 'phase_isolation', label: 'Phase isolation', type: 'toggle', defaultOn: true },
      { key: 'wave_execution', label: 'Wave execution', type: 'toggle', defaultOn: true },
      { key: 'max_verify_retries', label: 'Max verify retries', type: 'number', min: 1, max: 5, default: 2 },
      {
        // The walkthrough page is the largest single thing a discovery writes
        // and none of it is reasoning, so it runs a tier below the session by
        // default. The first option is what an absent key reads as.
        key: 'walkthrough_model',
        label: 'Artifact model',
        type: 'select',
        help: 'The model that writes a discovery\'s artifact — the walkthrough of what people will see. Claude only: other runtimes use the thread\'s own model.',
        options: [
          { value: 'sonnet', label: 'Sonnet (recommended)' },
          { value: 'opus', label: 'Opus' },
          { value: 'haiku', label: 'Haiku' },
        ],
      },
    ],
  },
  // NO ENGINES SECTION, because no engine takes a user's consent any more.
  // Graphify has been always-on since #142 — availability-gated, with any
  // legacy `engines.graphify` value ignored by the derive gate — and lavish is
  // retired: `/create-plan` never checks `engines.lavish` and never invokes
  // lavish, whatever it is set to.
  //
  // The section used to hold exactly one switch, and it was that dead key
  // (#1807). Flipping it wrote `engines.lavish` to `flow/.flowconfig` and
  // changed nothing anywhere — a control whose whole effect was to look like
  // one, which is the same promise a command in UI text makes
  // (forbidden-pattern #12) with a click on the end of it. A section with no
  // field that is read is not a section.
  {
    // Conversation files — three settings about what a conversation keeps on disk.
    //
    // IT USED TO HOLD TEN (worktree-ui-removal Phase 5, task 5.4). Seven of
    // them configured the checkout itself — which remote, how branches are
    // named, what the base is, where a new one starts, whether the base is
    // refreshed first and for how long, how long setup may take — and every
    // one of them belonged to a surface that managed a conversation's files as
    // an object. Those surfaces are gone, so the controls for them are too.
    //
    // THE KEYS THEY WROTE ARE NOT GONE. The CLI still reads all seven out of
    // the project's own config file and behaves exactly as it did; what was
    // removed is a panel in this app that offered to set them. A project that
    // needs a different remote or a longer setup still gets one — through the
    // tool that acts on it.
    //
    // Every field here is INHERITABLE (`setting`): the value shown is the one
    // in effect, and it may come from this project, from the person's defaults,
    // or from the built-in behaviour. NO KEY IS EVER SHOWN (forbidden-pattern
    // #12) — the label and the help are the whole of what a person reads.
    title: WORKTREE_SECTION_TITLE,
    extra: 'thread-worktrees',
    fields: [
      {
        key: 'thread_worktrees',
        // IT NAMES THE BRANCH, not the directory behind it. Two labels ago this
        // said "Give each thread its own worktree", which stopped being true
        // when threads stopped getting one automatically; one label ago it said
        // "their own" one of those, which was true and still the wrong noun — the
        // copy is Flow's bookkeeping, and the branch is the whole of what a
        // person ever sees or asks for.
        label: 'Let a conversation work on its own branch',
        type: 'toggle',
        defaultOn: true,
        setting: 'threadWorktrees',
        // WHO GETS ONE, AND WHEN. The three cases in the order a person meets
        // them: you ask when you start it, you ask later from its menu, and a
        // loop takes one because nobody is watching it. Off means none of the
        // three.
        help: 'A conversation can do its work on a branch of its own instead of in your files — choose that when you start it, or ask from its menu later. Work an agent picks up on its own always gets a branch. Turn this off and everything runs in the project.',
      },
      {
        key: 'worktree_cap',
        label: 'How many conversations keep files',
        type: 'number',
        setting: 'worktreeCap',
        min: 1,
        max: 100,
        default: 10,
        // WHAT IT COSTS AND WHAT IT PROTECTS, in that order. The number was
        // hardcoded before this row existed, so the first thing a reader needs
        // is that a limit is being enforced at all — and the second is that it
        // has never been able to take work, which is the fear the sentence has
        // to answer before somebody sets it to 100 to be safe.
        help: 'How many conversations may keep files of their own on disk. Past this, the oldest one whose work has already landed is freed. One that still holds work is never touched, whatever this says.',
      },
      {
        key: 'worktree_setup',
        label: 'Prepare a new conversation',
        type: 'text',
        setting: 'worktreeSetup',
        // WHAT IT IS FOR, THEN WHAT IT COSTS. The files a conversation gets are
        // the ones git tracks and no others, which is why a fresh set often
        // cannot build — and the second sentence is the one nobody would guess:
        // a project that fills this in stops sharing the main checkout's
        // installed packages, which is exactly what makes an install land here
        // instead of there.
        help: 'A command to run once for each conversation that gets files of its own, before the agent starts — an install, a generated client, whatever this project needs that git does not carry. Filling this in gives each conversation its own installed packages instead of sharing yours.',
      },
    ],
  },
  {
    // Progressive-learning (#513 phase 8). `learn_auto` gates the GUARDED auto
    // re-learn only — always-on staleness (the board dot flipping on drift) is
    // free and never gated. Default ON. The read-only session-budget line is
    // rendered by the view (it is a constant, not a persisted config key).
    title: 'Learning',
    extra: 'learn-budget',
    fields: [
      {
        key: 'learn_auto',
        label: 'Auto re-learn on change',
        type: 'toggle',
        defaultOn: true,
        help: 'Re-learn a module after meaningful edits (budget-limited per session)',
      },
      {
        key: 'learn_ignore',
        label: 'Ignore modules',
        type: 'text',
        help: 'Comma-separated module paths/prefixes to skip when learning (on top of built-ins: mocks, tests, e2e, fixtures, dot-dirs)',
      },
    ],
  },
]

/**
 * Auto re-learns admitted per session before the budget drops further auto
 * items (deliberate learns always run). Mirrors the orchestrator's
 * DEFAULT_BUDGET — surfaced read-only in the Learning settings block so the
 * user understands why background re-learns stop after a burst of churn.
 */
export const LEARN_SESSION_BUDGET = 10

/** The read-only budget line shown under the Learning toggle. */
export function learnBudgetText(budget: number = LEARN_SESSION_BUDGET): string {
  return `Auto re-learns per session: ${budget}`
}

export type FieldValue = boolean | number | string
export type FlowSettingsValues = Record<string, FieldValue>

/**
 * What the provider select's chosen value WRITES to .flowconfig.
 *
 * The `inherit` option is not a value to store — it means "no project override,
 * use the app default" — so it clears the key (null) rather than writing the
 * literal string 'inherit'. Every concrete provider writes itself. Kept here,
 * pure, so the view routes its write through one named code path
 * (allowed-pattern #14) and a test can reach the mapping without a renderer.
 */
export function providerWriteValue(selectValue: string): string | null {
  return selectValue === 'inherit' ? null : selectValue
}

/** Every field, flattened. */
export function allFields(): FieldDef[] {
  return FLOW_SETTINGS_SECTIONS.flatMap((section) => section.fields)
}

function onValueOf(field: FieldDef): string {
  return field.onValue ?? 'true'
}

function clampNumber(field: FieldDef, raw: number): number {
  const min = field.min ?? Number.NEGATIVE_INFINITY
  const max = field.max ?? Number.POSITIVE_INFINITY
  return Math.min(max, Math.max(min, raw))
}

/**
 * Resolve an edited number field to a valid value (#369). An empty / non-finite
 * entry reverts to the current effective value (or the field default); a finite
 * entry is clamped into [min, max]. Guards the "clearing the field leaves it blank
 * with no min-1 validation" case — the view then writes this back so the input never
 * shows an empty/invalid value.
 */
export function resolveNumberInput(
  field: FieldDef,
  rawInput: string,
  current: number | undefined,
): number {
  const parsed = Number.parseInt(rawInput, 10)
  if (!Number.isFinite(parsed)) {
    return clampNumber(field, current ?? field.default ?? 0)
  }
  return clampNumber(field, parsed)
}

/**
 * Coerce a raw flow/.flowconfig record into typed field values.
 *
 * The values here are in the units a person SEES: a wait stored as 8000 reads
 * back as 8, because `min`/`max`/`default` are seconds and a clamp against the
 * stored milliseconds would pin every value to the ceiling.
 */
export function readValues(config: Record<string, string>): FlowSettingsValues {
  const values: FlowSettingsValues = {}
  for (const field of allFields()) {
    // A renamed key reads under its old spelling when the new one is absent —
    // the shared alias table, the same rule every other reader follows.
    const raw = readAliasedKey(config, field.key)
    if (field.type === 'toggle') {
      values[field.key] = raw === undefined ? field.defaultOn === true : raw === onValueOf(field)
    } else if (field.type === 'number') {
      const stored = raw === undefined ? undefined : Number.parseInt(raw, 10)
      const shown =
        stored === undefined || !Number.isFinite(stored)
          ? (field.default ?? 0)
          : Math.round(stored / (field.scale ?? 1))
      values[field.key] = clampNumber(field, shown)
    } else {
      values[field.key] = raw ?? ''
    }
  }
  return values
}

/** The string a field's value writes to .flowconfig. */
function toConfigString(field: FieldDef, value: FieldValue): string {
  if (field.type === 'toggle') return value ? onValueOf(field) : (field.offValue ?? 'false')
  if (field.type === 'number') {
    const shown = clampNumber(field, Number(value) || (field.default ?? 0))
    return String(shown * (field.scale ?? 1))
  }
  return String(value ?? '')
}

/**
 * Enforce dependencies after a single field changed, returning the fully-
 * corrected value set (the UI diffs before/after to know what to write):
 *   - turning Auto-PR ON forces push + commit ON
 *   - turning push OFF (or commit OFF) clears Auto-PR
 */
export function applyDependencies(
  values: FlowSettingsValues,
  changedKey: string,
): FlowSettingsValues {
  const next: FlowSettingsValues = { ...values }
  if (changedKey === 'pr' && next.pr === true) {
    next.push = true
    next.commit = true
  }
  if ((changedKey === 'push' && next.push === false) || (changedKey === 'commit' && next.commit === false)) {
    next.pr = false
  }
  return next
}

/**
 * Keys that should render disabled given the current values.
 *
 * The base branch used to be here, greyed out until auto-push was on, and that
 * was right while it was called the target branch: a branch you only push to
 * is meaningless when nothing pushes. It is now what every worktree is CUT
 * FROM, which happens whether or not this project ever pushes anything — so
 * gating it on auto-push would have hidden the setting from exactly the
 * projects that use worktrees without the pipeline.
 *
 * Nothing is value-gated today. The function stays because it is the seam the
 * view and the field renderer already ask, and a guardrail added later belongs
 * here rather than in a branch of the renderer. (Inheritance is NOT this: an
 * inherited field is disabled because nobody has taken it over, which is per-
 * field provenance, not a dependency between values.)
 */
export function disabledKeys(_values: FlowSettingsValues): Set<string> {
  return new Set<string>()
}

/** Minimal `.flowconfig` string writes for the fields that changed. */
export function toConfigUpdates(
  before: FlowSettingsValues,
  after: FlowSettingsValues,
): Record<string, string> {
  const updates: Record<string, string> = {}
  for (const field of allFields()) {
    const b = toConfigString(field, before[field.key])
    const a = toConfigString(field, after[field.key])
    if (a !== b) updates[field.key] = a
  }
  return updates
}

// ── Worktree settings: inheritance, composition, validation ───────────────
//
// The Conversation files section is the first part of this panel whose values do not
// come from the project alone. Each of its fields answers through three layers
// — this project's own file, the person's app-wide defaults, the built-in
// behaviour — and the panel's job is to show the value IN EFFECT plus where it
// came from, so "we publish to origin because we said so" and "we publish to
// origin because nobody has ever been asked" stop looking identical.
//
// Everything below is pure. The resolver in the main process decides the
// values and the provenance; this module only translates that answer into what
// the controls show, and back into the strings a write carries.

/**
 * The section heading the Git & PR fields live under.
 *
 * Moved to the unified Settings page's Conversation files tab (worktree_settings_ui) —
 * plain project keys, not inheritable settings, so they render beside the
 * Publish-to/Branch-naming/Base-branch fields rather than through
 * `worktreeFields()`'s three-layer machinery. The per-project Flow settings
 * overlay no longer renders this section (see its `#renderSections`).
 */
export const GIT_PR_SECTION_TITLE = 'Git & PR'

/** The plain project-only fields under Git & PR, in display order. */
export function gitPrFields(): FieldDef[] {
  return FLOW_SETTINGS_SECTIONS.find((section) => section.title === GIT_PR_SECTION_TITLE)?.fields ?? []
}

/** Every field that resolves through the three layers, in display order. */
export function worktreeFields(): FieldDef[] {
  return allFields().filter((field) => field.setting !== undefined)
}

/**
 * The field that IS a given worktree setting, or undefined when none is.
 *
 * Derived from the field table rather than declared as a second mapping: the
 * `.flowconfig` spelling of each setting already lives in exactly one place per
 * process (the resolver's own table in main, these `key`s here), and a third
 * copy would be the one that silently disagrees.
 */
export function fieldForSetting(setting: WorktreeSettingKey): FieldDef | undefined {
  return worktreeFields().find((field) => field.setting === setting)
}

/**
 * A select value split into the choice and the name it carries.
 *
 * An option with a `companion` stores `<value>:<name>`; every other option is
 * its own value. An unrecognised string falls back to the first option rather
 * than to nothing, so a value typed by hand into the file can never leave the
 * control blank.
 */
export function splitSelectValue(
  field: FieldDef,
  raw: string,
): { option: string; companion: string } {
  const options = field.options ?? []
  const exact = options.find((option) => option.value === raw)
  if (exact !== undefined) return { option: exact.value, companion: '' }
  for (const option of options) {
    if (option.companion !== undefined && raw.startsWith(`${option.value}:`)) {
      return { option: option.value, companion: raw.slice(option.value.length + 1).trim() }
    }
  }
  return { option: options[0]?.value ?? '', companion: '' }
}

/** The stored string for a chosen option plus the name it carries (if any). */
export function joinSelectValue(field: FieldDef, option: string, companion: string): string {
  const chosen = (field.options ?? []).find((candidate) => candidate.value === option)
  if (chosen?.companion === undefined) return option
  return `${option}:${companion.trim()}`
}

/** One field's resolved answer: the value in effect and the layer it came from. */
export interface InheritableState {
  value: FieldValue
  source: WorktreeSettingSource
}

/**
 * The resolver's answer, translated into what each control shows.
 *
 * Keyed by FIELD key so the view can merge it straight over `readValues`: for
 * an inherited field the project file has no key at all, and `readValues` would
 * otherwise show this module's own built-in rather than the default actually in
 * effect — the exact lie provenance exists to prevent.
 */
export function worktreeFieldStates(
  settings: ResolvedWorktreeSettings,
): Record<string, InheritableState> {
  // ONE ENTRY, AND THE RESOLVER STILL ANSWERS FOR TEN. The other six that used
  // to be translated here had controls on this panel; those controls are gone,
  // so there is nothing for their provenance to decorate. The resolver, the
  // contract and the keys are all untouched — the CLI reads them exactly as
  // before — and the day one of them gets a control again, its line comes back
  // here and nowhere else.
  return {
    thread_worktrees: {
      value: settings.threadWorktrees.value,
      source: settings.threadWorktrees.source,
    },
  }
}

/** The section heading the app-wide defaults live under. */
export const WORKTREE_DEFAULTS_TITLE = 'Conversation file defaults'

/**
 * What the defaults section says about itself, and what it says about projects.
 *
 * Two sentences, because a person opening this panel has two questions: what
 * these values are for, and whether setting one takes a decision away from a
 * project that already made it. Neither names a file, a key or a command
 * (forbidden-pattern #12) — "its own value" is the whole of what a reader needs
 * to know about where an override lives.
 */
export const WORKTREE_DEFAULTS_NOTE = 'Every project uses these until it sets its own value.'
export const WORKTREE_DEFAULTS_OVERRIDE_NOTE =
  'Projects can override any of these in their own Flow settings.'

/**
 * The app-wide defaults, translated into what each control shows.
 *
 * Keyed by FIELD key, exactly like `worktreeFieldStates`, so the defaults panel
 * feeds the shared row renderer the same shape the project panel does. The
 * provenance here has only two cases: a default this person set (`global` — the
 * layer this panel owns), or nothing set at all, in which case what happens is
 * Flow's built-in (`default`). It is read FROM KEY PRESENCE, never from value
 * equality — a person who deliberately set the remote to `origin` and a person
 * who has never opened this panel must not read as the same state.
 */
export function worktreeDefaultsStates(
  defaults: Partial<WorktreeDefaults>,
): Record<string, InheritableState> {
  const raw: Record<string, string> = {}
  for (const field of worktreeFields()) {
    const stored = field.setting === undefined ? undefined : defaults[field.setting]
    // A BLANK VALUE READS AS ABSENT, exactly as the resolver reads it. A
    // default cleared back to nothing has no effect on any project — the
    // built-in answers — so reporting the row as one this person owns would be
    // provenance saying the opposite of what is happening.
    if (stored !== undefined && stored.trim() !== '') raw[field.key] = stored.trim()
  }
  // One coercion path with the project panel: the same strings, the same units
  // on screen (the wait is typed in seconds and stored in milliseconds), and no
  // second parser that could read a stored value differently here.
  const values = readValues(raw)
  const states: Record<string, InheritableState> = {}
  for (const field of worktreeFields()) {
    states[field.key] = {
      value: values[field.key],
      source: raw[field.key] === undefined ? 'default' : 'global',
    }
  }
  return states
}

/**
 * Which panel a row is drawn on — the layer whose values that panel writes.
 *
 * The same field is rendered by two surfaces that sit on top of DIFFERENT
 * layers, and every piece of copy on the row depends on which. "Inherited from
 * your defaults" is the honest thing to say to a project reading a default; it
 * is a lie on the panel where that default was typed. Rather than let each view
 * write its own chips and labels — the way two surfaces start describing one
 * setting as two — the layer is a parameter and the words stay here.
 */
export type SettingsLayer = 'project' | 'global'

/**
 * Whether the value shown came from a layer BELOW the one being edited.
 *
 * The project panel inherits anything it did not write itself; the defaults
 * panel has only the built-in beneath it, so a global default IS this panel's
 * own value and its control must stay editable. Reading `source !== 'project'`
 * on the defaults panel would grey out every default the person had set.
 */
export function isInheritedValue(
  source: WorktreeSettingSource,
  layer: SettingsLayer = 'project',
): boolean {
  return layer === 'global' ? source === 'default' : source !== 'project'
}

/**
 * What the provenance chip says, or null when this panel's layer owns the value.
 *
 * An owned value gets NO chip: it is the ordinary case, and a badge on every row
 * would make the two states equally loud. On the project panel the two inherited
 * cases are named separately because they lead somewhere different — one is a
 * default the person set and can change, the other is what the app has always
 * done. On the defaults panel only the second of those can be below.
 */
export function provenanceChipText(
  source: WorktreeSettingSource,
  layer: SettingsLayer = 'project',
): string | null {
  if (!isInheritedValue(source, layer)) return null
  if (source === 'global') return 'Inherited from your defaults'
  if (source === 'default') return "Flow's default"
  return null
}

/**
 * The label on the switch beside an inheritable field.
 *
 * Handing a value back REMOVES it — the project's key, or the person's default
 * — which is the one destructive thing either panel can do, so it is only ever
 * reached by pressing a control that says so (forbidden-pattern #15), never by
 * clearing a field or by a write that happens to omit a key.
 */
export function inheritActionLabel(
  source: WorktreeSettingSource,
  layer: SettingsLayer = 'project',
): string {
  const inherited = isInheritedValue(source, layer)
  if (layer === 'global') return inherited ? 'Set my own default' : "Use Flow's default"
  return inherited ? 'Use a project value' : 'Inherit'
}

/** The label on the small action beside a chip, or null when it leads nowhere. */
export const OPEN_DEFAULTS_ACTION = 'Open defaults'

/**
 * What the chip's action offers, or null when the chip is not a door.
 *
 * Only one provenance leads anywhere a person can act: a project reading a
 * default the SAME person set, one overlay away. "Flow's default" leads nowhere
 * — there is nothing to open and nothing to change — and the defaults panel is
 * already the place the door would lead to.
 */
export function chipActionLabel(
  source: WorktreeSettingSource,
  layer: SettingsLayer = 'project',
): string | null {
  return layer === 'project' && source === 'global' ? OPEN_DEFAULTS_ACTION : null
}

/**
 * Whether the value on screen is nothing at all.
 *
 * Only text fields can be blank — a switch is on or off, a number is a number,
 * and a choice always resolves to one of its options — so in practice this is
 * the base branch and the naming pattern, the two settings whose honest
 * built-in is "none".
 */
export function isBlankFieldValue(value: FieldValue): boolean {
  return typeof value === 'string' && value.trim() === ''
}

/**
 * What pressing "take this over" must actually do.
 *
 * A take-over normally writes the value already on screen — nothing about the
 * value changes, only who owns it. THAT DOES NOT WORK WHEN THERE IS NO VALUE.
 * The base branch and the naming pattern inherit as blank, and writing a blank
 * is writing nothing: the merge puts an empty key in the file, the resolver
 * reads a blank as absent at every layer, and the row snaps straight back to
 * inherited — a press that looks like it did something and did not.
 *
 * So a blank take-over is `own`: the row becomes editable HERE, with no write
 * at all, and the first real value the person types is what makes this layer
 * the owner. Nothing is removed and nothing is written until they say something
 * (forbidden-pattern #15 is untouched — the only removal is still the explicit
 * press in the other direction).
 */
export function takeOverAction(value: FieldValue): 'write' | 'own' {
  return isBlankFieldValue(value) ? 'own' : 'write'
}

/**
 * What a change on a row that was taken over but never written must do.
 *
 * A real value is written and settles the ownership; a value still blank is
 * the person leaving without deciding, so the row hands itself back to the
 * layer below rather than sitting owned-but-empty — a state that would render
 * identically to an inherited blank while quietly meaning something else.
 */
export function ownedEditAction(value: FieldValue): 'write' | 'release' {
  return isBlankFieldValue(value) ? 'release' : 'write'
}

/**
 * The provenance an owned-editing row shows: the layer its own panel writes.
 *
 * Not a fourth source. The row is being edited as this layer's value, so it
 * reads exactly like one that already is — editable control, no chip, and a
 * switch offering to hand it back — and the moment the write lands the resolver
 * says the same thing on its own.
 */
export function ownedEditingSource(layer: SettingsLayer = 'project'): WorktreeSettingSource {
  return layer === 'global' ? 'global' : 'project'
}

/**
 * What the panel says beside the switch when it is OFF.
 *
 * Turning it off does not reclaim anything: the files that exist stay on disk
 * and stay bound to their conversations until someone frees them. Saying so
 * beside the switch is the difference between a setting and a surprise.
 */
export const WORKTREES_OFF_NOTE =
  'A conversation already on its own branch stays there until you free its files; new ones work in the project itself.'

/** The off-state note, or null while the switch is on. */
export function worktreesOffNote(on: boolean): string | null {
  return on ? null : WORKTREES_OFF_NOTE
}

// ── Validation (allowed-pattern #22: validated where typed, never sanitized) ─

/**
 * What a typed value is: fine, usable-but-worth-saying, or not written at all.
 *
 * A REFUSAL IS NOT A WRITE. These values were typed deliberately, so a value
 * the panel cannot accept is reported and left on screen for the person to fix
 * — never quietly corrected into something they did not ask for. A warning is
 * the opposite case: the value is written, and the panel says what it noticed.
 */
export type FieldValidation = { ok: true } | { warning: string } | { refusal: string }

/** Whether a validation result blocks the write. */
export function isRefusal(result: FieldValidation): result is { refusal: string } {
  return 'refusal' in result
}

/**
 * What the panel knows about the project while validating, when it knows it.
 *
 * EMPTY, AND KEPT. The one thing it ever carried was the project's remotes,
 * read to warn about a remote nobody had added yet — and the field that asked
 * for a remote is gone. The parameter stays because every caller passes it and
 * the next inheritable field to need project context will want it back; it
 * costs nothing and removing it would churn four call sites for no behaviour.
 */
export interface WorktreeFieldContext {
  [key: string]: never
}

/**
 * Whether a typed worktree value can be written, and what to say about it.
 *
 * Pure, and keyed by field so the global defaults panel validates identically
 * to the project one — the two surfaces write the same grammar into different
 * stores, and a value one accepted and the other refused would be a setting
 * nobody could reason about.
 *
 * A BLANK VALUE IS ALWAYS FINE. Blank means "nothing here", which every one of
 * these settings has an honest answer for, and refusing it would leave a person
 * unable to clear a field they had filled in.
 */
export function validateWorktreeField(
  key: string,
  value: string,
  _context: WorktreeFieldContext = {},
): FieldValidation {
  const trimmed = value.trim()
  if (trimmed === '') return { ok: true }

  if (key === 'worktree_cap') {
    const field = fieldForSetting('worktreeCap')
    const min = field?.min ?? 1
    const max = field?.max ?? 100
    const kept = Number(trimmed)
    if (!/^\d+$/.test(trimmed) || kept < min || kept > max) {
      // ZERO IS WHY THIS REFUSES RATHER THAN CLAMPS. Typed here it reads as
      // "keep none", and what it would actually mean is that every landed
      // conversation is above the line on every sweep. The resolver clamps a
      // value that reached the file some other way; a value being TYPED is
      // told (allowed-pattern #22).
      return { refusal: `Flow can keep files for between ${min} and ${max} conversations.` }
    }
    return { ok: true }
  }

  return { ok: true }
}

/**
 * The string a field's value writes into the file.
 *
 * Exported for the ONE path the value diff cannot express: taking over an
 * inherited value writes the value already on screen, so before and after are
 * equal and `toConfigUpdates` correctly emits nothing. That write is not a
 * change of value at all — it is a change of who owns it — and it has to name
 * the string itself.
 */
export function fieldConfigString(field: FieldDef, value: FieldValue): string {
  return toConfigString(field, value)
}

// ── Provisioning status (ide-auto-provisioning, phase 5) ────────────────────
// Pure, DOM-free display logic for the settings surface's per-root
// "Plan-flow provisioning" row: status text + whether "Re-provision now"
// should be actionable. The view (flow-settings-view.ts) owns fetching the
// RegisteredProject and wiring the button; this module only derives what to show.

/** The provision-relevant slice of a root (matches the contract's RegisteredProject). */
export interface ProvisioningInfo {
  available?: boolean
  provisionedAt?: string
  provisionedVersion?: string
  /** Live readiness (#513). The card never read it, so a RUNNING provision was
   *  reported with the never-run wording (#1528). */
  provisioningState?: ProvisioningState
}

/**
 * Deterministic, locale-free "YYYY-MM-DD HH:MM" rendering of an ISO timestamp
 * (never throws; an unparseable input is returned as-is).
 */
export function formatProvisionedAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toISOString().slice(0, 16).replace('T', ' ')
}

/**
 * Status line for the provisioning row:
 *   root unreachable            → "Unavailable — project folder not found"
 *   provision running           → "Setting up…"          (#1528)
 *   last provision failed       → "Setup failed — …"     (#1528)
 *   unknown root / no stamp yet → "Not provisioned"
 *   stamped                     → "v<version> · provisioned <date>"
 *
 * #1528: the card was blind to `provisioningState`, so while the automatic
 * provision was actually RUNNING it printed "Not provisioned" — the same words
 * a never-run project gets — on a panel that auto-opens by itself the first
 * time an unconfigured project is selected. The sidebar row rendered the same
 * record correctly as "setting up…" in the very same frame.
 */
export function provisioningStatusText(info: ProvisioningInfo | undefined): string {
  if (info?.available === false) return 'Unavailable — project folder not found'
  if (info?.provisioningState === 'provisioning') return 'Setting up…'
  // A failed run leaves the root unstamped, so without this it also read as
  // "Not provisioned" — the wording that invites no action from someone who has
  // no idea an attempt was ever made.
  if (info?.provisioningState === 'failed' && !info.provisionedAt) {
    return 'Setup failed — try Re-provision now'
  }
  if (!info?.provisionedAt || !info.provisionedVersion) return 'Not provisioned'
  // The stamp may carry the assets hash (`1.4.3+3f9a…`); a reader wants the version.
  return `v${info.provisionedVersion.split('+')[0]} · provisioned ${formatProvisionedAt(info.provisionedAt)}`
}

/**
 * "Re-provision now" is only actionable for a reachable, known root that is not
 * already provisioning (#1528) — the main process discards a click while a run
 * is in flight, so offering it is a dead click on the app's first-run path.
 */
export function canReprovision(info: ProvisioningInfo | undefined): boolean {
  return info !== undefined && info.available !== false && info.provisioningState !== 'provisioning'
}
