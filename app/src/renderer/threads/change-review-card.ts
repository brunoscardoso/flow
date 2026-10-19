// The Changes tab's contents — Cursor's review, in Flow (#1906).
//
// A single scrolling document: a toolbar saying what this list is and where a
// commit of it would land, then one entry per changed file — path, line counts,
// a New badge, revert, and a checkbox that IS `git add` — each of which expands
// IN PLACE into its own diff. That last part is the shape: reviewing ten files
// is one scroll, not ten trips through a modal overlay.
//
// IT IS NOT A SECOND CHANGE STORE. The file set IS the tree's git status
// (`threads:changeReview`), the checkbox IS `git:stage`/`git:unstage`, revert IS
// `git:discardFile`, and the diff IS `git:diff` — the same calls the Source
// Control panel makes, so the two surfaces can never disagree (#14).
//
// WHERE IT LIVES was argued three times and settled where it started: an editor
// tab, beside Code, Tasks and Blueprint. What was actually missing was never the
// destination — it was that nothing on screen said a thread HAD changes. That is
// the strip above the composer (`changes-strip.ts`), which opens this.
//
// PERF: it subscribes to nothing. The three hot broadcasts, the debounce and the
// fetch live once in `change-review-store.ts`, which applies both gates (this
// thread; somebody on screen) for every surface at once (#14/#17/#19). Diff
// CONTENT is fetched only when a file is expanded, never for the list (#18) —
// and the list RECONCILES rather than repaints, so an open diff survives the
// refresh that lands every time the agent saves a file.

import type * as Monaco from 'monaco-editor'

import type {
  ChangeReviewFile,
  GitPublishResult,
  ThreadBindingSuggestion,
  ThreadChangeReview,
  Unsubscribe,
} from '../../shared/ipc-contract'
import {
  canRenameReviewBranch,
  changeReviewToolbarState,
  commitBoxState,
  selectAllState,
  fileBadge,
  formatCounts,
  partitionReviewFiles,
  publishOutcomeSentence,
  publishOutcomeTone,
  statusLabel,
} from './change-review-model'
import { changeReviewStore } from './change-review-store'
import { remoteBindingQuestion } from './remote-binding-ask'
import { askRemoteBinding } from './remote-binding-dialog'
import { askBranchRename } from './branch-rename-popover'
import { mountInlineDiff, type InlineDiff } from './change-review-diff'

type MonacoNamespace = typeof Monaco

/** One file's live row: the element in the list, plus its diff when open. */
interface FileEntry {
  element: HTMLElement
  row: HTMLElement
  diff: InlineDiff | null
  /** True between the click and the diff arriving — a second click must not
   *  start a second fetch and leak the first editor. */
  loading: boolean
  /**
   * What the row currently stands for. Held on the entry, not captured in a
   * closure, because the row's click listener is attached ONCE (the row element
   * outlives every repaint) while the file, its index and its root are rewritten
   * on each one. A listener re-added per paint would stack up one handler per
   * refresh — and this card refreshes every time the agent saves a file.
   */
  file: ChangeReviewFile
  index: number
  rootId: string
}

export class ChangeReviewCard {
  readonly #host: HTMLElement
  readonly #root: HTMLElement
  readonly #loadMonaco: () => Promise<MonacoNamespace>
  #activeThreadId: string | null = null
  #review: ThreadChangeReview | null = null
  #cursor = -1
  #busy = false
  #unsubscribe: Unsubscribe | null = null
  /** Which files are expanded — survives every refresh, keyed by path. */
  readonly #expanded = new Set<string>()
  /** Live rows by file path, so a refresh updates them instead of rebuilding. */
  readonly #entries = new Map<string, FileEntry>()

  // Long-lived children, created once and reconciled: rebuilding these on every
  // refresh is what would throw away scroll position and open diffs.
  readonly #toolbar = document.createElement('div')
  readonly #scope = document.createElement('span')
  readonly #scopeCounts = document.createElement('span')
  readonly #branch = document.createElement('span')
  readonly #branchName = document.createElement('span')
  readonly #ahead = document.createElement('span')
  #actions: HTMLButtonElement[] = []
  /**
   * Push — the one control that is NOT in `#actions`, and deliberately so.
   *
   * `#actions` is the set the committed state puts away, and the committed
   * state is precisely when publishing is the only thing left to do. Sweeping
   * Push into that loop would hide it at the one moment it is the answer, so it
   * is held separately and painted from `showPush` alone.
   */
  readonly #push = mkButton('Push', 'flow-cr-primary', () => void this.#publish())
  /** The head of the checkbox column — keeps everything, or keeps nothing. */
  readonly #selectAll = document.createElement('input')
  /** The sentence a finished publish left behind — see `#setPublishNote`. */
  /** The commit row: a message, a way to have it written, and the button. */
  readonly #commitRow = document.createElement('div')
  readonly #commitInput = document.createElement('textarea')
  readonly #commitHint = document.createElement('div')
  readonly #generateButton = mkButton('Write it for me', 'flow-cr-tool', () => void this.#generateMessage())
  readonly #commitButton = mkButton('Commit', 'flow-cr-primary', () => void this.#commit())
  #generating = false
  #committing = false
  /**
   * A commit was made HERE, and nothing has been published since.
   *
   * WHY A FLAG AND NOT A GIT READ. "Are there unpushed commits?" is answerable
   * only against an upstream, and a thread's branch has none until the first
   * push — so right after committing, git says zero files changed, zero commits
   * ahead, and the card showed "Nothing changed" over work that had just been
   * made, with no way to publish it. Measuring against the base instead reports
   * every commit since that branch diverged, which on a long-lived branch is
   * hundreds of other people's files.
   *
   * This is the one fact that is certain and cheap: this card ran the commit.
   * It keeps the toolbar — and its Push — until the review has something to
   * review again.
   */
  #committedHere = false
  readonly #publishNote = document.createElement('div')
  /** True between the press and the answer: a second press must not start a
   *  second push, and the button says so where the reader is already looking. */
  #publishing = false
  readonly #list = document.createElement('div')
  readonly #empty = document.createElement('div')

