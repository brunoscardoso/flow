// flow-settings-model — value coercion, dependency guardrails, and the diff.

import type { ResolvedWorktreeSettings } from '../../shared/ipc-contract'

import {
  FLOW_SETTINGS_SECTIONS,
  LEARN_SESSION_BUDGET,
  WORKTREE_SECTION_TITLE,
  WORKTREES_OFF_NOTE,
  applyDependencies,
  canReprovision,
  disabledKeys,
  fieldConfigString,
  fieldForSetting,
  formatProvisionedAt,
  inheritActionLabel,
  isBlankFieldValue,
  isInheritedValue,
  isRefusal,
  joinSelectValue,
  learnBudgetText,
  ownedEditAction,
  ownedEditingSource,
  providerWriteValue,
  provenanceChipText,
  provisioningStatusText,
  readValues,
  resolveNumberInput,
  WORKTREE_DEFAULTS_NOTE,
  WORKTREE_DEFAULTS_OVERRIDE_NOTE,
  WORKTREE_DEFAULTS_TITLE,
  chipActionLabel,
  splitSelectValue,
  takeOverAction,
  worktreeDefaultsStates,
  toConfigUpdates,
  validateWorktreeField,
  worktreeFieldStates,
  worktreeFields,
  worktreesOffNote,
  type FieldDef,
} from './flow-settings-model'

describe('resolveNumberInput (#369)', () => {
  const retries: FieldDef = { key: 'max_verify_retries', label: '', type: 'number', min: 1, max: 5, default: 2 }

  it('keeps a valid in-range value', () => {
    expect(resolveNumberInput(retries, '3', 3)).toBe(3)
  })

  it('clamps an out-of-range entry into [min, max]', () => {
    expect(resolveNumberInput(retries, '9', 2)).toBe(5)
    expect(resolveNumberInput(retries, '0', 2)).toBe(1)
  })

  it('reverts an EMPTY entry to the current effective value (not blank/NaN)', () => {
    expect(resolveNumberInput(retries, '', 4)).toBe(4)
  })

  it('reverts to the field default when empty and there is no current value', () => {
    expect(resolveNumberInput(retries, '', undefined)).toBe(2)
  })

  it('clamps the fallback too (a stale out-of-range current is not trusted)', () => {
    expect(resolveNumberInput(retries, 'abc', 99)).toBe(5)
  })
})

describe('readValues', () => {
  it('coerces toggles, numbers, text and engine on/off with defaults', () => {
    const v = readValues({
      autopilot: 'true',
      commit: 'false',
      worktree_setup: 'npm ci',
      max_verify_retries: '3',
      'engines.lavish': 'enabled', // retired engine — no longer a field (#1807)
      'engines.graphify': 'declined', // legacy value — no longer a field (#142)
    })
    expect(v.autopilot).toBe(true)
    expect(v.commit).toBe(false)
    expect(v.worktree_setup).toBe('npm ci')
    expect(v.max_verify_retries).toBe(3)
    // The base branch no longer has a FIELD, so this reader has no key to
    // coerce for it — the CLI reads it straight from the file (C2).
    expect(v.branch).toBeUndefined()
    // NEITHER engine key is surfaced any more. Graphify has been always-on
    // since #142; lavish is retired, and `/create-plan` never reads its key
    // whatever it says (#1807). A value sitting in someone's flowconfig from
    // before either change is ignored rather than shown back to them as a
    // setting that works.
    expect(v['engines.lavish']).toBeUndefined()
    expect(v['engines.graphify']).toBeUndefined()
    // absent → defaults: phase_isolation/wave_execution default ON
    expect(v.phase_isolation).toBe(true)
    expect(v.wave_execution).toBe(true)
    expect(v.pr).toBe(false)
    expect(v.max_verify_retries).toBe(3)
  })

  it('clamps max_verify_retries into range and defaults when absent', () => {
    expect(readValues({ max_verify_retries: '9' }).max_verify_retries).toBe(5)
    expect(readValues({ max_verify_retries: '0' }).max_verify_retries).toBe(1)
    expect(readValues({}).max_verify_retries).toBe(2)
  })
})

describe('applyDependencies', () => {
  it('turning Auto-PR on forces push + commit on', () => {
    const before = readValues({ commit: 'false', push: 'false', pr: 'false' })
    const after = applyDependencies({ ...before, pr: true }, 'pr')
    expect(after.pr).toBe(true)
    expect(after.push).toBe(true)
    expect(after.commit).toBe(true)
  })

  it('turning push off clears Auto-PR', () => {
    const before = readValues({ commit: 'true', push: 'true', pr: 'true' })
    const after = applyDependencies({ ...before, push: false }, 'push')
    expect(after.pr).toBe(false)
  })

  it('turning commit off clears Auto-PR', () => {
    const before = readValues({ commit: 'true', push: 'true', pr: 'true' })
    const after = applyDependencies({ ...before, commit: false }, 'commit')
    expect(after.pr).toBe(false)
  })
})

