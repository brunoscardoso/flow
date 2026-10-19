/**
 * THE WORKTREE PANEL — one switch, and what it asks before it acts.
 *
 * THE WHOLE QUESTION IS BINARY: does this conversation have a copy of the
 * project to itself, or is it changing your files? So the panel is a switch,
 * plus whatever that switch needs to say.
 *
 * NOTHING HERE ACTS ON A SINGLE CLICK. Flipping the switch opens a question —
 * a branch name going on, a typed confirmation coming off — or it refuses. That
 * is what makes a control which deletes a directory acceptable as a toggle
 * (forbidden-pattern #15). Take the ask away and the toggle has to go with it.
 *
 * WHAT WAS CUT, AND BY WHOM. Four earlier drafts of this panel showed a
 * project-wide list, then a branch name, then a rename control, then a wall of
 * prose. Every one of them was removed by the person using it: the branch name
 * belongs to the Changes toolbar, renaming belongs where the branch is, and a
 * list of other conversations' worktrees answered a question nobody asked. What
 * is left is the question they actually had.
 *
 * IT DECIDES NOTHING TWICE. Whether a worktree may be removed is `deleteAction`
 * (the Storage page's own rule); whether a typed branch name is usable is
 * `validateBranchName` (the cut and the rename already share it). This file
 * renders what they say.
 */

import type { ThreadSummary } from '../../shared/ipc-contract'
import { injectWorktreeStyles } from './worktree-styles'
import type { CarryAnswer, CarryQuestion } from '../threads/new-thread-branch'
import { validateBranchName } from '../threads/branch-name'
import {
  WORKTREE_FOLDER_PREFIX,
  validateWorktreeName,
  worktreeNameFromTitle,
} from '../../shared/worktree-name'
import { threadWorktreeState, type ThreadWorktreeState } from './thread-worktree-state'
import {
  switchView,
  SWITCH_NAME,
  type Armed,
} from './worktree-switch'

/**
 * The panel's stylesheet — exported because the new-thread chip draws the SAME
 * switch on its menu. One definition, two surfaces: a second copy of these
 * rules is a second switch that drifts from this one (allowed-pattern #14).
 */

export interface WorktreePanelCallbacks {
  /**
   * Make this conversation a worktree.
   *
   * NO BRANCH. The checkout is cut detached and named later from the title —
   * the app's own long-standing behaviour, and what lets several worktrees be
   * cut from one branch without arguing about names.
   *
   * THE ONE REMAINING QUESTION IS ASKED BY THIS PANEL. When the project's tree
   * is dirty, main refuses to decide what happens to that uncommitted work and
   * answers `needs-choice`; `askCarry` draws that question here. The refusal is
   * correct and stays — it is the difference between this and the branch-name
   * ask, which decided nothing anybody needed to decide.
   *
   * Returns what happened, so a refusal reaches the reader instead of the press
   * appearing to do nothing.
   */
  /**
   * The branches this project already has — read once when the naming ask
   * opens, so a name that is already a branch can be RECOGNISED rather than
   * collided with.
   */
  listBranches?: () => Promise<readonly string[]>
  create: (
    threadId: string,
    branch?: string,
    worktreeName?: string,
    /**
     * True when that branch already exists, so the checkout TAKES it rather
     * than trying to create a branch git would refuse to create twice.
     */
    takeExisting?: boolean,
  ) => Promise<{ ok: boolean; detail: string | null }>
  /**
   * Release this conversation's worktree.
   *
   * Returns what main SAID. The refusal is the authority on whether a worktree
   * still holds work — this panel does not pre-compute that and never did it
   * correctly when it tried.
   *
   * `discard` IS THE SECOND SAY-SO, and it is a separate press. Without it a
   * checkout holding uncommitted work is refused, which is right: those files
   * live nowhere else. What was wrong is that the refusal's remedy ("say to let
   * it go") named something no control could say — a dead end wearing a
   * sentence's clothes (forbidden-pattern #12). `holds` is what makes the ask
   * possible: the refusal carries its own answer (allowed-pattern #21).
   */
  remove: (
    threadId: string,
    discard?: boolean,
  ) => Promise<{
    ok: boolean
    detail: string
    /** Present only when the refusal was "there is work in here". */
    holds?: { changedFiles: number; aheadCommits: number }
  }>
}