  constructor(host: HTMLElement, loadMonaco: () => Promise<MonacoNamespace>) {
    this.#host = host
    this.#loadMonaco = loadMonaco
    this.#root = document.createElement('div')
    this.#root.className = 'flow-change-review'
    this.#host.appendChild(this.#root)
  }

  mount(): void {
    injectChangeReviewStyles()
    this.#buildChrome()
    this.#unsubscribe = changeReviewStore.subscribe({
      onScreen: () => this.#onScreen(),
      render: (snapshot) => {
        if (snapshot.threadId !== this.#activeThreadId) {
          // A different conversation is a different review: nothing about the
          // old one's open diffs — or about what its branch published — means
          // anything here.
          this.#cursor = -1
          this.#expanded.clear()
          this.#setPublishNote(null, 'ok')
          // Nor does what THIS card committed a moment ago: another
          // conversation's empty review is empty for its own reasons.
          this.#committedHere = false
          this.#commitInput.value = ''
        }
        this.#activeThreadId = snapshot.threadId
        this.#review = snapshot.review
        this.#render()
      },
    })
  }

  dispose(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = null
    for (const entry of this.#entries.values()) entry.diff?.dispose()
    this.#entries.clear()
    this.#root.remove()
  }

  /** On screen? An unopened tab draws nothing and funds no refetch; it re-reads
   *  on the way back in (the store asks git when a subscriber reappears). */
  #onScreen(): boolean {
    return this.#root.isConnected && this.#root.getClientRects().length > 0
  }

  #refresh(): void {
    void changeReviewStore.refresh()
  }

  // ── Chrome ───────────────────────────────────────────────────────────────

  /**
   * The toolbar, the list and the foot — built once.
   *
   * Cursor's second row is `⧉ Uncommitted +1460 −5 ⌄ main ⌄ … [Create Branch &
   * Commit]`, and every part of it earns its place: what the list is, how big it
   * is, where it would land, and the one action you take when you are done
   * reading. Flow's commit box lives in Source Control, so the button REVEALS
   * that rather than growing a second commit form here — one commit path, not
   * two that can disagree about what is staged.
   */
  #buildChrome(): void {
    this.#toolbar.className = 'flow-cr-toolbar'
    this.#scope.className = 'flow-cr-scope'
    this.#scopeCounts.className = 'flow-cr-scope-counts'
    // The branch is a NAME, so it wears the glyph that says what kind of name it
    // is, and truncates on its own — no control beside it may be sized by a
    // repository's naming habits.
    this.#branch.className = 'flow-cr-branch'
    // THE NAME IS CHANGED WHERE THE NAME MATTERS. It used to open from the chip
    // beside the conversation's title, which is what the work is ABOUT rather
    // than where it lands — "dont make sense have the rename here" (user,
    // 2026-09-14). Here it is one press from the counts it will carry and the
    // Push that sends it somewhere other people can see.
    this.#branch.addEventListener('click', () => {
      const review = this.#review
      if (!canRenameReviewBranch(review) || this.#activeThreadId === null) return
      void askBranchRename(
        this.#branch,
        this.#branch,
        { id: this.#activeThreadId, worktreeBranch: review?.branch ?? null },
        {
          onRenamed: (result) => {
            // MAIN'S OWN SENTENCE, carrying the half of the warning that could
            // not be given in advance: whether the old name had already been
            // shared, which only git knows. The popover is gone by now, so this
            // is the one place it can be read.
            document.dispatchEvent(
              new CustomEvent('flow:notify', {
                detail: {
                  kind: 'state-change',
                  rootId: review?.rootId ?? '',
                  title: 'Renamed',
                  body: result.detail,
                  timestamp: new Date().toISOString(),
                  level: 'info',
                },
              }),
            )
            this.#refresh()
          },
        },
      )
    })
    const branchIcon = document.createElement('fl-icon')
    branchIcon.setAttribute('name', 'git-branch')
    branchIcon.setAttribute('size', '11')
    this.#branchName.className = 'flow-cr-branch-name'
    this.#branch.append(branchIcon, this.#branchName)

    const spacer = document.createElement('span')
    spacer.className = 'flow-cr-spacer'

    const keepAll = mkButton('Keep all', 'flow-cr-tool', () => {
      const rootId = this.#review?.rootId ?? ''
      void this.#keep(rootId, partitionReviewFiles(this.#review).changed.map((f) => f.filePath))
    })
    keepAll.title = 'Stage every changed file'

    const rejectAll = mkButton('Reject all', 'flow-cr-tool flow-cr-danger', () => {
      const rootId = this.#review?.rootId ?? ''
      void this.#reject(rootId, partitionReviewFiles(this.#review).changed.map((f) => f.filePath), null)
    })
    rejectAll.title = 'Discard every changed file back to its last commit'

    // Held so the committed state can put them away: there is nothing left to
    // keep or reject once the work is in a commit.
    //
    // COMMIT IS NOT AMONG THEM ANY MORE. It lived here when committing meant
    // leaving for Source Control; now the message is typed in the row below and
    // the button that sends it sits with the words it sends — two Commits, one
    // of which only moved the caret, was one too many (user, 2026-09-14).
    this.#actions = [keepAll, rejectAll]
    this.#ahead.className = 'flow-cr-ahead'
    this.#ahead.hidden = true
    // Beside the count it acts on: `↑2 [Push]` is the whole sentence, and the
    // button is ABSENT rather than disabled when there is nothing to publish —
    // the same rule as the toolbar itself, which disappears when there is
    // nothing to review rather than greying out three controls.
    this.#push.hidden = true
    // THE HEAD OF THE COLUMN IT CONTROLS. It is the last thing in the toolbar
    // and the rows' checkbox is the last thing in a row, and both sit 10px from
    // the same edge — so it reads as the top of that column rather than as a
    // fourth button. `Reject all` beside it discards work; this only decides
    // what rides in the next commit, and the two must never look alike.
    this.#selectAll.type = 'checkbox'
    this.#selectAll.className = 'flow-cr-check flow-cr-check-all'
    this.#selectAll.hidden = true
    this.#selectAll.addEventListener('change', () => {
      // Read the plan from the review as it is NOW, never from the box's new
      // tick: the browser flips that before this runs, and a mixed column's
      // press means "keep the rest", which no boolean can say.
      const review = this.#review
      const plan = selectAllState(partitionReviewFiles(review).changed, review?.state === 'committed')
      if (plan.filePaths.length === 0) {
        this.#render()
        return
      }
      const rootId = review?.rootId ?? ''
      void (plan.action === 'keep'
        ? this.#keep(rootId, plan.filePaths)
        : this.#unkeep(rootId, plan.filePaths))
    })
    this.#commitRow.className = 'flow-cr-commit'
    this.#commitRow.hidden = true
    this.#commitInput.className = 'flow-cr-commit-input'
    this.#commitInput.rows = 1
    this.#commitInput.placeholder = 'What changed?'
    this.#commitInput.setAttribute('aria-label', 'Commit message')
    this.#commitInput.addEventListener('input', () => this.#paintCommitBox())
    // ⌘/Ctrl+Enter commits, the shortcut every message box in this app answers
    // to. Enter alone inserts a newline: a commit body is a normal thing to
    // write and losing it to a stray keypress is not.
    this.#commitInput.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        void this.#commit()
      }
    })
    this.#commitHint.className = 'flow-cr-commit-hint'
    const commitControls = document.createElement('div')
    commitControls.className = 'flow-cr-commit-controls'
    commitControls.append(this.#commitHint, this.#generateButton, this.#commitButton)
    this.#commitRow.append(this.#commitInput, commitControls)
    this.#publishNote.className = 'flow-cr-publish-note'
    this.#publishNote.hidden = true
    this.#toolbar.append(
      this.#scope,
      this.#scopeCounts,
      this.#branch,
      this.#ahead,
      this.#push,
      spacer,
      keepAll,
      rejectAll,
      this.#selectAll,
    )

    this.#list.className = 'flow-cr-list'
    this.#empty.className = 'flow-cr-empty'

    this.#root.append(this.#toolbar, this.#commitRow, this.#publishNote, this.#list)
  }

  // ── Render ───────────────────────────────────────────────────────────────

  #render(): void {
    const { changed, touched } = partitionReviewFiles(this.#review)
    const toolbar = changeReviewToolbarState(this.#review)

    this.#scope.textContent = toolbar.scope
    this.#scope.title = toolbar.scopeTitle
    this.#scopeCounts.textContent = [toolbar.added, toolbar.deleted].filter((p) => p !== '').join(' ')
    this.#branchName.textContent = toolbar.branch ?? ''
    const renameable = canRenameReviewBranch(this.#review)
    this.#branch.title =
      toolbar.branch === null
        ? ''
        : renameable
          ? `A commit of these files would land on ${toolbar.branch} — press to rename it`
          : `A commit of these files would land on ${toolbar.branch}`
    // Pressable only when it may actually be renamed: a chip that opens a box
    // whose every answer is refused is worse than one that does nothing.
    this.#branch.classList.toggle('flow-cr-branch--rename', renameable)
    this.#branch.hidden = toolbar.branch === null
    // `↑2` — how much is waiting to be pushed. Only the committed state has it.
    this.#ahead.textContent = toolbar.aheadCommits > 0 ? `↑${toolbar.aheadCommits}` : ''
    this.#ahead.hidden = toolbar.aheadCommits === 0
    this.#ahead.title =
      toolbar.aheadCommits === 1
        ? '1 commit is not on the remote yet'
        : `${toolbar.aheadCommits} commits are not on the remote yet`
    // COMMITTED WORK IS A RECORD, NOT A DECISION. Keep all, Reject all and
    // Commit would each either lie or do something nobody asked for, so they
    // are not offered — the rows keep their diffs, which is the whole point of
    // being able to look at this at all.
    for (const button of this.#actions) button.hidden = toolbar.readOnly
    // …AND PUSH SURVIVES THAT LOOP. It is not in `#actions` (see the field) for
    // one reason: `readOnly` is the committed state, and the committed state is
    // exactly when publishing makes sense. The other three would lie there;
    // this one is the point of being there at all.
    this.#paintPush(toolbar.showPush)
    // The head of the checkbox column, in the same three states the rows put it
    // in. `indeterminate` is a property and not an attribute — it cannot be set
    // in markup and does not survive a re-render on its own.
    const selectAll = selectAllState(changed, toolbar.readOnly)
    this.#selectAll.hidden = selectAll.hidden
    this.#selectAll.checked = selectAll.checked
    this.#selectAll.indeterminate = selectAll.indeterminate
    this.#selectAll.title = selectAll.title
    this.#selectAll.setAttribute('aria-label', selectAll.title)
    this.#paintCommitBox()
    this.#root.classList.toggle('flow-cr-readonly', toolbar.readOnly)
    // NOTHING TO REVIEW, NOTHING TO REVIEW WITH. A Keep all with nothing to
    // keep, a Reject all with nothing to reject and a Commit over an empty
    // list is chrome arguing with the one sentence underneath it — "if nothing
    // was changed, why we are showing all that information" (user,
    // 2026-09-10). Files the agent merely opened are not something to review:
    // there is no diff behind them and none of the three buttons would do
    // anything, so they do not bring the toolbar back either.
    // …UNLESS SOMETHING WAS JUST COMMITTED HERE. Then the list is empty for the
    // best possible reason and the one action left is publishing it, so the
    // toolbar stays for the single control that still does anything.
    this.#toolbar.hidden = changed.length === 0 && !this.#committedHere
    // A new thing to review means the commit is no longer the latest news.
    if (changed.length > 0) this.#committedHere = false

    this.#reconcileFiles(changed)

    // The empty state is a PLACE the user asked to open, so it says so in words.
    // (The strip in the footer is the surface that HIDES when there is nothing —
    // see `changesStripState`. The two rules are opposite on purpose.)
    //
    // It is keyed on the CHANGED files alone, not on the review being empty. A
    // thread that opened fourteen files and altered none of them has a foot
    // line and nothing else: found live as a tab with a toolbar, a blank body
    // and a count at the bottom, which reads as a surface that failed to load
    // rather than as an answer.
    if (changed.length === 0) {
      this.#empty.textContent = this.#emptyText(touched.length)
      if (!this.#empty.isConnected) this.#list.appendChild(this.#empty)
    } else {
      this.#empty.remove()
    }
  }

  /**
   * The words for a review with no changed file in it.
   *
   * The touched-but-unchanged files used to have a collapsible foot line of
   * their own. It sat directly above the terminal's tab strip and read as part
   * of it — "hard to see what is terminal and what is this bottom" — so it is
   * gone (user, 2026-09-10). The one thing it was actually good for survives as
   * a clause in this sentence: a conversation that opened fourteen files and
   * altered none of them has done something, and "hasn't changed any files"
   * alone would read as if it had done nothing at all.
   */
  #emptyText(touchedCount: number): string {
    if (this.#activeThreadId === null) return 'Open a conversation to see what it changed.'
    // AFTER A COMMIT THE LIST IS EMPTY FOR THE BEST REASON THERE IS, and saying
    // "nothing changed" over work made a moment ago reads as if the commit had
    // not happened. Say what did happen, and what is left to do.
    if (this.#committedHere) {
      return 'Committed. It is saved on this conversation’s branch and not published yet.'
    }
    if (touchedCount > 0) {
      const fileWord = touchedCount === 1 ? 'file' : 'files'
      return `Nothing changed — ${touchedCount} ${fileWord} were opened and left exactly as they were.`
    }
    return this.#review?.ownWorktree === false
      ? 'Nothing in this project is uncommitted.'
      : 'This conversation hasn’t changed any files yet.'
  }

  /**
   * Update the list IN PLACE — reuse a file's row, add what is new, drop what is
   * gone (disposing its diff).
   *
   * A `replaceChildren` here would be simpler and wrong: this card refreshes
   * every time the agent saves a file, and a rebuild would close every open diff
   * and jump the scroll to the top mid-read. The keyed reconcile is what makes
   * the review usable while a turn is still running.
   */
  #reconcileFiles(files: ChangeReviewFile[]): void {
    const wanted = new Set(files.map((file) => file.filePath))
    for (const [path, entry] of this.#entries) {
      if (wanted.has(path)) continue
      entry.diff?.dispose()
      entry.element.remove()
      this.#entries.delete(path)
      this.#expanded.delete(path)
    }

    const rootId = this.#review?.rootId ?? ''
    files.forEach((file, index) => {
      let entry = this.#entries.get(file.filePath)
      if (entry === undefined) {
        const element = document.createElement('div')
        element.className = 'flow-cr-file'
        const row = document.createElement('div')
        row.className = 'flow-cr-row'
        element.appendChild(row)
        const created: FileEntry = { element, row, diff: null, loading: false, file, index, rootId }
        // THE WHOLE ROW OPENS THE DIFF, not just the filename — clicking the
        // status letter, the counts or the space between them did nothing,
        // which is a dead zone across most of a row that is entirely one
        // subject. The three controls at the right end are the exception: they
        // do their own thing and must not also expand the file underneath them.
        row.addEventListener('click', (event) => {
          const target = event.target
          if (target instanceof Element && target.closest('.flow-cr-icon, .flow-cr-check') !== null) {
            return
          }
          this.#cursor = created.index
          void this.#toggleDiff(created.file, created.rootId)
        })
        entry = created
        this.#entries.set(file.filePath, entry)
      }
      entry.file = file
      entry.index = index
      entry.rootId = rootId
      this.#paintRow(entry, file, index, rootId)
      // Keep DOM order equal to git's order without moving nodes that are
      // already right — moving a node that hosts a Monaco editor forces a
      // relayout and can lose focus mid-read.
      const at = this.#list.children[index]
      if (at !== entry.element) this.#list.insertBefore(entry.element, at ?? null)
    })
  }

  /**
   * One file's header row — the reference's own columns, in its order.
   *
   * `[status] path/name.ts  +50 −3            New  ↺  ⤢  ☑`
   *
   * The checkbox is the file's STAGED state and toggling it really stages or
   * unstages: "keep" was a verb on a button before, which said what Flow calls
   * the action but not what git had already recorded. A checkbox shows the
   * state, which is the thing you want to see across ten rows at a glance.
   */
  #paintRow(entry: FileEntry, file: ChangeReviewFile, index: number, rootId: string): void {
    const open = this.#expanded.has(file.filePath)
    const row = entry.row
    row.className =
      'flow-cr-row' +
      (index === this.#cursor ? ' flow-cr-row--current' : '') +
      (open ? ' flow-cr-row--open' : '')

    // THE DISCLOSURE CHEVRON. A row that expands has to look like one before it
    // is clicked, and nothing here did — the reference puts a chevron at the
    // head of the row, and that is the whole affordance. It is quiet until the
    // pointer arrives, and stays lit once the diff is open, so the list still
    // reads as a list of files rather than a tree.
    const chevron = document.createElement('span')
    chevron.className = 'flow-cr-chevron'
    chevron.textContent = '›'
    chevron.setAttribute('aria-hidden', 'true')

    const glyph = document.createElement('span')
    glyph.className = `flow-cr-glyph flow-cr-glyph--${file.status}`
    glyph.textContent = statusGlyph(file)
    glyph.title = statusLabel(file)

    // The FULL path, with the folder dimmed — the reference shows whole paths,
    // and in a repo with `error-context.md` under six different test folders the
    // basename alone identifies nothing.
    const name = document.createElement('button')
    name.type = 'button'
    name.className = 'flow-cr-name'
    const slash = file.filePath.lastIndexOf('/')
    if (slash >= 0) {
      const dir = document.createElement('span')
      dir.className = 'flow-cr-dir'
      dir.textContent = file.filePath.slice(0, slash + 1)
      name.appendChild(dir)
    }
    const base = document.createElement('span')
    base.className = 'flow-cr-base'
    base.textContent = slash < 0 ? file.filePath : file.filePath.slice(slash + 1)
    name.appendChild(base)
    name.title = file.filePath
    // The row's expanded state is what a screen reader is told, since the
    // chevron itself is decorative.
    name.setAttribute('aria-expanded', open ? 'true' : 'false')
    // No listener of its own: the click bubbles to the row's, which is also
    // what makes Enter and Space on the focused name work without a second
    // code path. It stays a <button> for exactly that reason.

    const counts = document.createElement('span')
    counts.className = 'flow-cr-counts'
    counts.textContent = file.binary ? 'binary' : formatCounts(file.added, file.deleted)

    const spacer = document.createElement('span')
    spacer.className = 'flow-cr-spacer'

    const badge = document.createElement('span')
    badge.className = 'flow-cr-badge'
    badge.textContent = fileBadge(file)

    const readOnly = this.#review?.state === 'committed'
    const revert = mkButton('↺', 'flow-cr-icon flow-cr-danger', () =>
      void this.#reject(rootId, [file.filePath], file.filePath),
    )
    revert.hidden = readOnly
    revert.title = `Discard the changes to ${file.filePath}`
    revert.setAttribute('aria-label', `Discard the changes to ${file.filePath}`)

    const expand = mkButton('⤢', 'flow-cr-icon', () => requestDiff(rootId, file.filePath, this.#activeThreadId))
    expand.title = 'Open this diff in the editor'
    expand.setAttribute('aria-label', 'Open this diff in the editor')

    const check = document.createElement('input')
    check.type = 'checkbox'
    check.className = 'flow-cr-check'
    check.checked = file.staged
    check.title = file.staged ? 'Kept — staged for the next commit' : 'Keep this file (stage it)'
    check.setAttribute('aria-label', `Keep ${file.filePath}`)
    check.hidden = readOnly
    check.addEventListener('change', () => {
      if (check.checked) void this.#keep(rootId, [file.filePath])
      else void this.#unkeep(rootId, [file.filePath])
    })

    row.replaceChildren(chevron, glyph, name, counts, spacer, badge, revert, expand, check)
  }

  // ── The inline diff ──────────────────────────────────────────────────────

  /**
   * Say the row is open in ONE place — the class the chevron rotates off, and
   * the `aria-expanded` a screen reader reads.
   *
   * Toggling used to set only the class and leave the attribute to the next
   * repaint, which arrives on the next store refresh — so between a click and
   * whenever the agent next saved a file, the two disagreed. It read as a test
   * flake and was a real one: the row said "collapsed" to anything that asked
   * it while showing an open diff.
   */
  #setRowOpen(entry: FileEntry, open: boolean): void {
    entry.row.classList.toggle('flow-cr-row--open', open)
    entry.row
      .querySelector('.flow-cr-name')
      ?.setAttribute('aria-expanded', open ? 'true' : 'false')
  }

  async #toggleDiff(file: ChangeReviewFile, rootId: string): Promise<void> {
    const entry = this.#entries.get(file.filePath)
    if (entry === undefined || entry.loading) return
    if (entry.diff !== null) {
      entry.diff.dispose()
      entry.diff = null
      this.#expanded.delete(file.filePath)
      this.#setRowOpen(entry, false)
      return
    }
    entry.loading = true
    this.#expanded.add(file.filePath)
    this.#setRowOpen(entry, true)
    try {
      // A committed file has NO working-tree diff — its change is already in a
      // commit. Reading it means comparing against the upstream, which is what
      // makes the read-only state worth opening at all.
      const diff = await window.flow.git.diff(
        this.#review?.state === 'committed'
          ? { rootId, filePath: file.filePath, against: 'upstream' }
          : { rootId, filePath: file.filePath },
      )
      // Collapsed again, or the file vanished, while git was answering.
      if (!this.#expanded.has(file.filePath) || !this.#entries.has(file.filePath)) return
      const inline = await mountInlineDiff(this.#loadMonaco, diff, file.filePath)
      if (!this.#expanded.has(file.filePath) || !this.#entries.has(file.filePath)) {
        inline.dispose()
        return
      }
      entry.element.appendChild(inline.element)
      entry.diff = inline
    } catch (error) {
      console.error('flow: inline diff failed', { rootId, filePath: file.filePath, error })
      this.#expanded.delete(file.filePath)
      this.#setRowOpen(entry, false)
      const failed = document.createElement('div')
      failed.className = 'flow-cr-diff-failed'
      failed.textContent = 'This file’s diff could not be read.'
      entry.element.appendChild(failed)
      setTimeout(() => failed.remove(), 4000)
    } finally {
      entry.loading = false
    }
  }

  // ── The three git actions ────────────────────────────────────────────────

  async #keep(rootId: string, filePaths: string[]): Promise<void> {
    if (this.#busy || filePaths.length === 0) return
    this.#busy = true
    try {
      await window.flow.git.stage({ rootId, filePaths })
    } catch (error) {
      console.error('flow: change review keep failed', { rootId, error })
    } finally {
      this.#busy = false
      this.#refresh()
    }
  }

  /** Draw the commit row for what is kept and what is typed. */
  #paintCommitBox(): void {
    const { changed } = partitionReviewFiles(this.#review)
    const state = commitBoxState({
      files: changed,
      readOnly: this.#review?.state === 'committed',
      message: this.#commitInput.value,
      generating: this.#generating,
      committing: this.#committing,
    })
    this.#commitRow.hidden = state.hidden
    this.#commitButton.disabled = !state.canCommit
    this.#commitButton.textContent = state.commitLabel
    this.#generateButton.disabled = !state.canGenerate
    this.#generateButton.textContent = state.generateLabel
    this.#commitHint.textContent = state.hint ?? ''
    this.#commitHint.hidden = state.hint === null
  }

  /**
   * Have the message written from the kept files.
   *
   * IT FILLS THE BOX, IT DOES NOT COMMIT. A message a person has not read is
   * not a message they wrote, and the commit is the irreversible half — so the
   * generated text lands in the field where it can be edited or thrown away,
   * and the press that commits is still theirs.
   */
  async #generateMessage(): Promise<void> {
    const review = this.#review
    if (review === null || this.#generating) return
    const kept = partitionReviewFiles(review).changed.filter((file) => file.staged)
    if (kept.length === 0) return
    this.#generating = true
    this.#paintCommitBox()
    try {
      const result = await window.flow.review.generateCommitMessage({
        rootPath: review.rootId,
        filePaths: kept.map((file) => file.filePath),
      })
      // A null message is "nothing was written", not an error and not an empty
      // box: leave whatever the person already had.
      if (result.message !== null && result.message.trim() !== '') {
        this.#commitInput.value = result.message
      }
    } catch (error) {
      console.error('flow: could not write a commit message', error)
    } finally {
      this.#generating = false
      this.#paintCommitBox()
      this.#commitInput.focus()
    }
  }

  /**
   * Commit what is kept — `git:commitIndex`, the index and nothing else.
   *
   * NO PATHSPEC, DELIBERATELY. The checkboxes ARE the index, so committing it
   * is committing exactly what the reader ticked; passing paths here would be a
   * second opinion about the same question, and the two could differ.
   */
  async #commit(): Promise<void> {
    const review = this.#review
    if (review === null || this.#committing) return
    const message = this.#commitInput.value.trim()
    const kept = partitionReviewFiles(review).changed.filter((file) => file.staged)
    if (message === '' || kept.length === 0) return
    this.#committing = true
    this.#paintCommitBox()
    try {
      await window.flow.git.commitIndex({ rootId: review.rootId, message })
      // The box empties only on success: a refused commit keeps the words the
      // person wrote, where they can fix what it complained about.
      this.#commitInput.value = ''
      this.#committedHere = true
    } catch (error) {
      console.error('flow: commit failed', error)
      this.#publishNote.textContent =
        error instanceof Error ? error.message : 'Flow could not make that commit.'
      this.#publishNote.hidden = false
    } finally {
      this.#committing = false
      this.#refresh()
    }
  }

  /** Unchecking a kept file — `git restore --staged`. Not destructive: the work
   *  stays in the tree, it simply leaves the next commit. */
  async #unkeep(rootId: string, filePaths: string[]): Promise<void> {
    if (this.#busy || filePaths.length === 0) return
    this.#busy = true
    try {
      await window.flow.git.unstage({ rootId, filePaths })
    } catch (error) {
      console.error('flow: change review unkeep failed', { rootId, error })
    } finally {
      this.#busy = false
      this.#refresh()
    }
  }

  // ── Publishing ───────────────────────────────────────────────────────────

  /**
   * The button's three appearances, in one place: absent, ready, or in flight.
   *
   * In flight it becomes its OWN status — same button, same spot, new label —
   * rather than a spinner beside it or a toast over it. The state belongs where
   * the reader was already looking, and a disabled button cannot be pressed a
   * second time, which is the whole guard against a second push.
   */
  #paintPush(show: boolean): void {
    this.#push.hidden = !show
    this.#push.disabled = this.#publishing
    this.#push.textContent = this.#publishing ? 'Publishing…' : 'Push'
    this.#push.title = this.#publishing
      ? 'Publishing this branch'
      : 'Publish this branch'
  }

  /**
   * What came back, in one sentence — or nothing at all.
   *
   * It SURVIVES the toolbar. A successful publish is usually the moment the
   * toolbar has nothing left to show (clean tree, nothing ahead), so a note
   * that hid with it would erase the only confirmation the press ever gets.
   * It clears when the conversation changes or the next push starts.
   */
  #setPublishNote(sentence: string | null, tone: 'ok' | 'refused'): void {
    const text = sentence ?? ''
    this.#publishNote.textContent = text
    this.#publishNote.hidden = text === ''
    this.#publishNote.classList.toggle('flow-cr-publish-note--refused', tone === 'refused')
  }

  /**
   * Publish this checkout's branch and stop — one press, one outcome.
   *
   * No pull, no rebase, no force and no pull request: the landing flow still
   * owns proposing the work, and a remote that has moved on is refused in words
   * by main rather than pushed over from here.
   */
  async #publish(): Promise<void> {
    if (this.#publishing) return
    const rootId = this.#review?.rootId ?? ''
    if (rootId === '') return
    this.#publishing = true
    this.#setPublishNote(null, 'ok')
    this.#paintPush(true)
    try {
      const first = await window.flow.git.publish({ rootId })
      // NOBODY HAS SAID WHERE THIS BRANCH GOES — so the app asks, rather than
      // picking. The refusal carried everything the question needs with it
      // (allowed-pattern #21), which is why the ask costs no second round trip:
      // the suggestion, its provenance and this checkout's remotes are all
      // already here.
      const result =
        first.status === 'unbound' ? await this.#askThenPublish(rootId, first.suggestion) : first
      // A DISMISSAL SENDS NOTHING AND SAYS NOTHING. Escape, the backdrop and
      // Cancel all mean "not now"; nothing was published when the dialog opened,
      // so there is no outcome to report and nothing to undo (forbidden #15).
      if (result === null) return
      this.#setPublishNote(publishOutcomeSentence(result), publishOutcomeTone(result))
    } catch (error) {
      console.error('flow: change review publish failed', { rootId, error })
      this.#setPublishNote('This branch could not be published.', 'refused')
    } finally {
      this.#publishing = false
      // Repaint from the model, not from the button's own last state — the
      // refresh below may well take the control away (nothing left to publish),
      // and #render is what decides that.
      this.#paintPush(changeReviewToolbarState(this.#review).showPush)
      this.#refresh()
    }
  }

  /**
   * Ask where this branch publishes, then publish there — or answer nothing.
   *
   * THE ANSWER RIDES THE SAME PRESS. It goes back through `git:publish` as a
   * `binding` on the second call rather than through a separate write-then-push
   * pair, so the decision and the act it was made for cannot come apart: there
   * is no window in which a destination has been recorded and no push followed.
   *
   * `confirmed: true` is stated HERE and nowhere below (forbidden-pattern #15).
   * This line is the only place in the renderer that can honestly say a person
   * asked for it, because it is the only place that watched them answer.
   */
  async #askThenPublish(
    rootId: string,
    suggestion: ThreadBindingSuggestion,
  ): Promise<GitPublishResult | null> {
    const answer = await askRemoteBinding(remoteBindingQuestion(suggestion))
    if (answer === null) return null
    return await window.flow.git.publish({
      rootId,
      binding: {
        remote: answer.remote,
        remoteBranch: answer.remoteBranch,
        confirmed: true,
      },
    })
  }

  /**
   * Reject = discard the working-tree change(s) back to HEAD, through the SAME
   * `git:discardFile` the Source Control panel uses (allowed-pattern #14). This
   * is destructive, so it asks first, naming what it discards (#1144). No new
   * discard path with a working default (forbidden #15).
   */
  async #reject(rootId: string, filePaths: string[], singleName: string | null): Promise<void> {
    if (this.#busy || filePaths.length === 0) return
    const subject =
      singleName !== null
        ? `“${singleName}”`
        : filePaths.length === 1
          ? `“${filePaths[0]}”`
          : `${filePaths.length} files`
    const ok = window.confirm(`Discard changes to ${subject}? This cannot be undone.`)
    if (!ok) return
    this.#busy = true
    try {
      for (const filePath of filePaths) {
        await window.flow.git.discardFile({ rootId, filePath })
      }
    } catch (error) {
      console.error('flow: change review reject failed', { rootId, error })
    } finally {
      this.#busy = false
      this.#refresh()
    }
  }

}

/**
 * Open a file's diff in the SHARED editor-area DiffView — the row's ⤢ button.
 *
 * `threadId` rides along because it is what makes that diff STALE. The git
 * domain used to judge every diff by the Source Control panel's root scope, and
 * a conversation's checkout is usually not in it — so the diff was fetched and
 * silently discarded, which is the dead click reported as "the files are not
 * opening anymore". The owner is the conversation.
 */
function requestDiff(rootPath: string, filePath: string, threadId: string | null): void {
  document.dispatchEvent(
    new CustomEvent('flow:open-change-review-diff', { detail: { rootPath, filePath, threadId } }),
  )
}

function statusGlyph(file: ChangeReviewFile): string {
  switch (file.status) {
    case 'added':
    case 'untracked':
      return 'A'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'conflicted':
      return '!'
    default:
      return 'M'
  }
}

function mkButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.textContent = label
  button.addEventListener('click', onClick)
  return button
}