describe('disabledKeys', () => {
  // It used to grey the base branch out until auto-push was on, which was right
  // while the field was called the target branch. The field now says what it
  // does — every worktree is cut from it — and that happens in projects which
  // never push at all, so the gate would have hidden the setting from exactly
  // the people who needed it.
  it('leaves the base branch editable whether or not auto-push is on', () => {
    expect(disabledKeys(readValues({ push: 'false' })).has('branch')).toBe(false)
    expect(disabledKeys(readValues({ push: 'true' })).has('branch')).toBe(false)
  })

  it('value-gates nothing today', () => {
    expect(disabledKeys(readValues({})).size).toBe(0)
  })
})

describe('toConfigUpdates', () => {
  it('emits only changed keys, correctly coerced (bool/number)', () => {
    const before = readValues({ autopilot: 'false', max_verify_retries: '2' })
    const after = { ...before, autopilot: true, max_verify_retries: 4 }
    expect(toConfigUpdates(before, after)).toEqual({
      autopilot: 'true',
      max_verify_retries: '4',
    })
  })

  it('never writes a retired engine key, whatever is already in the file (#1807)', () => {
    // The panel wrote `engines.lavish` when its switch was flipped, and nothing
    // has read that key since lavish was retired. A value already on disk must
    // not come back out of the panel either.
    const before = readValues({ 'engines.lavish': 'declined' })
    const after = { ...before, autopilot: true }
    expect(Object.keys(toConfigUpdates(before, after))).toEqual(['autopilot'])
  })

  it('returns nothing when values are unchanged', () => {
    const v = readValues({ autopilot: 'true' })
    expect(toConfigUpdates(v, { ...v })).toEqual({})
  })
})

describe('the Runtime provider select (multi_runtime_support)', () => {
  const providerField = FLOW_SETTINGS_SECTIONS.flatMap((section) => section.fields).find(
    (field) => field.key === 'provider',
  ) as FieldDef

  it('maps inherit → null so choosing it UNSETS the key, never the literal string', () => {
    // `inherit` is not a value to store — it means "no project override, use the
    // app default" — so it clears the key rather than writing 'inherit'.
    expect(providerWriteValue('inherit')).toBeNull()
  })

  it('writes a concrete provider as itself', () => {
    expect(providerWriteValue('claude')).toBe('claude')
    expect(providerWriteValue('codex')).toBe('codex')
    expect(providerWriteValue('copilot')).toBe('copilot')
  })

  it('offers inherit FIRST, so an absent key reads back as inherit', () => {
    // splitSelectValue falls back to options[0] for anything it does not
    // recognise (a blank/absent provider included), and options[0] is inherit.
    expect(providerField.options?.[0]?.value).toBe('inherit')
  })

  it('reads an absent provider back to the inherit option (blank → options[0])', () => {
    // readValues gives a missing text field the empty string, and the select
    // resolves that blank to its first option — inherit — rather than blank.
    expect(readValues({}).provider).toBe('')
    expect(splitSelectValue(providerField, '')).toEqual({ option: 'inherit', companion: '' })
  })

  it('reads a stored provider back to that exact option', () => {
    expect(readValues({ provider: 'copilot' }).provider).toBe('copilot')
    expect(splitSelectValue(providerField, 'copilot')).toEqual({
      option: 'copilot',
      companion: '',
    })
  })
})

describe('formatProvisionedAt (ide-auto-provisioning)', () => {
  it('renders a deterministic, locale-free "YYYY-MM-DD HH:MM"', () => {
    expect(formatProvisionedAt('2026-07-15T18:01:53.000Z')).toBe('2026-07-15 18:01')
  })

  it('returns the raw string for an unparseable timestamp (never throws)', () => {
    expect(formatProvisionedAt('not-a-date')).toBe('not-a-date')
  })
})

describe('provisioningStatusText (ide-auto-provisioning)', () => {
  it('reports "Not provisioned" when the root is unknown', () => {
    expect(provisioningStatusText(undefined)).toBe('Not provisioned')
  })

  it('reports "Not provisioned" when never stamped', () => {
    expect(provisioningStatusText({})).toBe('Not provisioned')
  })

  it('reports unavailable roots distinctly, even if previously stamped', () => {
    expect(
      provisioningStatusText({
        available: false,
        provisionedAt: '2026-07-15T18:01:53.000Z',
        provisionedVersion: '1.2.3',
      }),
    ).toBe('Unavailable — project folder not found')
  })

  it('reports version + formatted date when stamped and reachable', () => {
    expect(
      provisioningStatusText({
        provisionedAt: '2026-07-15T18:01:53.000Z',
        provisionedVersion: '1.2.3',
      }),
    ).toBe('v1.2.3 · provisioned 2026-07-15 18:01')
  })

  it('shows only the version when the stamp carries the assets hash', () => {
    expect(
      provisioningStatusText({
        provisionedAt: '2026-07-15T18:01:53.000Z',
        provisionedVersion: '1.2.3+66f2e13a48851e3e',
      }),
    ).toBe('v1.2.3 · provisioned 2026-07-15 18:01')
  })
})