export class WorktreePanel {
  readonly #root: HTMLElement
  readonly #callbacks: WorktreePanelCallbacks
  #rootPath: string | null = null
  #projectBranch: string | null = null
  #thread: ThreadSummary | null = null
  #visible = false
  /** A verb this panel started, in flight. */
  #busy = false
  /**
   * What the last removal refused over, when it refused for holding work.
   *
   * Set ONLY by a `holds-work` refusal and cleared by `#disarm`, so the second
   * question cannot outlive the answer that justified it.
   */
  #holding: { changedFiles: number; aheadCommits: number } | null = null
  /** What has been asked for but not confirmed. */
  #armed: Armed = 'none'
  /** The carry question, while one is open, and what to do with the answer. */
  #carry: { question: CarryQuestion; resolve: (answer: CarryAnswer) => void } | null = null
  /** The project's branches, while a naming ask is open. Empty until read. */
  #branches: readonly string[] = []
  /** What is in each name field while the naming ask is open. */
  #names: { stem: string; branch: string; same: boolean } = {
    stem: '',
    branch: '',
    same: true,
  }
  /** What main said when it refused, or null. */
  #failure: string | null = null

  constructor(callbacks: WorktreePanelCallbacks) {
    injectWorktreeStyles()
    this.#callbacks = callbacks
    this.#root = document.createElement('div')
    this.#root.className = 'fl-wt'
    this.#paint()
  }

  get element(): HTMLElement {
    return this.#root
  }

  setVisible(visible: boolean): void {
    const became = visible && !this.#visible
    this.#visible = visible
    // PAINT IS NEVER GATED, only the read is.
    if (became) this.#paint()
  }

  setProject(rootPath: string | null, projectBranch: string | null): void {
    // THE SAME PROJECT IS NOT A CHANGE OF SUBJECT.
    //
    // This disarmed unconditionally, and the project is re-announced for
    // reasons that have nothing to do with the reader — a branch read
    // resolving, an activeProjectChanged broadcast. Mid-question that threw
    // away a half-typed name and the panel fell back to Off, which on screen is
    // the ask vanishing while somebody is typing into it.
    const moved = this.#rootPath !== rootPath
    this.#rootPath = rootPath
    this.#projectBranch = projectBranch
    if (moved) this.#disarm()
    // …and a repaint would rebuild the field the caret is in either way.
    if (moved || this.#armed === 'none') this.#paint()
  }

  /**
   * The reader moved to another conversation.
   *
   * WHETHER IT HAS A WORKTREE IS ALREADY HERE, on the thread record, and it is
   * decided by comparing that path with the project's. Nothing is read, so the
   * panel settles in the same frame.
   */
  setThread(thread: ThreadSummary | null): void {
    // SAME RULE, SAME REASON: a conversation is re-announced on every reload of
    // its record, and only a different conversation is a different subject.
    const moved = this.#thread?.id !== thread?.id
    this.#thread = thread
    if (moved) this.#disarm()
    if (moved || this.#armed === 'none') this.#paint()
  }

  /** Forget an unanswered question. Nothing to undo — nothing was done. */
  #disarm(): void {
    this.#armed = 'none'
    this.#holding = null
    this.#names = { stem: '', branch: '', same: true }
    this.#failure = null
  }

  /**
   * Whether there is a conversation and a project for this panel to speak about.
   *
   * The panel is always on screen now — nobody presses anything to see it — so
   * something has to decide when it has nothing to say. Its empty states ("Open
   * a conversation to manage its worktree") are a fine answer to a press and a
   * poor thing to park permanently above somebody's file tree.
   */
  hasSubject(): boolean {
    const kind = this.#state().kind
    return kind !== 'no-project' && kind !== 'no-thread'
  }

  /** Whether the conversation on screen works in a copy of its own. */
  isOwnCopy(): boolean {
    return this.#state().kind === 'own'
  }

  #state(): ThreadWorktreeState {
    return threadWorktreeState(this.#rootPath, this.#thread, this.#projectBranch)
  }

  // ── Painting ─────────────────────────────────────────────────────────────

  #paint(): void {
    // NOT WHILE A QUESTION IS OPEN.
    //
    // Painting rebuilds every element in this panel, including the switch that
    // an open carry menu is anchored to — and that menu resolves null the
    // instant its anchor leaves the screen. Any repaint from anywhere (a
    // re-fired active-thread event, a thread reload) therefore cancelled the
    // question the reader was in the middle of answering: on screen, a blink
    // and no worktree.
    //
    // The guard is here rather than at each caller because the callers are not
    // the problem — they are all correct to want a repaint, and there are more
    // of them than anybody will remember.
    // …except to SHOW a question this panel owns. The guard exists so an
    // outside repaint cannot destroy an anchored menu mid-answer; the carry
    // question is drawn by this panel, into this panel, so it is not at risk.
    if (this.#busy && this.#carry === null) return
    this.#root.textContent = ''

    const state = this.#state()
    if (state.kind === 'no-project' || state.kind === 'no-thread') {
      const empty = document.createElement('div')
      empty.className = 'fl-wt-empty'
      empty.textContent =
        state.kind === 'no-project'
          ? 'Open a project to manage this conversation’s worktree.'
          : 'Open a conversation to manage its worktree.'
      this.#root.appendChild(empty)
      return
    }

    // WAITING FOR AN ANSWER IS NOT BEING BUSY. A verb is in flight from the
    // moment it is asked for until it settles — but while the carry question is
    // open, the thing in flight is a QUESTION, and the switch said "Setting it
    // up…" over a worktree nobody had agreed to make yet. Same lie as "Reading
    // what's in it…" while nothing read: a control claiming to work when it is
    // waiting on the person reading it.
    const working = this.#busy && this.#carry === null
    const view = switchView(state, this.#armed, working)
    const body = document.createElement('div')
    body.className = 'fl-wt-body'
    body.appendChild(this.#switchRow(view))

    // ONE FACT, ONE ROW: WHICH FOLDER.
    //
    // This panel had a Branch row for a day, added when the switch's state line
    // came down. It has to go for the same reason that line did: the branch is
    // not what this surface is about, and a reader who wants it has the chip in
    // the Changes toolbar — which is also the only place it can be CHANGED
    // (user, 2026-09-18: "dont need to have the branch name here, only the
    // worktree").
    //
    // Two rows also made the panel argue with itself. `Folder
    // worktree-incomplete-unit-test-cleanup-pr` over `Branch
    // thread/incomplete-unit-test-cleanup-pr` is the same words three ways, and
    // nothing on screen said which of them mattered here. The answer is the
    // folder: this switch makes and removes a directory.
    //
    // ABSENT FOR A CHECKOUT NOBODY NAMED. `checkoutName` answers null for a
    // directory still called after a thread id, and a uuid is the one thing
    // this panel must never print.
    if (this.#armed === 'none' && state.kind === 'own' && state.folder !== null) {
      const folder = document.createElement('div')
      folder.className = 'fl-wt-branch'
      const name = document.createElement('span')
      name.className = 'fl-wt-branch-name'
      // NO LABEL. `Folder` sat in front of a name that opens with the word
      // `worktree/`, under a switch called Worktree — three sayings of one
      // thing, stacked (user, 2026-09-18: "remove that folder label, keep only
      // the name of the worktree"). The name is self-describing, so it is the
      // whole row.
      name.textContent = state.folder
      folder.title = state.folder
      folder.appendChild(name)
      body.appendChild(folder)
    }

    // ONLY WHAT IS WRONG. The switch is one decision for every project this
    // conversation carries, so a project that HAS its own copy is simply the
    // switch being true and needs no line of its own (user, 2026-09-17: "if is
    // enabled we know"). A project still sitting in your real files is the
    // opposite: it is the switch being false where it claims to be true, and
    // that gets named, with the action that fixes it.
    // STRANDED MEANS "HAS NO COPY", which is a question about the PATH.
    //
    // This asked `branch === null`, which is a different question and wrong for
    // every checkout cut detached — and a detached primary cuts detached
    // attachments by design. So a project that already had its own copy was
    // listed as "still your main folder" under a repair button that could not
    // help: pressing it reaches `prepareAttached`, which correctly skips a root
    // that already has a checkout, so nothing happened and nothing could.
    const stranded =
      state.kind === 'own' && this.#armed === 'none'
        ? state.others.filter((other) => other.path === null)
        : []
    if (stranded.length > 0) {
      const others = document.createElement('div')
      others.className = 'fl-wt-others'
      for (const other of stranded) {
        const row = document.createElement('div')
        row.className = 'fl-wt-other'
        const name = document.createElement('span')
        name.className = 'fl-wt-other-name'
        name.textContent = other.name
        const note = document.createElement('span')
        note.className = 'fl-wt-other-none'
        note.textContent = 'still your main folder'
        note.title = 'This project has no copy of its own — the agent edits it directly.'
        row.append(name, note)
        others.appendChild(row)
      }
      const fix = document.createElement('button')
      fix.type = 'button'
      fix.className = 'fl-wt-fix'
      fix.textContent = stranded.length === 1 ? 'Give it a copy too' : 'Give them copies too'
      fix.disabled = this.#busy
      fix.addEventListener('click', () => {
        fix.textContent = 'Setting them up…'
        fix.setAttribute('data-working', 'true')
        fix.disabled = true
        void this.#fixStranded()
      })
      others.appendChild(fix)
      body.appendChild(others)
    }

    if (this.#carry !== null) body.appendChild(this.#askCarry(this.#carry))
    else if (this.#armed === 'discard' && this.#holding !== null) {
      body.appendChild(this.#askDiscard(this.#holding))
    } else if (this.#armed === 'remove' && state.kind === 'own') {
      body.appendChild(this.#askRemove(state.branch))
    } else if (this.#armed === 'name' && state.kind === 'in-project') {
      body.appendChild(this.#askName())
    }

    // WHAT MAIN SAID, where the press was. A refusal is not an error: it is the
    // authoritative answer to a question this panel deliberately stopped
    // guessing at.
    if (this.#failure !== null) body.appendChild(this.#note(this.#failure, 'warn'))

    this.#root.appendChild(body)
  }



  #switchRow(view: ReturnType<typeof switchView>): HTMLElement {
    const row = document.createElement('div')
    row.className = 'fl-wt-switch'

    const label = document.createElement('div')
    label.className = 'fl-wt-label'
    const name = document.createElement('div')
    name.className = 'fl-wt-name'
    name.textContent = SWITCH_NAME
    label.appendChild(name)
    // AN EMPTY LINE IS NOT RENDERED. The element carries its own height and
    // spacing, so appending a blank one would hold open the gap the line used to
    // fill — the branch row would sit exactly where it did, under a space where
    // a sentence had been, which is the opposite of moving it up.
    if (view.stateLine !== '') {
      const state = document.createElement('div')
      state.className = 'fl-wt-state'
      state.textContent = view.stateLine
      label.appendChild(state)
    }

    const track = document.createElement('button')
    track.type = 'button'
    track.className = 'fl-wt-track'
    track.setAttribute('data-on', String(view.on))
    track.setAttribute('data-armed', String(view.armed))
    track.setAttribute('role', 'switch')
    track.setAttribute('aria-checked', String(view.on))
    track.setAttribute('aria-label', SWITCH_NAME)
    track.disabled = view.locked
    const knob = document.createElement('span')
    knob.className = 'fl-wt-knob'
    track.appendChild(knob)
    track.addEventListener('click', () => this.#flip(view.on))

    row.append(label, track)
    return row
  }

  /**
   * A press, in the direction it was pressed.
   *
   * THE TWO DIRECTIONS ARE NOT THE SAME. Turning it ON makes a worktree — a new
   * directory, destroying nothing, undone by the other half of this switch — so
   * it happens. Turning it OFF deletes one, so it opens a question.
   *
   * IT DOES NOT ASK FOR A BRANCH NAME, and asking was a mistake of mine: a
   * worktree does not need one. `prepareWorktree` with no branch cuts the
   * checkout detached and names it later from the conversation's title, which is
   * what every worktree did before this panel existed. Demanding a name up
   * front duplicated that, and blocked the plain case of three worktrees all cut
   * from the same branch — which is most of why somebody wants them.
   */
  #flip(isOn: boolean): void {
    this.#failure = null
    if (this.#armed !== 'none') {
      this.#disarm()
      this.#paint()
      return
    }
    if (isOn) {
      this.#armed = 'remove'
      this.#paint()
      return
    }
    // ASK FOR THE NAME. It used to cut the copy on the press and name it later
    // from the conversation's title — correct on its own terms, and it read as
    // the app doing something irreversible without a word (user, 2026-09-17:
    // "that didn't ask the name of the worktree"). The suggestion is filled in,
    // so the whole ask can be one Return.
    this.#armed = 'name'
    // PRE-FILLED FROM THE SAME TITLE, and independent from that moment on.
    const title = this.#thread?.title ?? null
    // ONE WORD, PRE-FILLED, AND NO PREFIX ON IT. Linked, the typed word is the
    // branch exactly as typed; the folder is derived from it at the cut.
    // ONE WORD, PRE-FILLED, AND THE PREFIX IS THE FIELD'S, not the value's.
    this.#names = { stem: worktreeNameFromTitle(title), branch: '', same: true }
    this.#branches = []
    this.#paint()
    // ONE READ, WHEN THE QUESTION OPENS. Not per keystroke: the list does not
    // change while somebody types a name into a panel, and a git call per
    // character is the cost this app has learned to refuse (allowed-pattern
    // #20).
    void this.#callbacks
      .listBranches?.()
      .then((branches) => {
        this.#branches = branches
        // Only repaint if the question is still the one that asked.
        if (this.#armed === 'name') this.#paint()
      })
      .catch(() => undefined)
  }

  /**
   * The removal ask.
   *
   * THE BRANCH NAME APPEARS HERE AND NOWHERE ELSE in this panel. It was removed
   * from every other surface for being noise — but you cannot be asked to type
   * a name you were never shown, and the moment before a directory goes is
   * exactly when reading it is the point.
   */
  /**
   * The removal ask: what goes, what stays, and two buttons.
   *
   * NO TYPING. It used to demand the branch name typed out, which is the
   * heaviest confirmation a UI has and it was guarding the wrong thing: the
   * branch and its commits SURVIVE a removal, so the name being typed was the
   * name of the part that is not at risk. What is at risk is whatever is in the
   * folder and not committed, and no amount of transcription protects that —
   * saying it plainly does (user, 2026-09-17: "the user don't need to type the
   * message, we need just to be clear that the worktree, the folder will be
   * deleted").
   *
   * STILL NOT ONE CLICK. The switch arms the question; the question is what
   * acts (forbidden-pattern #15). Two deliberate presses, no transcription.
   */
  #askRemove(branch: string | null): HTMLElement {
    const ask = document.createElement('div')
    ask.className = 'fl-wt-ask'

    const q = document.createElement('div')
    q.className = 'fl-wt-q'
    q.setAttribute('data-danger', 'true')
    q.textContent = 'Delete this worktree?'

    const loss = document.createElement('div')
    loss.className = 'fl-wt-sub'
    // THE CONSEQUENCE FIRST, in the terms of the thing on screen: a folder, and
    // what is inside it.
    loss.textContent =
      'The folder is deleted. Anything in it you haven’t committed goes with it.'

    const kept = document.createElement('div')
    kept.className = 'fl-wt-sub'
    // AND WHAT SURVIVES. The branch is the part people are afraid of losing,
    // and it is not lost — naming it is what makes the warning above credible.
    kept.textContent =
      branch === null
        ? 'Your main folder is untouched.'
        : `${branch} and its commits stay. Your main folder is untouched.`
    kept.title = branch ?? ''

    const acts = document.createElement('div')
    acts.className = 'fl-wt-acts'
    const go = document.createElement('button')
    go.type = 'button'
    go.textContent = 'Delete'
    go.setAttribute('data-tone', 'danger')
    go.disabled = this.#busy
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => {
      this.#disarm()
      this.#paint()
    })
    go.addEventListener('click', () => {
      this.#working(go, 'Deleting…', [cancel])
      void this.#remove()
    })
    acts.append(go, cancel)

    // Escape abandons the question, the way it does everywhere else here.
    ask.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      this.#disarm()
      this.#paint()
    })
    queueMicrotask(() => cancel.focus())

    ask.append(q, loss, kept, acts)
    return ask
  }

  /**
   * The SECOND question — the one the refusal used to name and not offer.
   *
   * A checkout holding uncommitted files is refused, and that is right: those
   * files live nowhere else, and nothing should delete them because somebody
   * pressed a switch. What was wrong is that the refusal said "Land the work
   * first, or say to let it go" and there was no way to say it — a remedy in a
   * sentence, with no control behind it (forbidden-pattern #12). So the press
   * dead-ended, permanently, on the one state where the warning mattered most.
   *
   * IT NAMES WHAT GOES, IN NUMBERS MAIN COUNTED. The panel does not re-derive
   * them — it never did that correctly when it tried — and a question that said
   * only "delete anyway?" would be asking for consent to something unnamed.
   */
  #askDiscard(holding: { changedFiles: number; aheadCommits: number }): HTMLElement {
    const ask = document.createElement('div')
    ask.className = 'fl-wt-ask'

    const q = document.createElement('div')
    q.className = 'fl-wt-q'
    q.setAttribute('data-danger', 'true')
    q.textContent = 'Delete it with the work inside?'

    const loss = document.createElement('div')
    loss.className = 'fl-wt-sub'
    loss.setAttribute('data-tone', 'bad')
    // THE UNCOMMITTED FILES ARE THE WHOLE POINT. Commits on a branch are not at
    // risk and are not mentioned here — saying "and 3 commits" beside them
    // would put a thing that survives in a sentence about things that do not.
    const files = holding.changedFiles
    loss.textContent =
      files > 0
        ? `${files === 1 ? 'One file has' : `${files} files have`} changes you never committed. Deleting the folder deletes them, and nothing can bring them back.`
        : 'This copy is on no branch, so anything it committed is reachable from nowhere else. Deleting the folder deletes those commits.'

    const acts = document.createElement('div')
    acts.className = 'fl-wt-acts'
    const go = document.createElement('button')
    go.type = 'button'
    // THE BUTTON SAYS WHAT IT DOES, not "Yes". A second confirm whose verb is
    // weaker than the first one reads as the softer choice.
    go.textContent = 'Delete and lose the work'
    go.setAttribute('data-tone', 'danger')
    go.disabled = this.#busy
    const cancel = document.createElement('button')
    cancel.type = 'button'
    // KEEPING IT IS THE DEFAULT AND SAYS SO. "Cancel" is what you press to
    // escape a dialog; this is a choice between two outcomes.
    cancel.textContent = 'Keep the worktree'
    cancel.addEventListener('click', () => {
      this.#disarm()
      this.#paint()
    })
    go.addEventListener('click', () => {
      this.#working(go, 'Deleting…', [cancel])
      void this.#remove(true)
    })
    acts.append(go, cancel)

    ask.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      this.#disarm()
      this.#paint()
    })
    // The caret starts on KEEPING it: a question about destroying work does not
    // put the destructive button under a stray Return.
    queueMicrotask(() => cancel.focus())

    ask.append(q, loss, acts)
    return ask
  }

  /**
   * Put the carry question to the reader, INSIDE this panel.
   *
   * WHY NOT THE SHARED MENU. `askCarryInline` opens its own anchored popover,
   * and this panel is already in one — a menu inside a menu, where the inner
   * one's overlay closes the outer and takes the question with it. Nesting
   * anchored popovers is a fight not worth having for a three-option choice.
   *
   * EVERY WORD STILL COMES FROM `carryQuestion`. Only the container changed:
   * the sentence, the three options, their order and what a dismissal means are
   * decided (and tested) in `new-thread-branch.ts`, exactly as they are for the
   * new-thread chip.
   */
  askCarry(question: CarryQuestion): Promise<CarryAnswer> {
    return new Promise<CarryAnswer>((resolve) => {
      this.#carry = { question, resolve }
      this.#paint()
    })
  }

  #askCarry(open: { question: CarryQuestion; resolve: (answer: CarryAnswer) => void }): HTMLElement {
    const ask = document.createElement('div')
    ask.className = 'fl-wt-ask'

    const title = document.createElement('div')
    title.className = 'fl-wt-q'
    title.textContent = open.question.title
    const body = document.createElement('div')
    body.className = 'fl-wt-sub'
    body.textContent = open.question.body
    ask.append(title, body)

    const settle = (answer: CarryAnswer): void => {
      this.#carry = null
      open.resolve(answer)
      this.#paint()
    }

    for (const rung of open.question.rungs) {
      const choice = document.createElement('button')
      choice.type = 'button'
      choice.className = 'fl-wt-carry'
      const label = document.createElement('div')
      label.textContent = rung.label
      const detail = document.createElement('div')
      detail.className = 'fl-wt-sub'
      detail.textContent = rung.detail
      choice.append(label, detail)
      choice.addEventListener('click', () => settle(rung.id))
      ask.appendChild(choice)
    }

    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'fl-wt-open'
    cancel.textContent = 'Cancel'
    // WALKING AWAY MAKES NOTHING — null is not an answer, and the flow turns it
    // into no second call at all.
    cancel.addEventListener('click', () => settle(null))
    ask.appendChild(cancel)
    return ask
  }

  #note(text: string, tone: 'warn' | 'bad'): HTMLElement {
    const note = document.createElement('div')
    note.className = 'fl-wt-note'
    note.setAttribute('data-tone', tone)
    note.textContent = text
    return note
  }

  // ── Doing it ─────────────────────────────────────────────────────────────

  async #create(branch?: string, worktreeName?: string, takeExisting?: boolean): Promise<void> {
    const threadId = this.#thread?.id
    if (threadId === undefined || this.#busy) return
    // NO REPAINT UNTIL THIS SETTLES.
    //
    // Painting here destroys and rebuilds every element in the panel — including
    // the switch this call passes as the carry question's anchor. That question
    // resolves null the moment its anchor leaves the screen (deliberately: a
    // person whose mouse moved has not consented to a branch being cut), so
    // repainting first closed the menu before it could be read and the press
    // came back as "dismissed". On screen that was a blink and no worktree.
    //
    // The button is disabled in place instead; the panel is drawn once, at the
    // end, when there is something new to say.
    this.#busy = true
    this.#failure = null
    try {
      const result = await this.#callbacks.create(threadId, branch, worktreeName, takeExisting)
      // A REFUSAL IS NOT SILENCE. This used to discard the answer, so a project
      // with worktrees switched off did nothing at all.
      if (!result.ok) this.#failure = result.detail
    } catch (error) {
      console.warn('flow: could not make this conversation a worktree', error)
      // THE SWITCH FALLS BACK TO OFF, because off is what is true.
      this.#failure = 'Flow couldn’t make it. Nothing has changed.'
    } finally {
      this.#busy = false
      this.#disarm()
      this.#paint()
    }
  }

  /**
   * Give the projects that are still in your real files a copy of their own.
   *
   * SAME VERB AS THE SWITCH. `create` prepares every project the conversation
   * carries and skips the ones already done, so the project that arrived after
   * the switch was thrown is exactly the one it cuts. There is no second code
   * path here and no second rule about what isolation means.
   */
  /**
   * Name the copy before cutting it.
   *
   * THE NAME IS PROPOSED, NOT DEMANDED. It arrives filled in from the
   * conversation's title (allowed-pattern #22: derived values are sanitized,
   * typed ones are validated and refused), so the common answer is Return. A
   * name git would not accept is refused in the field rather than silently
   * rewritten — the branch somebody was shown has to be the branch they get.
   */
  /**
   * NAME IT ONCE, AND SEE WHAT IT MAKES.
   *
   * This was five rows for one decision — a heading, a label, the field, a
   * checkbox, and a line explaining the naming rule (user, 2026-09-17: "this is
   * definitely not clear"). Four of those existed to describe a prefix.
   *
   * So the prefix is SHOWN instead: `worktree-` sits inside the field, fixed
   * and dimmed, the way a URL field shows its scheme. Nothing has to state the
   * rule because it is on screen, and the branch the same word produces is one
   * muted line under it. The link is for the few who want them different.
   */
  #askName(): HTMLElement {
    const ask = document.createElement('div')
    ask.className = 'fl-wt-ask'

    const acts = document.createElement('div')
    acts.className = 'fl-wt-acts'
    const go = document.createElement('button')
    go.type = 'button'
    go.textContent = 'Create'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => {
      this.#disarm()
      this.#paint()
    })
    go.addEventListener('click', () => {
      if (!check()) return
      this.#working(go, 'Creating…', [cancel])
      void this.#createNamed()
    })
    acts.append(go, cancel)

    // ── the folder, with its prefix in the field ──────────────────────────
    const folderLabel = document.createElement('div')
    folderLabel.className = 'fl-wt-namelabel'
    folderLabel.textContent = 'Folder'

    const prefixed = document.createElement('div')
    prefixed.className = 'fl-wt-prefixed'
    const fixed = document.createElement('span')
    fixed.className = 'fl-wt-fixed'
    fixed.textContent = WORKTREE_FOLDER_PREFIX
    const stem = document.createElement('input')
    stem.type = 'text'
    stem.spellcheck = false
    stem.value = this.#names.stem
    stem.setAttribute('aria-label', `Folder name, after ${WORKTREE_FOLDER_PREFIX}`)
    prefixed.append(fixed, stem)

    const folderProblemEl = document.createElement('div')
    folderProblemEl.className = 'fl-wt-sub'

    // ── the branch: a line while it follows, a field once it does not ─────
    const branchLine = document.createElement('div')
    branchLine.className = 'fl-wt-branch'
    const branchKey = document.createElement('span')
    branchKey.className = 'fl-wt-branch-label'
    branchKey.textContent = 'branch'
    const branchValue = document.createElement('span')
    branchValue.className = 'fl-wt-branch-name'
    branchLine.append(branchKey, branchValue)

    const branchLabel = document.createElement('div')
    branchLabel.className = 'fl-wt-namelabel'
    branchLabel.textContent = 'Branch'
    const branchField = document.createElement('div')
    branchField.className = 'fl-wt-field'
    const branchInput = document.createElement('input')
    branchInput.type = 'text'
    branchInput.spellcheck = false
    branchInput.setAttribute('aria-label', 'Branch name')
    branchField.appendChild(branchInput)
    const branchProblemEl = document.createElement('div')
    branchProblemEl.className = 'fl-wt-sub'

    const unlink = document.createElement('button')
    unlink.type = 'button'
    unlink.className = 'fl-wt-link'
    unlink.textContent = 'Use a different branch name'
    unlink.addEventListener('click', () => {
      // WHAT IT WAS ABOUT TO DO BECOMES WHAT IS IN THE FIELD, so unlinking
      // shows the truth rather than a blank to re-type.
      this.#names.branch = this.#branchName()
      this.#names.same = false
      branchInput.value = this.#names.branch
      draw()
      branchInput.focus()
      branchInput.select()
    })

    const check = (): boolean => {
      const typed = this.#names.stem.trim()
      const folder = typed === '' ? '' : `${WORKTREE_FOLDER_PREFIX}${typed}`
      const folderVerdict = folder === '' ? null : validateWorktreeName(folder)
      folderProblemEl.textContent =
        typed === ''
          ? 'Leave it empty and it takes the conversation’s title.'
          : folderVerdict !== null && !folderVerdict.ok
            ? folderVerdict.detail
            : ''

      const branch = this.#branchName()
      branchValue.textContent = branch === '' ? 'named from the title later' : branch
      branchValue.title = branch

      let branchOk = true
      branchProblemEl.textContent = ''
      branchProblemEl.removeAttribute('data-tone')
      if (!this.#names.same) {
        const typedBranch = this.#names.branch.trim()
        if (typedBranch === '') {
          branchProblemEl.textContent = 'Leave it empty and it is named from the title later.'
        } else {
          const verdict = validateBranchName(typedBranch)
          branchOk = verdict.ok
          branchProblemEl.textContent = verdict.ok ? '' : verdict.detail
        }
      }
      // ALREADY A BRANCH IS NOT A PROBLEM, it is a different plan: the checkout
      // takes it instead of starting one. Said wherever the branch is shown.
      if (branchOk && this.#takesExisting()) {
        const where = this.#names.same ? branchProblemEl : branchProblemEl
        where.textContent = `‘${branch}’ already exists — this worktree will work on it.`
        where.setAttribute('data-tone', 'note')
      }

      const ok = (folderVerdict === null || folderVerdict.ok) && branchOk
      go.disabled = !ok || this.#busy
      return ok
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' && check()) {
        this.#working(go, 'Creating…', [cancel])
        void this.#createNamed()
      }
      if (event.key === 'Escape') {
        this.#disarm()
        this.#paint()
      }
    }
    stem.addEventListener('input', () => {
      this.#names.stem = stem.value
      check()
    })
    stem.addEventListener('keydown', onKey)
    branchInput.addEventListener('input', () => {
      this.#names.branch = branchInput.value
      check()
    })
    branchInput.addEventListener('keydown', onKey)

    const draw = (): void => {
      ask.replaceChildren()
      ask.append(folderLabel, prefixed, folderProblemEl)
      if (this.#names.same) {
        ask.append(branchLine, branchProblemEl, unlink)
      } else {
        ask.append(branchLabel, branchField, branchProblemEl)
      }
      ask.appendChild(acts)
      check()
    }

    draw()
    queueMicrotask(() => {
      stem.focus()
      stem.select()
    })
    return ask
  }

  /** The branch this ask would create — the stem, or what was typed instead. */
  #branchName(): string {
    return this.#names.same ? this.#names.stem.trim() : this.#names.branch.trim()
  }

  /**
   * The pressed button says it is working, in place.
   *
   * IN PLACE, BECAUSE THE PANEL DELIBERATELY DOES NOT REPAINT. `#paint` refuses
   * while a verb is in flight — repainting destroys the elements an open
   * question is anchored to, which is what used to make the carry menu blink
   * shut mid-answer. So the switch's "Setting it up…" line never reached the
   * screen during the one press that takes seconds: `git worktree add` on a
   * real repository is not instant, and the button sat there looking untouched
   * (user, 2026-09-17).
   *
   * Nothing is restored afterwards: every path out of a verb repaints the panel
   * from the state that verb produced.
   */
  #working(pressed: HTMLButtonElement, label: string, others: readonly HTMLButtonElement[]): void {
    pressed.textContent = label
    pressed.setAttribute('data-working', 'true')
    pressed.disabled = true
    for (const other of others) other.disabled = true
  }

  /**
   * Whether the branch in the field is one this project already has.
   *
   * The difference it makes is not cosmetic: a checkout that TAKES a branch is
   * a different request from one that creates a branch, and asking git to
   * create a ref that exists is a refusal rather than a no-op.
   */
  #takesExisting(): boolean {
    const wanted = this.#branchName()
    if (wanted === '') return false
    return this.#branches.some((branch) => branch.trim() === wanted)
  }

  /** Cut the copy with the names that were just typed (or none, if empty). */
  async #createNamed(): Promise<void> {
    const branch = this.#branchName()
    const stem = this.#names.stem.trim()
    const worktree = stem === '' ? '' : `${WORKTREE_FOLDER_PREFIX}${stem}`
    const takes = this.#takesExisting()
    await this.#create(
      branch === '' ? undefined : branch,
      worktree === '' ? undefined : worktree,
      takes,
    )
  }

  async #fixStranded(): Promise<void> {
    await this.#create()
  }

  async #remove(discard = false): Promise<void> {
    const threadId = this.#thread?.id
    if (threadId === undefined || this.#busy) return
    this.#busy = true
    this.#failure = null
    // No paint here — `#paint` refuses while a verb is in flight, and the panel
    // is redrawn once below with whatever main answered.
    try {
      const result = await this.#callbacks.remove(threadId, discard)
      // A REFUSAL THAT CAN BE ANSWERED BECOMES THE QUESTION.
      //
      // "Land the work first, or say to let it go" named a remedy no control
      // could perform — the reader was told what to say and given nothing to
      // say it with (forbidden-pattern #12). The refusal carries what it found,
      // so the panel turns it into the ask rather than into a note
      // (allowed-pattern #21). Never on a second pass: `discard` already WAS
      // the say-so, and asking again would be asking the same question twice.
      if (!result.ok && result.holds !== undefined && !discard) {
        this.#holding = result.holds
        this.#armed = 'discard'
        return
      }
      this.#disarm()
      // THE REFUSAL IS THE ANSWER. `prune` is the only thing that can say
      // whether a worktree still holds work, and it says it in a sentence.
      if (!result.ok) this.#failure = result.detail
    } catch (error) {
      console.warn('flow: could not remove this conversation’s worktree', error)
      this.#disarm()
      this.#failure = 'Flow couldn’t remove it. Everything is where it was.'
    } finally {
      this.#busy = false
      this.#paint()
    }
  }
}