let stylesInjected = false
function injectChangeReviewStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
/* THE APP'S OWN TOKENS, not a private palette.
   This block used to name \`--flow-panel\`, \`--flow-text\`, \`--flow-border\`
   and friends — none of which exist anywhere in Flow. Every one of them fell
   through to its hardcoded dark hex, which is why the rows sat on a ground
   darker than any other surface in the window ("hard to differentiate the
   background") and why the whole tab would have rendered dark-on-dark under the
   light theme. Every colour below is a token that is actually defined, and the
   light theme comes free with them. */

/* A TAB-SIZED SCROLLING DOCUMENT. The toolbar stays put; the file list is what
   scrolls, and a file's diff scrolls WITH its row rather than in a box of its
   own — which is what makes ten files one read. */
.flow-change-review {
  display:flex; flex-direction:column; height:100%; min-height:0;
  background:var(--fl-color-bg); color:var(--fl-color-text);
  font-size:var(--fl-text-caption-size, 12px);
}

.flow-cr-toolbar { flex:none; display:flex; align-items:center; gap:var(--fl-space-sm, 8px);
  padding:6px 10px; background:var(--fl-color-surface); border-bottom:var(--fl-border-width) solid var(--fl-color-separator); }
.flow-cr-scope { flex:none; font-weight:600; color:var(--fl-color-text); }
.flow-cr-scope-counts { color:var(--fl-color-text-secondary); font-variant-numeric:tabular-nums; }
.flow-cr-scope-counts:empty { display:none; }
.flow-cr-branch { display:inline-flex; align-items:center; gap:4px; min-width:0; max-width:22ch;
  padding:1px 8px; border-radius:999px; border:var(--fl-border-width) solid var(--fl-color-border);
  color:var(--fl-color-text-secondary); }