describe('canReprovision (ide-auto-provisioning)', () => {
  it('is false for an unknown root', () => {
    expect(canReprovision(undefined)).toBe(false)
  })

  it('is false for an unavailable root', () => {
    expect(canReprovision({ available: false })).toBe(false)
  })

  it('is true for a reachable root, provisioned or not', () => {
    expect(canReprovision({})).toBe(true)
    expect(canReprovision({ provisionedAt: '2026-07-15T00:00:00.000Z', provisionedVersion: '1.0.0' })).toBe(true)
  })
})

describe('Conversation files section (thread-worktrees Phase 5, worktree_settings_ui)', () => {
  const field = FLOW_SETTINGS_SECTIONS.flatMap((section) => section.fields).find(
    (candidate) => candidate.key === 'thread_worktrees',
  )

  it('exposes the per-project switch, defaulting ON', () => {
    expect(
      FLOW_SETTINGS_SECTIONS.some((section) => section.title === WORKTREE_SECTION_TITLE),
    ).toBe(true)
    expect(field?.type).toBe('toggle')
    expect(field?.defaultOn).toBe(true)
  })

  it('reads ON when the project has never heard of the key', () => {
    expect(readValues({}).thread_worktrees).toBe(true)
  })

  it('reads OFF only for the literal false — matching main’s reader', () => {
    expect(readValues({ thread_worktrees: 'false' }).thread_worktrees).toBe(false)
    expect(readValues({ thread_worktrees: 'true' }).thread_worktrees).toBe(true)
  })

  it('writes the config string when the switch flips', () => {
    const before = readValues({})
    expect(toConfigUpdates(before, { ...before, thread_worktrees: false })).toEqual({
      thread_worktrees: 'false',
    })
  })

  it('never puts the key, a path or a command in what a person reads (#12)', () => {
    for (const text of [field?.label ?? '', field?.help ?? '']) {
      expect(text).not.toContain('thread_worktrees')
      expect(text).not.toContain('planflow-ai')
      expect(text).not.toContain('`')
      expect(text).not.toMatch(/(^|\s)[~/]\S/)
    }
  })
})

describe('Learning section (#513 phase 8)', () => {
  const learnAuto = FLOW_SETTINGS_SECTIONS.flatMap((section) => section.fields).find(
    (field) => field.key === 'learn_auto',
  )

  it('exposes a learn_auto toggle in a Learning section, defaulting ON', () => {
    expect(FLOW_SETTINGS_SECTIONS.some((section) => section.title === 'Learning')).toBe(true)
    expect(learnAuto).toBeDefined()
    expect(learnAuto?.type).toBe('toggle')
    expect(learnAuto?.defaultOn).toBe(true)
  })

  it('reads learn_auto ON when the key is absent (default on)', () => {
    expect(readValues({}).learn_auto).toBe(true)
  })

  it('reads learn_auto OFF only for the literal false', () => {
    expect(readValues({ learn_auto: 'false' }).learn_auto).toBe(false)
    expect(readValues({ learn_auto: 'true' }).learn_auto).toBe(true)
  })

  it('writes the config string when the toggle flips', () => {
    const before = readValues({})
    const after = { ...before, learn_auto: false }
    expect(toConfigUpdates(before, after)).toEqual({ learn_auto: 'false' })
  })

  it('renders the read-only session-budget line from the constant', () => {
    expect(learnBudgetText()).toBe(`Auto re-learns per session: ${LEARN_SESSION_BUDGET}`)
    expect(learnBudgetText(3)).toBe('Auto re-learns per session: 3')
  })
})

describe('Learning ignore list field (#learn-ignore UI)', () => {
  const learnIgnore = FLOW_SETTINGS_SECTIONS.find((section) => section.title === 'Learning')
    ?.fields.find((field) => field.key === 'learn_ignore')

  it('exposes learn_ignore as a text field in the Learning section', () => {
    expect(learnIgnore).toBeDefined()
    expect(learnIgnore?.type).toBe('text')
    expect(learnIgnore?.label).toBe('Ignore modules')
  })

  it('round-trips a comma-separated string unchanged', () => {
    const csv = 'vendor, generated/*, third-party'
    expect(readValues({ learn_ignore: csv }).learn_ignore).toBe(csv)
    const before = readValues({})
    expect(before.learn_ignore).toBe('')
    const after = { ...before, learn_ignore: csv }
    expect(toConfigUpdates(before, after)).toEqual({ learn_ignore: csv })
  })

  it('emits nothing when the CSV is unchanged', () => {
    const v = readValues({ learn_ignore: 'vendor' })
    expect(toConfigUpdates(v, { ...v })).toEqual({})
  })
})

