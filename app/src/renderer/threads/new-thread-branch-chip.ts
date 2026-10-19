/**
 * THE BRANCH CHIP ON THE NEW-THREAD PAGE — the same chip as the header's, at
 * the one moment the decision is still free.
 *
 * The Changes toolbar shows where a conversation's work lands and lets its name
 * be changed (`branch-rename-popover.ts`). This shows where a conversation's
 * work WILL land, and lets
 * the whole arrangement be chosen: on a branch of its own (named here, before
 * anything exists to name it after), in the project's own files, or on a branch
 * begun somewhere else entirely. Same glyph, same tones, same menu discipline —
 * a reader who learns the chip once has learnt both.
 *
 * IT REPLACES A PLAIN TEXT BOX. The page carried an unlabelled
 * "Branch name (optional)" field in the message box's footer: no validation, no
 * suggestion, no way to say "actually, don't", and no relationship to the two
 * other surfaces that asked the rest of this same question later. A field with
 * no opinion is not a lighter control than a menu — it is a menu with all its
 * options hidden and all its mistakes deferred.
 *
 * EVERY WORD AND EVERY RULE IS `new-thread-branch.ts`'s. This file owns
 * elements, a popover and the keyboard, and decides nothing: which rungs show,
 * what they say, what the suggestion is, whether a typed name is acceptable and
 * what blanking the field means are all decided (and tested) there.
 */

import type { WorktreeBranchChoices, WorktreeStart } from '../../shared/ipc-contract'
import { injectAnchoredMenuStyles, openAnchoredPopover } from './anchored-popover'
import { injectWorktreeStyles } from '../worktrees/worktree-styles'
import { SWITCH_NAME } from '../worktrees/worktree-switch'
import { WORKTREE_FOLDER_PREFIX, validateWorktreeName } from '../../shared/worktree-name'
import {
  INITIAL_BRANCH_CHOICE,
  baseBranchOf,
  chosenBranchName,
  defaultBranchChoice,
  folderStem,
  newThreadChipFace,
  projectFolderNote,
  readBranchField,
  startPickerOptions,
  type NewThreadBranchChoice,
} from './new-thread-branch'

export interface NewThreadBranchChipOptions {
  /**
   * The text a suggested name is derived from, read at draw time rather than
   * pushed in.
   *
   * A PULL, BECAUSE THE ASK IS STILL BEING TYPED. The page repaints on every
   * keystroke in the description; a chip holding its own duplicate of that text
   * would need the page to remember to update it, and the day somebody adds a
   * second way to fill the box the chip goes quietly stale.
   */
  seed(): string
  /** Told whenever the choice changed, so the page can carry it into the draft. */
  onChange?(choice: NewThreadBranchChoice): void
}

export interface NewThreadBranchChipController {
  /** The chip's host — mount it once; it fills itself. */
  readonly element: HTMLElement
  /** What has been chosen, right now. */
  choice(): NewThreadBranchChoice
  /** Redraw the face — the suggestion follows the ask while nobody has typed. */
  refresh(): void
  /** Back to the default, for a fresh page. */
  reset(): void
  /** The branch the project itself is on, or null when it could not be read. */
  setProjectBranch(branch: string | null): void
  /** The branches this one could begin from, or null while that is unread. */
  setBranches(choices: WorktreeBranchChoices | null): void
  /**
   * The project's resolved worktree settings that shape the default: where a
   * new conversation begins, and whether it may have a checkout of its own.
   */
  setWorktreeDefaults(defaults: { start: WorktreeStart; worktreesAllowed: boolean }): void
}

/** What the default is picked from until the project's settings are read. */
const UNREAD_DEFAULTS = { start: INITIAL_BRANCH_CHOICE.start, worktreesAllowed: true }