.flow-cr-branch-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.flow-cr-ahead { flex:none; color:var(--fl-color-text-secondary); font-variant-numeric:tabular-nums; }
/* WHAT CAME BACK, under the row that asked for it — one line, no toast, no
   overlay. It outlives the toolbar on purpose: a successful publish usually
   leaves nothing to review, and a note that hid with the toolbar would erase
   the only confirmation the press ever gets. A refusal is not an error, so it
   is a warning colour and not the error red the discard path wears. */
.flow-cr-publish-note { flex:none; padding:5px 10px;
  background:var(--fl-color-surface); color:var(--fl-color-text-secondary);
  border-bottom:var(--fl-border-width) solid var(--fl-color-separator); }
.flow-cr-publish-note--refused { color:var(--fl-color-warning); }
/* Committed work is a record: the row keeps its diff and loses its handles, and
   the whole surface reads a shade quieter so the difference is legible before
   anyone reaches for a control that is not there. */
.flow-cr-readonly .flow-cr-scope { color:var(--fl-color-text-secondary); }
.flow-cr-spacer { flex:1; }
.flow-change-review button.flow-cr-tool, .flow-change-review button.flow-cr-primary {
  padding:2px 9px; border-radius:var(--fl-radius-sm, 4px);
  border:var(--fl-border-width) solid var(--fl-color-border);
  background:var(--fl-color-surface-raised); color:var(--fl-color-text);
  font:inherit; cursor:pointer; white-space:nowrap; }