describe('the Loops section is gone — loops are configured in the modal', () => {
  // The section lived here because "a setting a user has to change belongs on
  // the settings surface". That was half the answer: it belongs where the user
  // can SEE the thing it configures, and this overlay is two clicks and a
  // different surface away from the board the loops are visibly working on.
  // Loops now have a modal of their own, opened from the board strip.

  it('declares no Loops section at all', () => {
    expect(FLOW_SETTINGS_SECTIONS.some((section) => section.title === 'Loops')).toBe(false)
  })

  it('leaves no section carrying a loops block', () => {
    // The typed marker went with it — a leftover `extra` would render a block
    // whose renderer no longer exists, silently, on whichever section kept it.
    //
    // The claim is about the LOOPS marker, and it is asserted as that rather
    // than as an exact list of every extra: enumerating them made this test
    // fail the next time a legitimate block was added, which says nothing at
    // all about loops.
    const extras = FLOW_SETTINGS_SECTIONS.map((section) => section.extra).filter(
      (extra): extra is NonNullable<typeof extra> => extra !== undefined,
    )
    expect(extras).not.toContain('loops')
    expect(extras).toContain('learn-budget')
  })

  it('renders every block from a typed marker a renderer actually answers to', () => {
    // The rule the loops removal was really protecting: an `extra` nothing
    // renders is a silent no-op on whichever section carries it.
    const known = new Set(['learn-budget', 'thread-worktrees'])
    for (const section of FLOW_SETTINGS_SECTIONS) {
      if (section.extra === undefined) continue
      expect(known).toContain(section.extra)
    }
  })

  it('puts the way in to what a conversation keeps on the section that decides it', () => {
    // It is the only door left: the status segment, the sidebar list and the
    // landing bar's total all belonged to surfaces that managed a checkout as
    // an object, and all three are gone. This one is reachable from anywhere —
    // including a chat-only conversation in a project holding fifteen.
    expect(
      FLOW_SETTINGS_SECTIONS.find((section) => section.title === WORKTREE_SECTION_TITLE)?.extra,
    ).toBe('thread-worktrees')
  })

  it('keeps the Learning block on the same typed marker, not a heading string', () => {
    // Moved out of the removed describe rather than deleted with it: this claim
    // is about Learning, and it was only ever housed next door.
    expect(FLOW_SETTINGS_SECTIONS.find((section) => section.title === 'Learning')?.extra).toBe(
      'learn-budget',
    )
  })

  it('never held a config key, so removing it changes no read or write', () => {
    // The removal is inert to the key machinery, which is the same claim the
    // section's own test made from the other side: no `loop*` key appears in a
    // read, and an untouched panel still produces an empty diff.
    const before = readValues({})
    expect(Object.keys(before).some((key) => key.startsWith('loop'))).toBe(false)
    expect(toConfigUpdates(before, readValues({}))).toEqual({})
  })

  it('keeps every other section and its fields intact', () => {
    // The one risk of deleting a section from a shared array is deleting one
    // more than intended — asserted by name, in order.
    expect(FLOW_SETTINGS_SECTIONS.map((section) => section.title)).toEqual([
      'Runtime',
      'Autopilot',
      'Git & PR',
      'Execution',
      WORKTREE_SECTION_TITLE,
      'Learning',
    ])
    // A section without fields must render a block instead, or it is a heading
    // over nothing.
    for (const section of FLOW_SETTINGS_SECTIONS) {
      if (section.fields.length === 0) expect(section.extra).toBeDefined()
      else expect(section.fields.length).toBeGreaterThan(0)
    }
  })

  it('has no per-project Knowledge sync section — knowledge syncs with its Workspace', () => {
    expect(FLOW_SETTINGS_SECTIONS.map((section) => section.title)).not.toContain('Knowledge sync')
    expect(FLOW_SETTINGS_SECTIONS.some((section) => section.id === 'knowledge-sync')).toBe(false)
  })

  it('offers no engine key at all — none of them is read (#1807)', () => {
    // THE SHAPE THIS EXISTS TO STOP. The Engines section held exactly one
    // switch and it was a retired engine's key: flipping it wrote
    // `engines.lavish` to flowconfig and changed nothing anywhere. A control
    // whose whole effect is to look like one is the same promise a terminal
    // command in UI text makes (forbidden-pattern #12), with a click on the end
    // of it — and the comment sitting directly beneath it explained that
    // graphify's legacy key was ignored, so dead engine keys were actively on
    // the author's mind while the dead one stayed as the section's only field.
    //
    // Written as "no engine key" rather than "not lavish": the next engine to
    // be retired should fail this without anyone remembering to update it.
    const engineFields = FLOW_SETTINGS_SECTIONS.flatMap((section) =>
      section.fields.filter((field) => field.key.startsWith('engines.')),
    )
    expect(engineFields).toEqual([])
  })
})

