import type { WorktreeBranchChoices } from '../../shared/ipc-contract'
import { FALLBACK_BRANCH_NAME, suggestBranchName } from './branch-name'
import {
  BASE_LABEL,
  INITIAL_BRANCH_CHOICE,
  OWN_LABEL,
  PROJECT_LABEL,
  UNKNOWN_PROJECT_BRANCH_LABEL,
  baseBranchOf,
  branchSeed,
  defaultBranchChoice,
  projectFolderNote,
  startPickerOptions,
  carryQuestion,
  chosenBranchName,
  newThreadBaseRungs,
  newThreadChipFace,
  newThreadRungs,
  prepareRequestFor,
  readBranchField,
  sameStart,
  startBranch,
  type NewThreadBranchChoice,
} from './new-thread-branch'

const BANNED = /\b(copy|copies|copied|workspace|workspaces|worktree|worktrees)\b/i

describe('what the chip opens on', () => {
  // THE MEASURED BUG, PINNED. 22 of 23 checkouts on a real machine existed
  // because this default said 'own' and nobody pressed anything. The gate on
  // AUTOMATIC creation was never what made them.
  it('is the project, so isolation is asked for rather than inherited', () => {
    expect(INITIAL_BRANCH_CHOICE.placement).toBe('project')
  })

  it('starts at the project’s base branch, not at whatever is checked out', () => {
    // A thread's branch belongs to that thread: `here` handed a new
    // conversation the last one's branch (2026-09-17).
    expect(INITIAL_BRANCH_CHOICE.start).toEqual({ kind: 'trunk' })
  })

  it('follows what is being typed rather than pinning a name nobody chose', () => {
    expect(INITIAL_BRANCH_CHOICE.typedName).toBeNull()
  })
})

/**
 * A choice on its OWN branch.
 *
 * Placement is stated here rather than inherited from `INITIAL_BRANCH_CHOICE`.
 * It used to be inherited, and when the default flipped to the project every
 * test built by this helper quietly started asserting the opposite of its own
 * name — ten of them failed, which was lucky; a helper that silently tests the
 * other branch is the failure that does not announce itself.
 */
function own(patch: Partial<NewThreadBranchChoice> = {}): NewThreadBranchChoice {
  return { ...INITIAL_BRANCH_CHOICE, placement: 'own', ...patch }
}

const choices = (branches: WorktreeBranchChoices['branches'], current: string | null = 'main') => ({
  current,
  branches,
})

const branch = (
  name: string,
  patch: Partial<WorktreeBranchChoices['branches'][number]> = {},
): WorktreeBranchChoices['branches'][number] => ({
  name,
  current: false,
  trunk: false,
  canCheckOut: true,
  remoteOnly: false,
  ...patch,
})

describe('branchSeed', () => {
  it('prefers a title when there is one', () => {
    expect(branchSeed({ title: '  Fix the parser ', description: 'anything' })).toBe(
      'Fix the parser',
    )
  })

  it('falls back to the ask, which is all a from-scratch thread has', () => {
    expect(branchSeed({ title: '   ', description: '  Rewrite the importer  ' })).toBe(
      'Rewrite the importer',
    )
  })

  it('is empty when nothing has been typed at all', () => {
    expect(branchSeed({ title: '', description: '' })).toBe('')
  })
})

describe('chosenBranchName', () => {
  it('follows the ask while nobody has typed a name', () => {
    expect(chosenBranchName(own(), 'Fix the parser')).toBe(suggestBranchName('Fix the parser'))
  })

  it('keeps a typed name even when the ask is rewritten underneath it', () => {
    const choice = own({ typedName: 'feature/PF-42-parser' })
    expect(chosenBranchName(choice, 'something else entirely')).toBe('feature/PF-42-parser')
  })

  it('never hands back an empty name for a title that survives none of the slug', () => {
    expect(chosenBranchName(own(), '🙂🙂🙂')).toBe(FALLBACK_BRANCH_NAME)
  })
})

describe('readBranchField', () => {
  it('treats a blank field as "follow the ask again", not as a refusal', () => {
    expect(readBranchField('   ')).toEqual({ kind: 'following' })
  })

  it('keeps an acceptable name exactly as typed', () => {
    expect(readBranchField('  feature/PF-42-parser ')).toEqual({
      kind: 'named',
      name: 'feature/PF-42-parser',
    })
  })

  it('refuses rather than repairs, and says why', () => {
    const outcome = readBranchField('feature/..bad')
    expect(outcome.kind).toBe('refused')
    if (outcome.kind === 'refused') expect(outcome.detail.length).toBeGreaterThan(0)
  })
})