.flow-change-review button.flow-cr-tool:hover, .flow-change-review button.flow-cr-primary:hover {
  background:var(--fl-color-surface-selected); }
.flow-change-review button.flow-cr-primary { background:var(--fl-color-accent); border-color:transparent; color:#fff; }
.flow-change-review button.flow-cr-danger { color:var(--fl-color-error); }
.flow-change-review button:disabled { opacity:.4; cursor:default; }

.flow-cr-list { flex:1; min-height:0; overflow:auto; display:flex; flex-direction:column; }
.flow-cr-empty { padding:14px 12px; color:var(--fl-color-text-secondary); }

/* THE ROWS SIT ON A RAISED SURFACE, the ground behind them is the tab's. That
   difference is the whole point: a list of near-black rows on a near-black
   panel has no edges, and the eye has to find each row by its text. */
/* A ROW KEEPS ITS HEIGHT AND THE LIST SCROLLS — flex:none is the whole fix.
   A flex item shrinks below its content by default, so in a short pane every
   file squashed into a few pixels and the names overlapped each other instead
   of the list scrolling (user, 2026-09-14). The scroll already existed one
   level up; nothing could ever reach it while the children were willing to
   disappear. */
.flow-cr-file { flex:none; display:flex; flex-direction:column; min-width:0; overflow:hidden;
  background:var(--fl-color-surface-raised);
  border-bottom:var(--fl-border-width) solid var(--fl-color-separator); }
.flow-cr-row { flex:none; display:flex; align-items:center; gap:var(--fl-space-sm, 8px);
  padding:4px 10px 4px 6px; min-width:0; cursor:pointer; }
.flow-cr-row:hover { background:var(--fl-color-surface-selected); }
.flow-cr-row--open { background:var(--fl-color-surface-selected); }
.flow-cr-row--current { box-shadow:inset 2px 0 0 var(--fl-color-accent); }
/* Quiet until the pointer arrives, lit and turned down once the diff is open.
   It occupies its width at all times, so a row does not jump sideways under
   the cursor. */
.flow-cr-chevron { flex:none; width:10px; text-align:center; color:var(--fl-color-text-secondary);
  opacity:0; transition:transform .12s ease, opacity .12s ease; }
.flow-cr-row:hover .flow-cr-chevron, .flow-cr-row:focus-within .flow-cr-chevron { opacity:1; }
.flow-cr-row--open .flow-cr-chevron { opacity:1; transform:rotate(90deg); }
@media (prefers-reduced-motion: reduce) { .flow-cr-chevron { transition:none; } }
/* The same status vocabulary the Source Control panel uses (gp-state-*): one
   set of meanings for a letter, whichever surface prints it. */
.flow-cr-glyph { flex:none; width:1.1em; text-align:center; font-weight:700; }
.flow-cr-glyph--modified { color:var(--fl-color-warning); }
.flow-cr-glyph--added, .flow-cr-glyph--untracked { color:var(--fl-color-success); }
.flow-cr-glyph--deleted, .flow-cr-glyph--conflicted { color:var(--fl-color-error); }
.flow-cr-glyph--renamed { color:var(--fl-color-accent); }
/* The counts sit RIGHT AFTER the path, as in the reference — so the name
   shrinks but never grows, and the spacer after the counts is what pushes the
   badge and the controls to the far edge. A growing name put a hand's width of
   nothing between a file and its own +2 −1.
   The path truncates from the LEFT (rtl on the box, ltr on the text) so a deep
   test-results/ path keeps its filename instead of losing it to an ellipsis.
   (No backticks anywhere in here: this block is a template literal, and one
   backtick in a comment breaks the build with a misleading TS error.) */
.flow-cr-name { flex:0 1 auto; min-width:0; display:block; direction:rtl; text-align:left;
  background:transparent; border:none; color:var(--fl-color-text); font:inherit; padding:0; cursor:inherit;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.flow-cr-name > span { direction:ltr; unicode-bidi:embed; }
.flow-cr-dir { color:var(--fl-color-text-secondary); }
.flow-cr-counts { flex:none; color:var(--fl-color-success); font-variant-numeric:tabular-nums; }
.flow-cr-badge { flex:none; color:var(--fl-color-text-secondary); }
.flow-cr-badge:empty { display:none; }
/* Row controls appear on hover, as the reference's revert arrow does: ten rows
   with thirty always-lit buttons reads as a form, not a list. Focus reveals
   them too, or they are unreachable without a mouse. */
.flow-change-review button.flow-cr-icon { flex:none; border:none; background:transparent;
  color:var(--fl-color-text-secondary); font-size:13px; line-height:1; padding:2px 5px;
  border-radius:var(--fl-radius-sm, 4px); cursor:pointer; opacity:0; }
.flow-cr-row:hover button.flow-cr-icon, .flow-cr-row:focus-within button.flow-cr-icon { opacity:1; }
.flow-change-review button.flow-cr-icon:hover { background:var(--fl-color-surface); color:var(--fl-color-text); }
.flow-cr-check { flex:none; margin:0; cursor:pointer; accent-color:var(--fl-color-accent); }
/* The head of the column sits on the same right edge as the boxes under it —
   the toolbar and the rows carry the same 10px — so it reads as the top of that
   column rather than as one more control in the bar. */
.flow-cr-check-all { margin-left:2px; }
/* Only the renameable chip invites a press — the rest is a label that happens
   to sit in a toolbar. */
.flow-cr-branch--rename { cursor:pointer; }
/* THE COMMIT ROW sits between the toolbar and the files, because that is the
   order of the decision: what this is, what goes in, what it is called. */
.flow-cr-commit { flex:none; display:flex; flex-direction:column; gap:6px;
  padding:8px 10px; background:var(--fl-color-surface);
  border-bottom:var(--fl-border-width) solid var(--fl-color-separator); }
.flow-cr-commit-input { width:100%; box-sizing:border-box; resize:vertical; min-height:26px;
  padding:5px 8px; border-radius:var(--fl-radius-sm, 4px);
  border:var(--fl-border-width) solid var(--fl-color-border);
  background:var(--fl-color-surface-raised); color:var(--fl-color-text);
  font:inherit; line-height:1.4; }
.flow-cr-commit-input:focus { outline:none; border-color:var(--fl-color-accent); }
.flow-cr-commit-input::placeholder { color:var(--fl-color-text-secondary); }
/* The hint takes the slack, so both buttons sit on the right edge — the side
   the toolbar's own actions are on, and the side the user asked for. */
.flow-cr-commit-controls { display:flex; align-items:center; gap:var(--fl-space-sm, 8px); }
.flow-cr-commit-hint { flex:1 1 auto; min-width:0; color:var(--fl-color-text-secondary);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.flow-cr-commit-hint:empty { display:none; }
.flow-change-review button.flow-cr-tool:disabled,
.flow-change-review button.flow-cr-primary:disabled { opacity:.5; cursor:default; }
.flow-cr-branch--rename:hover { border-color:var(--fl-color-accent); color:var(--fl-color-text); }

/* Same reason: an open diff has a measured height (change-review-diff.ts caps
   it) and must not be squeezed out of it by a short pane. */
.flow-cr-diff { flex:none; border-top:var(--fl-border-width) solid var(--fl-color-separator); }
.flow-cr-diff-failed { padding:6px 10px; color:var(--fl-color-error); }
`
  document.head.appendChild(style)
}