// ── worktree_settings_ui: the Conversation files fields, inheritance and validation ──

/** A resolved answer with every setting from the built-in layer. */
function resolved(overrides: Partial<ResolvedWorktreeSettings> = {}): ResolvedWorktreeSettings {
  return {
    threadWorktrees: { value: true, source: 'default' },
    remote: { value: 'origin', source: 'default' },
    remoteBranchPattern: { value: null, source: 'default' },
    baseBranch: { value: null, source: 'default' },
    worktreeStart: { value: { kind: 'here' }, source: 'default' },
    baseRefresh: { value: true, source: 'default' },
    baseRefreshTimeoutMs: { value: 8_000, source: 'default' },
    worktreeCap: { value: 10, source: 'default' },
    worktreeSetup: { value: null, source: 'default' },
    worktreeSetupTimeoutMs: { value: 300_000, source: 'default' },
    ...overrides,
  }
}

describe('the Conversation files fields', () => {
  const section = FLOW_SETTINGS_SECTIONS.find((s) => s.title === WORKTREE_SECTION_TITLE)

  it('carries the three settings that survived, each linked to the setting it is', () => {
    expect(section?.fields.map((field) => field.setting)).toEqual([
      'threadWorktrees',
      'worktreeCap',
      'worktreeSetup',
    ])
    expect(worktreeFields()).toHaveLength(3)
  })

  it('offers no control for the seven the CLI still reads', () => {
    // C2, from the other side. The keys are NOT gone — `remote`, the naming
    // pattern, the base branch, where a new checkout starts, the base refresh
    // and its wait, and the setup wait are all still read out of the project's
    // config file and still behave exactly as they did. What went is this
    // panel's offer to set them, because the surfaces they configured went.
    for (const setting of [
      'remote',
      'remoteBranchPattern',
      'baseBranch',
      'worktreeStart',
      'baseRefresh',
      'baseRefreshTimeoutMs',
      'worktreeSetupTimeoutMs',
    ] as const) {
      expect(fieldForSetting(setting)).toBeUndefined()
    }
  })

  it('says branch where it used to say copy', () => {
    // The vocabulary this whole change exists to remove, asserted on the three
    // strings a person still reads in this section.
    for (const field of worktreeFields()) {
      for (const text of [field.label, field.help ?? '']) {
        expect(text.toLowerCase()).not.toContain('workspace')
        expect(text.toLowerCase()).not.toContain('worktree')
        expect(text.toLowerCase()).not.toContain('copy of the')
      }
    }
    expect(WORKTREE_SECTION_TITLE.toLowerCase()).not.toContain('workspace')
  })

  it('never puts a key, a path or a command in what a person reads (#12)', () => {
    for (const field of worktreeFields()) {
      for (const text of [field.label, field.help ?? '']) {
        // The rule is about the app's INTERNALS, not the English word a key was
        // named after: "the remote a thread publishes to" is the setting's own
        // vocabulary, while `remote_branch_pattern` is a file format. Only the
        // second shape is a leak, so that is what is asserted.
        expect(text).not.toMatch(/[a-z]+_[a-z]+/)
        expect(text).not.toContain('planflow-ai')
        expect(text).not.toContain('.flowconfig')
        expect(text).not.toContain('`')
        expect(text).not.toMatch(/(^|\s)[~/]\S/)
      }
    }
  })
})

describe('a choice and the name it carries are one stored value', () => {
  // NO SHIPPED FIELD IS A SELECT ANY MORE — the one that was (where a new
  // checkout starts from) went with the surfaces that read it. The two helpers
  // are still the panel's grammar for a choice that carries a name, and a
  // grammar with no test is a grammar nothing defends, so they are exercised
  // against a declaration of exactly that shape.
  const field: FieldDef = {
    key: 'a_choice',
    label: 'A choice',
    type: 'select',
    options: [
      { value: 'here', label: 'Here' },
      { value: 'trunk', label: 'The default' },
      { value: 'branch', label: 'A branch I name', companion: { placeholder: 'branch name' } },
    ],
  }

  it('splits a plain choice', () => {
    expect(splitSelectValue(field, 'trunk')).toEqual({ option: 'trunk', companion: '' })
  })

  it('splits a named branch into the choice and the name', () => {
    expect(splitSelectValue(field, 'branch:release/2.0')).toEqual({
      option: 'branch',
      companion: 'release/2.0',
    })
  })

  it('falls back to the first choice for anything it does not recognise', () => {
    expect(splitSelectValue(field, 'whatever')).toEqual({ option: 'here', companion: '' })
  })

  it('joins them back the way the file stores them', () => {
    expect(joinSelectValue(field, 'here', '')).toBe('here')
    expect(joinSelectValue(field, 'branch', ' main ')).toBe('branch:main')
  })
})