describe('newThreadChipFace', () => {
  it('lights up for a branch of its own and names it', () => {
    const face = newThreadChipFace(own({ typedName: 'thread/parser' }), '', 'main')
    expect(face).toMatchObject({ label: 'thread/parser', tone: 'own' })
    expect(face.title).toContain('thread/parser')
  })

  it('names the project branch when the work happens in the project', () => {
    const face = newThreadChipFace(own({ placement: 'project' }), '', 'develop')
    expect(face).toMatchObject({ label: 'develop', tone: 'project' })
  })

  it('never prints a blank when the project branch could not be read', () => {
    const face = newThreadChipFace(own({ placement: 'project' }), '', null)
    expect(face.label).toBe(UNKNOWN_PROJECT_BRANCH_LABEL)
  })

  it('shows the taken branch rather than a name that will never exist', () => {
    const face = newThreadChipFace(
      own({ typedName: 'thread/mine', start: { kind: 'checkout', branch: 'release/9' } }),
      '',
      'main',
    )
    expect(face.label).toBe('release/9')
    expect(face.title).toContain('did not create')
  })

  it('says where an own branch begins when that is not where the reader is', () => {
    const face = newThreadChipFace(
      own({ typedName: 'thread/mine', start: { kind: 'branch', branch: 'develop' } }),
      '',
      'main',
    )
    expect(face.title).toContain('develop')
  })
})

describe('newThreadRungs', () => {
  const base = { choice: own(), seed: 'Fix the parser', projectBranch: 'main' }

  it('offers the two that matter, with its own branch chosen', () => {
    const rungs = newThreadRungs({ ...base, branchesKnown: false })
    expect(rungs.map((rung) => rung.label)).toEqual([OWN_LABEL, PROJECT_LABEL])
    expect(rungs[0]?.selected).toBe(true)
    expect(rungs[1]?.selected).toBe(false)
  })

  it('offers the base rung only when there is a list behind it', () => {
    const rungs = newThreadRungs({ ...base, branchesKnown: true })
    expect(rungs.map((rung) => rung.label)).toEqual([OWN_LABEL, PROJECT_LABEL, BASE_LABEL])
  })

  it('puts the editable field on the rung that makes the branch, and nowhere else', () => {
    const rungs = newThreadRungs({ ...base, branchesKnown: true })
    expect(rungs.filter((rung) => rung.editable).map((rung) => rung.id)).toEqual(['own'])
  })

  it('takes the field away when the branch is taken rather than made', () => {
    const rungs = newThreadRungs({
      ...base,
      choice: own({ start: { kind: 'checkout', branch: 'release/9' } }),
      branchesKnown: true,
    })
    expect(rungs[0]?.editable).toBe(false)
    expect(rungs[0]?.branch).toBe('release/9')
  })

  it('names the branch each rung is about, and never inside its label', () => {
    const rungs = newThreadRungs({ ...base, branchesKnown: true })
    expect(rungs[0]?.branch).toBe(suggestBranchName('Fix the parser'))
    expect(rungs[1]?.branch).toBe('main')
    for (const rung of rungs) expect(rung.label).not.toContain('main')
  })

  it('marks the base rung once the beginning has been moved off the default', () => {
    const moved = newThreadRungs({
      ...base,
      choice: own({ start: { kind: 'branch', branch: 'develop' } }),
      branchesKnown: true,
    })
    expect(moved[2]).toMatchObject({ selected: true, branch: 'develop' })
  })

  it('says so rather than going quiet when the project branch could not be read', () => {
    const rungs = newThreadRungs({ ...base, projectBranch: null, branchesKnown: false })
    expect(rungs[1]?.branch).toBeNull()
    expect(rungs[1]?.detail).toContain('could not be read')
  })

  it('follows the placement into the project', () => {
    const rungs = newThreadRungs({ ...base, choice: own({ placement: 'project' }), branchesKnown: true })
    expect(rungs.map((rung) => rung.selected)).toEqual([false, true, false])
  })
})