export function createNewThreadBranchChip(
  options: NewThreadBranchChipOptions,
): NewThreadBranchChipController {
  injectAnchoredMenuStyles()
  injectWorktreeStyles()
  injectChipStyles()

  const host = document.createElement('span')
  host.className = 'fl-newbranch-host'

  let choice: NewThreadBranchChoice = { ...INITIAL_BRANCH_CHOICE }
  let projectBranch: string | null = null
  let branches: WorktreeBranchChoices | null = null
  let defaults: { start: WorktreeStart; worktreesAllowed: boolean } = { ...UNREAD_DEFAULTS }
  /**
   * True once a person has changed anything on this chip.
   *
   * THE DEFAULT ARRIVES LATE — the branch list and the settings are each a
   * round trip — and it must never overwrite an answer somebody already gave
   * while they were in flight. An untouched chip follows the default; a
   * touched one keeps exactly what was picked.
   */
  let touched = false
  /** The open menu's closer, so a second press does not stack two of them. */
  let closeMenu: (() => void) | null = null

  const chip = document.createElement('button')
  chip.type = 'button'
  chip.className = 'fl-newbranch-chip'

  const glyph = document.createElement('fl-icon')
  glyph.setAttribute('name', 'git-branch')
  glyph.setAttribute('size', '11')
  glyph.className = 'fl-newbranch-glyph'

  // THE ONE STRING HERE ALLOWED TO SHORTEN. It is identity, the tone carries
  // the role, and no repository's naming convention gets to set the width of a
  // control in the message box's footer.
  const label = document.createElement('span')
  label.className = 'fl-newbranch-label'

  chip.append(glyph, label)
  host.appendChild(chip)

  const paint = (): void => {
    const face = newThreadChipFace(choice, options.seed(), projectBranch, baseBranchOf(branches))
    label.textContent = face.label
    chip.title = face.title
    chip.setAttribute('aria-label', face.title)
    chip.classList.toggle('is-own', face.tone === 'own')
    chip.classList.toggle('is-project', face.tone === 'project')
  }

  const changed = (): void => {
    paint()
    options.onChange?.(choice)
  }

  /** A person's own change: the default stops following from here on. */
  const picked = (): void => {
    touched = true
    changed()
  }

  /** Re-derive the default, for a chip nobody has touched yet. */
  const applyDefault = (): void => {
    if (touched) {
      paint()
      return
    }
    choice = defaultBranchChoice({ ...defaults, choices: branches })
    changed()
  }

  chip.addEventListener('click', () => {
    if (closeMenu !== null) {
      closeMenu()
      return
    }
    openMenu()
  })

  /**
   * Open the menu on the chip.
   *
   * TWO STAGES IN ONE POPOVER, not two popovers. "Where does the work happen"
   * and "where does that branch begin" are one decision read at two depths, and
   * a second overlay on top of the first would be the modal stack this whole
   * plan exists to remove.
   */
  function openMenu(): void {
    const popover = openAnchoredPopover({
      anchor: chip,
      watch: host,
      className: 'fl-fmenu',
      ariaLabel: 'Where this thread works',
      onClose: () => {
        closeMenu = null
      },
    })
    closeMenu = popover.close

    /**
     * The live name field, while the menu is showing one.
     *
     * A BOX RATHER THAN A BARE `let`, because every reader of it sits inside a
     * handler that runs after a redraw has replaced it: TypeScript narrows a
     * captured `let` to its initialiser and then refuses the reads, which is
     * the compiler being right about the shape and wrong about the order. A
     * property is re-read after every call, which is exactly when this changes.
     */
    const live: { field: HTMLInputElement | null } = { field: null }

    const draw = (): void => {
      popover.panel.replaceChildren()
      // The field is rebuilt by every draw that has one; forgetting to drop it
      // here leaves a handle on a detached input, and focusing that quietly
      // takes the caret out of the document.
      live.field = null
      drawPlacement()
      popover.reposition()
    }

    /**
     * THE SAME QUESTION, THE SAME SHAPE, AS THE EXPLORER'S PANEL.
     *
     * This was three rungs — "On its own branch", "In the project", "Start from
     * another branch…" — a list where the first two were a binary wearing a
     * menu's clothes, and the third was a different kind of question sitting in
     * the same list. The explorer panel had already settled the binary as a
     * switch with a name under it, and a person meeting both surfaces was
     * meeting two designs for one decision (user, 2026-09-17: "we should have
     * two options: the name of the branch that the user can type or select, and
     * the switch to enable or not the worktree … the exact same experience that
     * we added on the explorer").
     *
     * So: the switch, its name, and — only when it is on — where it begins.
     */
    function drawPlacement(): void {
      const seed = options.seed()
      const own = choice.placement === 'own'
      const taken = choice.start.kind === 'checkout' ? choice.start.branch : null
      const project = projectBranch?.trim() ?? ''

      const row = document.createElement('div')
      row.className = 'fl-wt-switch'
      const label = document.createElement('div')
      label.className = 'fl-wt-label'
      const name = document.createElement('div')
      name.className = 'fl-wt-name'
      name.textContent = SWITCH_NAME
      const state = document.createElement('div')
      state.className = 'fl-wt-state'
      // THE SWITCH IS ABOUT THE CHECKOUT. Which branch the work lands on is the
      // row below — two different things, said separately (user, 2026-09-17:
      // "we should have two dif things, one is branch, and another is worktree
      // … we need to separate that concept everywhere").
      state.textContent = own
        ? 'On — a checkout of its own'
        : 'Off — works in your project folder'
      label.append(name, state)

      const track = document.createElement('button')
      track.type = 'button'
      track.className = 'fl-wt-track'
      track.setAttribute('role', 'switch')
      track.setAttribute('aria-checked', String(own))
      track.setAttribute('aria-label', SWITCH_NAME)
      track.setAttribute('data-on', String(own))
      const knob = document.createElement('span')
      knob.className = 'fl-wt-knob'
      track.appendChild(knob)
      track.addEventListener('click', () => {
        // NOTHING IS CUT HERE. This chip only decides what the thread will ask
        // for when it is created, so the switch is a plain toggle — the panel's
        // arm-then-confirm exists because ITS switch acts on a real checkout.
        choice = { ...choice, placement: own ? 'project' : 'own' }
        picked()
        draw()
        live.field?.focus()
      })
      row.append(label, track)
      popover.panel.appendChild(row)

      // THE BRANCH ROW, IN BOTH STATES, always answering the same question:
      // which branch does this conversation's work land on.
      if (!own) {
        // ONE FOLDER, SO IT IS A REPORT RATHER THAN A CHOICE. Picking another
        // branch here would have to check it out in the project folder, moving
        // files nobody asked to move; the switch above is the way to a branch
        // of your own.
        const row = document.createElement('div')
        row.className = 'fl-wt-branch'
        const label = document.createElement('span')
        label.className = 'fl-wt-branch-label'
        label.textContent = 'Branch'
        const name = document.createElement('span')
        name.className = project === '' ? 'fl-wt-branch-none' : 'fl-wt-branch-name'
        name.textContent = project === '' ? 'could not be read' : project
        if (project !== '') row.title = project
        row.append(label, name)
        popover.panel.appendChild(row)
        // NOT THE BASE, AND SAID SO. The folder's branch is a report here, so
        // when it is not where a new conversation should begin, the one press
        // that gets there — the switch — is named beside it.
        const note = projectFolderNote({
          projectBranch,
          choices: branches,
          worktreesAllowed: defaults.worktreesAllowed,
        })
        if (note !== null) {
          const line = document.createElement('p')
          line.className = 'fl-fmenu-problem'
          line.setAttribute('data-tone', 'note')
          line.textContent = note
          popover.panel.appendChild(line)
        }
        return
      }

      // OPTION B, THE PANEL'S SHAPE. The prefix sits inside the field and the
      // branch it produces is one muted line under it; the link is for the few
      // who want the two names different (user, 2026-09-17: "this is perfect").
      // A BRANCH TAKEN IS NOT MADE, so a checkout that takes one shows no
      // branch field at all — the folder still needs its name either way.
      popover.panel.appendChild(folderRow(seed))
      if (taken === null) popover.panel.appendChild(branchRow(seed))
      popover.panel.appendChild(startRow())

      // A COMPACT STARTING POINT, NOT THE OLD STAGE. The base is the default
      // (2026-09-17: "new thread should always start from main"), and the list
      // of every branch with three lines each stays gone (2026-09-17: "remove
      // that picker from the new thread"). What came back is one line — the
      // base, the branch you are on, the rest — because without it there was
      // no way to start from anywhere but the base once the switch was on, and
      // no way to start from the base at all with it off (2026-10-08).
    }

    /** Where the branch of its own begins — one native list, base first. */
    function startRow(): HTMLElement {
      const block = document.createElement('div')
      block.className = 'fl-fmenu-namefield'
      const label = document.createElement('div')
      label.className = 'fl-wt-namelabel'
      label.textContent = 'Starts from'
      const select = document.createElement('select')
      select.className = 'fl-fmenu-input'
      select.setAttribute('aria-label', 'Starts from')
      const entries = startPickerOptions({ choices: branches, start: choice.start })
      for (const entry of entries) {
        const option = document.createElement('option')
        option.value = entry.id
        option.textContent = entry.text
        option.selected = entry.selected
        select.appendChild(option)
      }
      select.addEventListener('change', () => {
        const entry = entries.find((candidate) => candidate.id === select.value)
        if (entry === undefined) return
        choice = { ...choice, start: entry.start }
        picked()
        // A TAKEN branch has no name field and a made one does: redraw so the
        // rows above match what was just picked.
        draw()
      })
      block.append(label, select)
      return block
    }

    /**
     * The folder, with its prefix inside the field.
     *
     * The value here is the STEM — what follows `worktree-` — so the rule is on
     * screen instead of in a sentence under it.
     */
    function folderRow(seed: string): HTMLElement {
      const block = document.createElement('div')
      block.className = 'fl-fmenu-namefield'
      const label = document.createElement('div')
      label.className = 'fl-wt-namelabel'
      label.textContent = 'Folder'
      const wrap = document.createElement('div')
      wrap.className = 'fl-wt-prefixed'
      const fixed = document.createElement('span')
      fixed.className = 'fl-wt-fixed'
      fixed.textContent = WORKTREE_FOLDER_PREFIX
      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'fl-fmenu-input'
      input.value = folderStem(choice, seed)
      input.setAttribute('aria-label', `Folder name, after ${WORKTREE_FOLDER_PREFIX}`)
      wrap.append(fixed, input)

      const problem = document.createElement('p')
      problem.className = 'fl-fmenu-problem'
      problem.hidden = true
      problem.setAttribute('role', 'alert')

      input.addEventListener('input', () => {
        const typed = input.value.trim()
        if (typed === '') {
          problem.hidden = true
          choice = { ...choice, typedWorktree: null }
          picked()
          return
        }
        const verdict = validateWorktreeName(`${WORKTREE_FOLDER_PREFIX}${typed}`)
        problem.textContent = verdict.ok ? '' : verdict.detail
        problem.hidden = verdict.ok
        if (!verdict.ok) {
          popover.reposition()
          return
        }
        choice = { ...choice, typedWorktree: verdict.name }
        picked()
      })

      block.append(label, wrap, problem)
      return block
    }

    /** The branch's own field, once it no longer follows the folder. */
    function nameRow(seed: string): HTMLElement {
      const wrap = document.createElement('div')
      wrap.className = 'fl-fmenu-row'
      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'fl-fmenu-input'
      // PRE-FILLED WITH THE NAME IT WOULD GET — the whole of it. A box showing
      // half a branch refuses edits to the half it hid.
      input.value = chosenBranchName(choice, seed)
      input.setAttribute('aria-label', 'Branch name')
      wrap.appendChild(input)
      live.field = input

      const problem = document.createElement('p')
      problem.className = 'fl-fmenu-problem'
      problem.hidden = true
      problem.setAttribute('role', 'alert')

      const read = (): boolean => {
        const outcome = readBranchField(input.value)
        if (outcome.kind === 'refused') {
          problem.textContent = outcome.detail
          problem.hidden = false
          popover.reposition()
          return false
        }
        problem.hidden = true
        choice =
          outcome.kind === 'following'
            ? { ...choice, typedName: null }
            : { ...choice, typedName: outcome.name }
        picked()
        return true
      }

      input.addEventListener('input', () => void read())
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        if (read()) popover.close()
      })

      const block = document.createElement('div')
      block.className = 'fl-fmenu-namefield'
      block.append(wrap, problem)
      return block
    }

    /**
     * The branch — one muted line while it follows the folder's name, a field
     * of its own once somebody says it should not.
     */
    function branchRow(seed: string): HTMLElement {
      const block = document.createElement('div')
      block.className = 'fl-fmenu-namefield'
      if (choice.typedName === null) {
        const line = document.createElement('div')
        line.className = 'fl-wt-branch'
        const key = document.createElement('span')
        key.className = 'fl-wt-branch-label'
        key.textContent = 'branch'
        const value = document.createElement('span')
        value.className = 'fl-wt-branch-name'
        const branch = chosenBranchName(choice, seed)
        value.textContent = branch
        line.append(key, value)
        // ALREADY A BRANCH IS NOT A PROBLEM, it is a different plan: the
        // checkout takes it rather than starting one. Same sentence the panel
        // gives, from the list this chip was already handed.
        if ((branches?.branches ?? []).some((option) => option.name === branch)) {
          const note = document.createElement('p')
          note.className = 'fl-fmenu-problem'
          note.setAttribute('data-tone', 'note')
          note.textContent = `‘${branch}’ already exists — this thread will work on it.`
          block.appendChild(note)
        }
        const link = document.createElement('button')
        link.type = 'button'
        link.className = 'fl-wt-link'
        link.textContent = 'Use a different branch name'
        link.addEventListener('click', () => {
          choice = { ...choice, typedName: chosenBranchName(choice, seed) }
          picked()
          draw()
          live.field?.focus()
          live.field?.select()
        })
        block.append(line, link)
        return block
      }
      const label = document.createElement('div')
      label.className = 'fl-wt-namelabel'
      label.textContent = 'Branch'
      block.appendChild(label)
      block.appendChild(nameRow(seed))
      return block
    }

    draw()
    // The caret starts in the name field when there is one — it is the only
    // thing on this menu a person types into — and on the menu itself
    // otherwise, so Escape always has somewhere inside to come from.
    const field = live.field
    if (field === null) {
      popover.panel.focus()
    } else {
      field.focus()
      field.select()
    }
  }

  paint()

  return {
    element: host,
    choice: () => choice,
    refresh: paint,
    reset() {
      closeMenu?.()
      touched = false
      defaults = { ...UNREAD_DEFAULTS }
      branches = null
      choice = { ...INITIAL_BRANCH_CHOICE }
      changed()
    },
    setProjectBranch(branch) {
      projectBranch = branch
      paint()
    },
    setBranches(choices) {
      branches = choices
      applyDefault()
    },
    setWorktreeDefaults(next) {
      defaults = { ...next }
      applyDefault()
    },
  }
}