describe('worktreeFieldStates — the effective value, and where it came from', () => {
  it('translates the one setting that still has a control', () => {
    const states = worktreeFieldStates(
      resolved({ threadWorktrees: { value: false, source: 'project' } }),
    )
    expect(states.thread_worktrees).toEqual({ value: false, source: 'project' })
  })

  it('decorates nothing that has no control left to decorate', () => {
    // The resolver still answers for all ten; provenance is something a ROW
    // shows, so a setting with no row has nothing for it to be attached to.
    expect(Object.keys(worktreeFieldStates(resolved()))).toEqual(['thread_worktrees'])
  })

  it('keeps provenance even when two layers would produce the same value', () => {
    // The whole point: a project that CHOSE the built-in answer and one that
    // was never asked both read `true`, and they must not render the same way.
    const chosen = worktreeFieldStates(
      resolved({ threadWorktrees: { value: true, source: 'project' } }),
    )
    const inherited = worktreeFieldStates(resolved())
    expect(chosen.thread_worktrees.value).toBe(inherited.thread_worktrees.value)
    expect(chosen.thread_worktrees.source).not.toBe(inherited.thread_worktrees.source)
  })
})

describe('what the panel says about where a value came from', () => {
  it('names the two inherited layers and badges the project one not at all', () => {
    expect(provenanceChipText('global')).toBe('Inherited from your defaults')
    expect(provenanceChipText('default')).toBe("Flow's default")
    expect(provenanceChipText('project')).toBeNull()
  })

  it('offers to take a value over, or to hand it back', () => {
    expect(inheritActionLabel('project')).toBe('Inherit')
    expect(inheritActionLabel('global')).toBe('Use a project value')
    expect(inheritActionLabel('default')).toBe('Use a project value')
  })

  it('says what turning the switch off does NOT do', () => {
    expect(worktreesOffNote(true)).toBeNull()
    expect(worktreesOffNote(false)).toBe(WORKTREES_OFF_NOTE)
    expect(WORKTREES_OFF_NOTE).toContain('until you free its files')
    expect(WORKTREES_OFF_NOTE.toLowerCase()).not.toContain('workspace')
  })
})

describe('validateWorktreeField (allowed #22 — validated where typed)', () => {
  it('accepts a blank value for every field', () => {
    for (const field of worktreeFields()) {
      expect(validateWorktreeField(field.key, '   ')).toEqual({ ok: true })
    }
  })

  it('says nothing about a key with no control on this panel', () => {
    // The grammar for a remote, a naming pattern, a base branch and a start
    // went with their fields. The keys are still read by the CLI, which is the
    // thing that validates them now; a validator here with no field to refuse
    // for would be a second rule nobody can see fire.
    for (const key of ['remote', 'remote_branch_pattern', 'branch', 'worktree_start']) {
      expect(validateWorktreeField(key, 'anything at all')).toEqual({ ok: true })
    }
  })

  it('never names a key, a file or a command in a refusal (#12)', () => {
    const messages = [
      validateWorktreeField('worktree_cap', '0'),
      validateWorktreeField('worktree_cap', '2.5'),
    ]
    for (const message of messages) {
      const text = 'refusal' in message ? message.refusal : 'warning' in message ? message.warning : ''
      expect(text).not.toContain('planflow-ai')
      expect(text).not.toContain('.flowconfig')
      expect(text).not.toContain('_')
      expect(text).not.toContain('`')
    }
  })
})

describe('fieldConfigString — the string a take-over write carries', () => {
  it('writes the value already on screen, which the value diff cannot express', () => {
    // Taking over an inherited value changes WHO OWNS IT, not the value, so
    // before and after are equal and toConfigUpdates correctly emits nothing.
    const setup = fieldForSetting('worktreeSetup') as FieldDef
    expect(fieldConfigString(setup, 'npm ci')).toBe('npm ci')
    const worktrees = fieldForSetting('threadWorktrees') as FieldDef
    expect(fieldConfigString(worktrees, true)).toBe('true')
    expect(fieldConfigString(worktrees, false)).toBe('false')
    const cap = fieldForSetting('worktreeCap') as FieldDef
    expect(fieldConfigString(cap, 10)).toBe('10')
  })
})