describe('newThreadBaseRungs', () => {
  it('puts where you are first, and marks it by default', () => {
    const rungs = newThreadBaseRungs({
      choices: choices([branch('main', { current: true, trunk: true, canCheckOut: false })]),
      start: { kind: 'here' },
    })
    expect(rungs[0]).toMatchObject({ id: 'here', branch: 'main', selected: true })
  })

  it('says there is nowhere to go back to when the project is not on a branch', () => {
    const rungs = newThreadBaseRungs({ choices: choices([], null), start: { kind: 'here' } })
    expect(rungs[0]?.branch).toBeNull()
    expect(rungs[0]?.detail).toContain('not a branch')
  })

  it('offers the trunk separately only when it is not where you already are', () => {
    const withTrunk = newThreadBaseRungs({
      choices: choices([branch('main', { trunk: true })], 'feature/x'),
      start: { kind: 'here' },
    })
    expect(withTrunk.map((rung) => rung.id)).toContain('trunk')

    const onTrunk = newThreadBaseRungs({
      choices: choices([branch('main', { trunk: true, current: true })], 'main'),
      start: { kind: 'here' },
    })
    expect(onTrunk.map((rung) => rung.id)).not.toContain('trunk')
  })

  it('offers a free branch as one to take, and a held one as one to begin from', () => {
    const rungs = newThreadBaseRungs({
      choices: choices([branch('free'), branch('held', { canCheckOut: false })]),
      start: { kind: 'here' },
    })
    expect(rungs.find((rung) => rung.branch === 'free')?.start).toEqual({
      kind: 'checkout',
      branch: 'free',
    })
    expect(rungs.find((rung) => rung.branch === 'held')?.start).toEqual({
      kind: 'branch',
      branch: 'held',
    })
    expect(rungs.find((rung) => rung.branch === 'held')?.detail).toContain('can’t work on it too')
  })

  it('marks whichever row the current start asks for', () => {
    const rungs = newThreadBaseRungs({
      choices: choices([branch('free'), branch('other')]),
      start: { kind: 'checkout', branch: 'other' },
    })
    expect(rungs.filter((rung) => rung.selected).map((rung) => rung.branch)).toEqual(['other'])
  })

  it('never shows one branch twice', () => {
    const rungs = newThreadBaseRungs({
      choices: choices([
        branch('main', { current: true, trunk: true, canCheckOut: false }),
        branch('develop'),
      ]),
      start: { kind: 'here' },
    })
    const names = rungs.map((rung) => rung.branch)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('carryQuestion', () => {
  it('asks nothing when there is nothing to ask about', () => {
    expect(carryQuestion({ changedFiles: 0 })).toBeNull()
    expect(carryQuestion({ changedFiles: -3 })).toBeNull()
    expect(carryQuestion({ changedFiles: Number.NaN })).toBeNull()
  })

  it('offers exactly two answers: bring them, or do not', () => {
    // IT OFFERED THREE. The middle one stashed — a third outcome, a place to
    // remember it, and a thing to undo later, in a question that is binary
    // (user, 2026-09-17: "lets be more simple, maybe two options only, first
    // bring my changes or not, thats it").
    const question = carryQuestion({ changedFiles: 3, baseBranch: 'main' })
    expect(question?.rungs.map((rung) => rung.id)).toEqual(['commit', 'clean'])
  })

  it('counts the files in the reader’s own words, in the question itself', () => {
    // The paragraph under the title is gone — it explained what a worktree is
    // to somebody who asked to start working — so the count moved into the one
    // sentence that remains.
    expect(carryQuestion({ changedFiles: 1 })?.title).toContain('1 file')
    expect(carryQuestion({ changedFiles: 4 })?.title).toContain('4 files')
    expect(carryQuestion({ changedFiles: 4 })?.body).toBe('')
  })

  it('says where "no" starts from, and manages without a branch name', () => {
    const detail = (base: string | null) =>
      carryQuestion({ changedFiles: 2, baseBranch: base })?.rungs.find(
        (rung) => rung.id === 'clean',
      )?.detail ?? ''
    // A person choosing "no" is choosing a starting point, so the starting
    // point is what that answer names.
    expect(detail('develop')).toContain('the last commit on develop')
    expect(detail('  ')).toContain('the last commit')
    expect(detail('develop')).toContain('up to date')
  })

  it('says none of the three words this plan is removing from the product', () => {
    const question = carryQuestion({ changedFiles: 2, baseBranch: 'main' })
    const strings = [
      question?.title ?? '',
      question?.body ?? '',
      ...(question?.rungs.flatMap((rung) => [rung.label, rung.detail]) ?? []),
    ]
    expectNoContainerWords(strings)
  })
})

/**
 * Every string, minus the branch names inside them, is free of the three words.
 *
 * A BRANCH NAME IS NOT THIS MODULE'S PROSE. The rule is about words this module
 * WRITES — "workspace", "worktree", "copy" as vocabulary put in front of a
 * reader who never asked for it. A branch is a name the app derived from the
 * title and quotes back, and its namespace is deliberately `worktree/` (user,
 * 2026-09-17: "instead of thread/name can be worktree/name-branch because the
 * user will understand that better").
 *
 * So branches are removed BY VALUE before the scan, rather than by loosening
 * the pattern: every other word in every string is still held to the whole
 * rule, including a sentence that happens to contain a branch.
 */
function expectNoContainerWords(strings: readonly string[]): void {
  const branches = strings.filter((text) => /^[\w.-]+\/[\w./-]+$/.test(text))
  for (const text of strings) {
    const prose = branches.reduce((line, branch) => line.split(branch).join(''), text)
    expect(prose).not.toMatch(BANNED)
  }
}

describe('every string this module can show', () => {
  it('is free of the three words, on every rung of every stage', () => {
    const seed = 'Fix the parser'
    const starts = [
      { kind: 'here' } as const,
      { kind: 'trunk' } as const,
      { kind: 'branch', branch: 'develop' } as const,
      { kind: 'checkout', branch: 'release/9' } as const,
    ]
    const strings: string[] = []
    for (const start of starts) {
      for (const placement of ['own', 'project'] as const) {
        const choice = own({ placement, start })
        const face = newThreadChipFace(choice, seed, 'main')
        strings.push(face.label, face.title)
        for (const rung of newThreadRungs({
          choice,
          seed,
          projectBranch: 'main',
          branchesKnown: true,
        })) {
          strings.push(rung.label, rung.detail, rung.branch ?? '')
        }
      }
      for (const rung of newThreadBaseRungs({
        choices: choices([
          branch('main', { current: true, trunk: true, canCheckOut: false }),
          branch('develop'),
          branch('held', { canCheckOut: false }),
          branch('remote', { remoteOnly: true }),
        ]),
        start,
      })) {
        strings.push(rung.label ?? '', rung.detail, rung.branch ?? '')
      }
    }
    expectNoContainerWords(strings)
  })
})

describe('prepareRequestFor', () => {
  it('says "in the project" rather than saying nothing at all', () => {
    // It returned null — "do not call at all" — so the two facts a person had
    // just decided reached main as one, carried by whether the call happened
    // (2026-09-17: "we need to separate that concept everywhere"). No branch
    // and no start travel with it: that folder is on the branch it is on.
    expect(prepareRequestFor(own({ placement: 'project' }), 'Fix the parser')).toEqual({
      worktree: 'project',
    })
  })

  it('asks for a named branch beginning at the project’s base', () => {
    // `trunk`, not `here`. A new conversation used to inherit whatever branch
    // the project folder was left on — usually another conversation's (user,
    // 2026-09-17: "new thread should always start from main").
    // THE FOLDER TRAVELS TOO. A checkout lands in a directory whatever its
    // branch is called, and that directory needs a name a person can read
    // (2026-09-17) — derived from the same seed when nobody typed one.
    expect(prepareRequestFor(own({ typedName: 'worktree/parser' }), 'whatever')).toEqual({
      worktree: 'own',
      start: { kind: 'trunk' },
      branch: 'worktree/parser',
      // LINKED: the folder is the BRANCH, prefixed — one typed word, two names.
      worktreeName: 'worktree/parser',
    })
  })

  it('sends the suggestion when nobody typed one', () => {
    expect(prepareRequestFor(own(), 'Fix the parser')).toEqual({
      worktree: 'own',
      start: { kind: 'trunk' },
      branch: suggestBranchName('Fix the parser'),
      worktreeName: 'worktree/fix-the-parser',
    })
  })

  it('sends no name at all for a branch it is taking rather than making', () => {
    const request = prepareRequestFor(
      own({ typedName: 'thread/mine', start: { kind: 'checkout', branch: 'release/9' } }),
      'seed',
    )
    expect(request).toEqual({
      worktree: 'own',
      start: { kind: 'checkout', branch: 'release/9' },
      // The folder follows the NAME in the field, even for a branch being taken:
      // the checkout still lands somewhere, and that somewhere is named.
      worktreeName: 'worktree/thread-mine',
    })
    expect(request && 'branch' in request).toBe(false)
  })

  it('drops a name git would refuse rather than sending it', () => {
    const request = prepareRequestFor(own({ typedName: 'feature/..bad' }), 'seed')
    expect(request).toEqual({
      worktree: 'own',
      start: { kind: 'trunk' },
      // A branch git would refuse does not travel; the folder still does, because
      // a refused ref is not a refused directory.
      worktreeName: 'worktree/feature-bad',
    })
  })
})

describe('sameStart and startBranch', () => {
  it('tells two starts of the same kind apart by their branch', () => {
    expect(sameStart({ kind: 'branch', branch: 'a' }, { kind: 'branch', branch: 'b' })).toBe(false)
    expect(sameStart({ kind: 'branch', branch: 'a' }, { kind: 'branch', branch: 'a' })).toBe(true)
    expect(sameStart({ kind: 'branch', branch: 'a' }, { kind: 'checkout', branch: 'a' })).toBe(false)
    expect(sameStart({ kind: 'here' }, { kind: 'here' })).toBe(true)
  })

  it('names the branch only for the two kinds that have one', () => {
    expect(startBranch({ kind: 'here' })).toBeNull()
    expect(startBranch({ kind: 'trunk' })).toBeNull()
    expect(startBranch({ kind: 'checkout', branch: 'x' })).toBe('x')
  })
})

// ── 2026-10-08: "i'm not able to start a new thread from main branch" ─────

/** The user's repository: the project folder sits on a feature branch. */
const onFeature = (): WorktreeBranchChoices =>
  choices(
    [
      branch('ACME-3667-design-system-resolve-residue', { current: true, canCheckOut: false }),
      branch('main', { trunk: true }),
      branch('develop'),
      branch('held', { canCheckOut: false }),
    ],
    'ACME-3667-design-system-resolve-residue',
  )

const onMain = (): WorktreeBranchChoices =>
  choices([branch('main', { current: true, trunk: true, canCheckOut: false }), branch('develop')], 'main')

const TRUNK = { kind: 'trunk' } as const

describe('defaultBranchChoice', () => {
  it('starts from the base branch on a branch of its own when the folder is somewhere else', () => {
    // THE REPORTED BUG: the default was the folder, so the thread began on the
    // feature branch and nothing on the menu could say otherwise.
    const choice = defaultBranchChoice({ start: TRUNK, worktreesAllowed: true, choices: onFeature() })
    expect(choice.placement).toBe('own')
    expect(choice.start).toEqual(TRUNK)
    // …and what main is asked for is a cut from the base, never a change to
    // the project folder's branch.
    const request = prepareRequestFor(choice, 'Fix the parser')
    expect(request).toMatchObject({ worktree: 'own', start: TRUNK })
  })

  it('works in the project folder when the folder is already on the base — nothing is made', () => {
    const choice = defaultBranchChoice({ start: TRUNK, worktreesAllowed: true, choices: onMain() })
    expect(choice.placement).toBe('project')
    expect(prepareRequestFor(choice, 'Fix the parser')).toEqual({ worktree: 'project' })
  })

  it('makes no guess while the branch list is unread', () => {
    const choice = defaultBranchChoice({ start: TRUNK, worktreesAllowed: true, choices: null })
    expect(choice.placement).toBe('project')
  })

  it('never asks for a checkout a project has turned off', () => {
    const choice = defaultBranchChoice({ start: TRUNK, worktreesAllowed: false, choices: onFeature() })
    expect(choice.placement).toBe('project')
  })

  it('honours a configured "where you are" start by working in the folder', () => {
    const choice = defaultBranchChoice({
      start: { kind: 'here' },
      worktreesAllowed: true,
      choices: onFeature(),
    })
    expect(choice).toMatchObject({ placement: 'project', start: { kind: 'here' } })
  })

  it('honours a configured branch start, and only isolates when the folder is not on it', () => {
    const start = { kind: 'branch', branch: 'develop' } as const
    expect(defaultBranchChoice({ start, worktreesAllowed: true, choices: onFeature() })).toMatchObject({
      placement: 'own',
      start,
    })
    const onDevelop = choices([branch('develop', { current: true }), branch('main', { trunk: true })], 'develop')
    expect(defaultBranchChoice({ start, worktreesAllowed: true, choices: onDevelop }).placement).toBe(
      'project',
    )
  })

  it('starts nobody with a typed name', () => {
    const choice = defaultBranchChoice({ start: TRUNK, worktreesAllowed: true, choices: onFeature() })
    expect(choice.typedName).toBeNull()
    expect(choice.typedWorktree).toBeNull()
  })
})

describe('startPickerOptions', () => {
  it('offers the base first and the branch you are on second, base selected', () => {
    const options = startPickerOptions({ choices: onFeature(), start: TRUNK })
    expect(options.map((option) => option.id).slice(0, 2)).toEqual(['trunk', 'here'])
    expect(options[0]).toMatchObject({ text: 'main — main branch', selected: true })
    expect(options[1]).toMatchObject({
      text: 'ACME-3667-design-system-resolve-residue — where you are now',
      selected: false,
    })
  })

  it('lets the branch you are on be picked', () => {
    const options = startPickerOptions({ choices: onFeature(), start: { kind: 'here' } })
    expect(options.find((option) => option.selected)?.id).toBe('here')
  })

  it('takes a free branch and begins from a held one, and never lists a branch twice', () => {
    const options = startPickerOptions({ choices: onFeature(), start: TRUNK })
    expect(options.find((option) => option.text === 'develop')?.start).toEqual({
      kind: 'checkout',
      branch: 'develop',
    })
    expect(options.find((option) => option.text === 'held')?.start).toEqual({
      kind: 'branch',
      branch: 'held',
    })
    const texts = options.map((option) => option.text)
    expect(new Set(texts).size).toBe(texts.length)
  })

  it('does not offer "where you are" separately when that is the base', () => {
    const options = startPickerOptions({ choices: onMain(), start: TRUNK })
    expect(options.map((option) => option.id)).not.toContain('here')
  })

  it('still offers the base before the list is read', () => {
    const options = startPickerOptions({ choices: null, start: TRUNK })
    expect(options[0]).toMatchObject({ id: 'trunk', selected: true })
  })

  it('keeps a start nobody listed rather than selecting another one', () => {
    const start = { kind: 'branch', branch: 'release/9' } as const
    const options = startPickerOptions({ choices: onFeature(), start })
    expect(options.filter((option) => option.selected)).toHaveLength(1)
    expect(options.find((option) => option.selected)?.text).toBe('release/9')
  })
})

describe('projectFolderNote', () => {
  it('says when the folder is not on the base, and names the switch as the way there', () => {
    const note = projectFolderNote({
      projectBranch: 'ACME-3667-design-system-resolve-residue',
      choices: onFeature(),
      worktreesAllowed: true,
    })
    expect(note).toContain('‘main’')
    expect(note).toContain('switch')
  })

  it('says nothing when the folder is already on the base, or nothing is known', () => {
    expect(projectFolderNote({ projectBranch: 'main', choices: onMain(), worktreesAllowed: true })).toBeNull()
    expect(projectFolderNote({ projectBranch: 'x', choices: null, worktreesAllowed: true })).toBeNull()
  })

  it('never names a command, a path or a container word', () => {
    for (const worktreesAllowed of [true, false]) {
      const note = projectFolderNote({ projectBranch: 'feature', choices: onFeature(), worktreesAllowed }) ?? ''
      expect(note).not.toMatch(BANNED)
      expect(note).not.toMatch(/`|planflow-ai|git |\.flowconfig/)
    }
  })
})

describe('the chip face names the base it begins from', () => {
  it('says which branch the base is once it is known', () => {
    const face = newThreadChipFace(own({ typedName: 'thread/mine', start: TRUNK }), '', 'feature', 'main')
    expect(face.title).toContain('‘main’')
  })

  it('reads the base off the list, not off the folder', () => {
    expect(baseBranchOf(onFeature())).toBe('main')
    expect(baseBranchOf(null)).toBeNull()
  })

  it('keeps the picker free of the container words', () => {
    const strings = startPickerOptions({ choices: onFeature(), start: TRUNK }).map((option) => option.text)
    expectNoContainerWords(strings)
  })
})