let chipStylesInjected = false

function injectChipStyles(): void {
  if (chipStylesInjected) return
  chipStylesInjected = true
  const style = document.createElement('style')
  // Existing tokens only — no new design language. An array of lines rather
  // than a template literal: a backtick in one breaks this repo's build.
  style.textContent = [
    '.fl-newbranch-host { display: inline-flex; min-width: 0; }',
    '.fl-newbranch-chip {',
    '  display: inline-flex;',
    '  align-items: center;',
    '  gap: var(--fl-space-xs);',
    '  min-width: 0;',
    '  max-width: 200px;',
    '  padding: 1px var(--fl-space-xs);',
    '  border: var(--fl-border-width) solid transparent;',
    '  border-radius: var(--fl-radius-sm);',
    '  background: transparent;',
    '  font-family: var(--fl-font-ui);',
    '  font-size: var(--fl-text-caption-size);',
    '  line-height: var(--fl-line-height-dense);',
    '  cursor: pointer;',
    '}',
    '.fl-newbranch-glyph { flex: none; }',
    '.fl-newbranch-label {',
    '  min-width: 0;',
    '  overflow: hidden;',
    '  text-overflow: ellipsis;',
    '  white-space: nowrap;',
    '  font-family: var(--fl-font-mono);',
    '}',
    /* LIT for a branch of its own — the thing this thread will be responsible
       for. Dim for the project's, which is context rather than news. The same
       two tones the header chip uses for the same two states. */
    '.fl-newbranch-chip.is-own {',
    '  color: var(--fl-color-accent);',
    '  border-color: var(--fl-color-accent-muted);',
    '  background: var(--fl-color-accent-muted);',
    '}',
    '.fl-newbranch-chip.is-project { color: var(--fl-color-text-secondary); }',
    '.fl-newbranch-chip:hover { border-color: var(--fl-color-accent); }',
    '.fl-newbranch-chip:focus-visible {',
    '  outline: 2px solid var(--fl-color-focus-ring);',
    '  outline-offset: 1px;',
    '}',
    '.fl-fmenu-namefield { display: flex; flex-direction: column; gap: var(--fl-space-xs); }',
  ].join('\n')
  document.head.appendChild(style)
}