describe('taking over a value that is not there (Phase 6 finding)', () => {
  // The bug this encodes: pressing "Use a project value" on the base branch or
  // the naming pattern wrote the blank on screen. The merge put an empty key in
  // the file, the resolver reads a blank as absent at every layer, and the row
  // came straight back as inherited — a press that did nothing at all.

  it('knows a blank value from one that is merely falsey', () => {
    expect(isBlankFieldValue('')).toBe(true)
    expect(isBlankFieldValue('   ')).toBe(true)
    expect(isBlankFieldValue('main')).toBe(false)
    // A switch that is off and a wait of zero are VALUES, not absences.
    expect(isBlankFieldValue(false)).toBe(false)
    expect(isBlankFieldValue(0)).toBe(false)
  })

  it('owns a blank take-over locally instead of writing nothing', () => {
    expect(takeOverAction('')).toBe('own')
    expect(takeOverAction('   ')).toBe('own')
  })

  it('still writes the value on screen when there is one — today\u2019s behaviour', () => {
    expect(takeOverAction('develop')).toBe('write')
    expect(takeOverAction(false)).toBe('write')
    expect(takeOverAction(8)).toBe('write')
  })

  it('writes the first real value typed into a row it owns', () => {
    expect(ownedEditAction('release/2.0')).toBe('write')
    expect(ownedEditAction(12)).toBe('write')
  })

  it('hands a row back when it is left blank, writing nothing', () => {
    expect(ownedEditAction('')).toBe('release')
    expect(ownedEditAction('  ')).toBe('release')
  })

  it('shows an owned-editing row as the layer its own panel writes', () => {
    expect(ownedEditingSource()).toBe('project')
    expect(ownedEditingSource('project')).toBe('project')
    expect(ownedEditingSource('global')).toBe('global')
  })

  it('renders that source as editable, unbadged, and offering to hand back', () => {
    // The three things the row derives from a source, on the panel it belongs
    // to — the whole visible meaning of "owned editing".
    const project = ownedEditingSource('project')
    expect(isInheritedValue(project, 'project')).toBe(false)
    expect(provenanceChipText(project, 'project')).toBeNull()
    expect(inheritActionLabel(project, 'project')).toBe('Inherit')

    const global = ownedEditingSource('global')
    expect(isInheritedValue(global, 'global')).toBe(false)
    expect(provenanceChipText(global, 'global')).toBeNull()
    expect(inheritActionLabel(global, 'global')).toBe("Use Flow's default")
  })

  it('is not a state the one remaining resolved row can start from', () => {
    // The fields that could inherit as BLANK were the base branch and the
    // naming pattern, and both went. The switch always resolves to a real
    // answer, so taking it over always has a value to write.
    const states = worktreeFieldStates(resolved())
    expect(takeOverAction(states.thread_worktrees.value)).toBe('write')
  })
})

describe('worktreeDefaultsStates — the person’s own layer, read by presence', () => {
  it('reports every field as Flow’s built-in when nothing has been set', () => {
    const states = worktreeDefaultsStates({})
    for (const field of worktreeFields()) {
      expect(states[field.key].source).toBe('default')
    }
    // …and shows the values the built-ins actually are, in the control's units.
    expect(states.thread_worktrees.value).toBe(true)
    expect(states.worktree_cap.value).toBe(10)
    expect(states.worktree_setup.value).toBe('')
  })

  it('mirrors exactly the fields that still have a control', () => {
    // The defaults panel is DERIVED from the field table rather than a second
    // list, so the seven removed fields left it without anyone editing it —
    // which is the whole reason it is derived.
    expect(Object.keys(worktreeDefaultsStates({})).sort()).toEqual([
      'thread_worktrees',
      'worktree_cap',
      'worktree_setup',
    ])
  })

  it('reports a default this person set as theirs', () => {
    const states = worktreeDefaultsStates({ worktreeSetup: 'npm ci' })
    expect(states.worktree_setup).toEqual({ value: 'npm ci', source: 'global' })
    expect(states.worktree_cap.source).toBe('default') // one key set is not all of them
  })

  it('reads PRESENCE, never value equality', () => {
    // A person who deliberately set the limit to Flow's own built-in and one
    // who has never opened this panel must not read as the same state.
    const chosen = worktreeDefaultsStates({ worktreeCap: '10' })
    expect(chosen.worktree_cap.source).toBe('global')
    expect(worktreeDefaultsStates({}).worktree_cap.source).toBe('default')
  })

  it('reads a blank default as absent, exactly as the resolver does', () => {
    // A default cleared back to nothing has no effect on any project — the
    // built-in answers — so calling it owned would be provenance saying the
    // opposite of what happens.
    const states = worktreeDefaultsStates({ worktreeSetup: '   ', worktreeCap: '' })
    expect(states.worktree_setup.source).toBe('default')
    expect(states.worktree_cap.source).toBe('default')
  })

  it('coerces every kind of value through the same path the project panel uses', () => {
    const states = worktreeDefaultsStates({
      threadWorktrees: 'false',
      worktreeCap: '25',
      worktreeSetup: 'make bootstrap',
    })
    expect(states.thread_worktrees).toEqual({ value: false, source: 'global' })
    expect(states.worktree_cap).toEqual({ value: 25, source: 'global' })
    expect(states.worktree_setup).toEqual({ value: 'make bootstrap', source: 'global' })
  })

  it('trims what it shows', () => {
    expect(worktreeDefaultsStates({ worktreeSetup: '  npm ci  ' }).worktree_setup.value).toBe(
      'npm ci',
    )
  })
})

describe('what the two panels say about each other', () => {
  it('names the defaults section and what it is for, without naming a file', () => {
    for (const text of [
      WORKTREE_DEFAULTS_TITLE,
      WORKTREE_DEFAULTS_NOTE,
      WORKTREE_DEFAULTS_OVERRIDE_NOTE,
    ]) {
      expect(text.length).toBeGreaterThan(0)
      expect(text).not.toMatch(/planflow-ai|\.flowconfig|`|--|_/)
    }
    expect(WORKTREE_DEFAULTS_NOTE).toContain('its own value')
  })

  it('is layer-aware everywhere a row reads its state', () => {
    expect(isInheritedValue('global', 'project')).toBe(true)
    expect(isInheritedValue('global', 'global')).toBe(false)
    expect(isInheritedValue('default', 'global')).toBe(true)
    expect(isInheritedValue('project', 'project')).toBe(false)

    expect(provenanceChipText('global', 'global')).toBeNull()
    expect(provenanceChipText('default', 'global')).toBe("Flow's default")

    expect(inheritActionLabel('default', 'global')).toBe('Set my own default')
    expect(inheritActionLabel('global', 'global')).toBe("Use Flow's default")
  })

  it('offers the chip’s door only for a project row reading a default', () => {
    expect(chipActionLabel('global', 'project')).toBe('Open defaults')
    expect(chipActionLabel('default', 'project')).toBeNull()
    expect(chipActionLabel('project', 'project')).toBeNull()
    expect(chipActionLabel('global', 'global')).toBeNull()
    expect(chipActionLabel('default', 'global')).toBeNull()
  })
})

describe('every worktree field has a validator that answers it', () => {
  it('answers all three, and refuses nothing a person may legitimately type', () => {
    const good: Record<string, string> = {
      thread_worktrees: 'true',
      worktree_cap: '10',
      worktree_setup: 'npm ci',
    }
    const fields = worktreeFields()
    expect(fields).toHaveLength(3)
    for (const field of fields) {
      expect(validateWorktreeField(field.key, good[field.key])).toEqual({ ok: true })
    }
  })

  it('refuses a limit of zero rather than clamping what somebody typed', () => {
    // A ceiling of 0 does not keep none — it puts every landed conversation
    // above the line on every sweep. The panel says so instead of meaning 1.
    expect(validateWorktreeField('worktree_cap', '0')).toMatchObject({
      refusal: expect.stringContaining('between 1 and 100'),
    })
    expect(validateWorktreeField('worktree_cap', '101')).toMatchObject({
      refusal: expect.any(String),
    })
    expect(validateWorktreeField('worktree_cap', '2.5')).toMatchObject({
      refusal: expect.any(String),
    })
    expect(validateWorktreeField('worktree_cap', '25')).toEqual({ ok: true })
    // The refusal is a REFUSAL, not a warning: a typed limit is told, never
    // quietly corrected (allowed-pattern #22).
    expect(isRefusal(validateWorktreeField('worktree_cap', '0'))).toBe(true)
  })

  it('judges nothing about a setup command, including a blank one', () => {
    // NO VALIDATOR, ON PURPOSE — a deviation from the plan's Task 1.3, which
    // proposed refusing a whitespace-only value. Blank is how every field in
    // this panel is CLEARED, and the resolver already reads a blank key as
    // absent; refusing it would make the command the one setting a person
    // cannot unset. Flow runs this string, it does not read it (NFR-2).
    for (const raw of ['npm ci', './scripts/ws.sh', 'make bootstrap && uv sync', '   ', '']) {
      expect(validateWorktreeField('worktree_setup', raw)).toEqual({ ok: true })
    }
  })

  it('has nothing to refuse about a switch — its control has only two answers', () => {
    for (const key of ['thread_worktrees']) {
      expect(validateWorktreeField(key, 'true')).toEqual({ ok: true })
      expect(validateWorktreeField(key, 'false')).toEqual({ ok: true })
    }
  })
})
