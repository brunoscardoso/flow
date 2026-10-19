/**
 * THE RENAME POPOVER — the branch's name, changed where the name matters.
 *
 * It used to open from the chip beside the conversation's title, and that is
 * not where a person thinks about a branch name: the title is what the
 * conversation is ABOUT, and the branch is where its work lands. "Dont make
 * sense have the rename here" (user, 2026-09-14) — so the popover moved to the
 * Changes toolbar, one press from the +1202 −1 it is about to carry and the
 * Push that sends it somewhere other people can see.
 *
 * IT IS ONE IMPLEMENTATION, NOT TWO. Lifting it out of the chip's view module
 * is what let it move without being rewritten: the validation, the refusals and
 * the modal discipline below are the same ones the ledger's Rename had, moved
 * once more rather than reproduced (allowed-pattern #14).
 *
 * The discipline it keeps, which is `worktree-start-dialog.ts`'s: the promise
 * settles exactly once, the overlay is always removed, dismissal means nothing
 * happened, and the surface marks itself modal so the terminal cannot steal the
 * caret out of the field and a panel shortcut cannot eat the Escape that closes
 * it. What it does NOT take is the screen.
 *
 * A REFUSAL KEEPS THE BOX OPEN, WITH THE TYPED NAME IN IT. `validateBranchName`
 * refuses rather than rewrites (allowed-pattern #22), so the name shown is
 * never silently corrected into a different branch; and every other refusal —
 * a name something already answers to, a rename that moved nothing, a git that
 * said no — comes back from `threads:renameWorktreeBranch` as a sentence and
 * is shown verbatim.
 */

import { markModalOverlay } from '../modal-overlay'
import type { ThreadWorktreeRenameResult } from '../../shared/ipc-contract'
import { validateBranchName } from './branch-name'
import { previouslyPushedNote } from '../git/remote-binding-form'
import { renameQuestion } from './branch-rename-copy'

/** What the popover renames: a conversation, and the branch it works on. */
export interface BranchRenameSubject {
  id: string
  worktreeBranch: string | null
  /** A name already published stays on the remote — main knows, and says so. */
  previouslyPushedAs?: string | null
}

export interface BranchRenameCallbacks {
  /**
   * A rename landed. The sentence is main's own — it is the half of the warning
   * that can only be told afterwards, because only git knows whether the old
   * name had already been shared.
   */
  onRenamed?: (result: ThreadWorktreeRenameResult) => void
}

/**
 * Open the rename popover on `anchor` and keep it open until the branch is
 * renamed or the person walks away.
 *
 * Resolves when the popover is gone, whichever way it went. It resolves with
 * nothing because there is nothing for the caller to do with the answer: a
 * successful rename reaches every surface through the thread's own update, and
 * a dismissal — Escape, a click outside, the anchor leaving the screen — means
 * the branch is exactly where it was.
 */
export function askBranchRename(
  anchor: HTMLElement,
  host: HTMLElement,
  thread: BranchRenameSubject,
  callbacks: BranchRenameCallbacks,
): Promise<void> {
  // THE WORDS ARE THE LEDGER'S, not new ones. `renameQuestion` is the form this
  // control replaces, and it already carries the half of the warning that is
  // knowable up front: renaming the branch does not rename the conversation.
  injectBranchRenameStyles()
  const question = renameQuestion({ branch: thread.worktreeBranch })
  return new Promise<void>((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'fl-branch-rename-overlay'
    // Marked modal even though it takes none of the screen: while a text field
    // has the caret, the terminal must not take it back and ⌃` must not run.
    markModalOverlay(overlay)

    const popover = document.createElement('div')
    popover.className = 'fl-branch-rename'
    popover.setAttribute('role', 'dialog')
    popover.setAttribute('aria-label', question.title)

    const title = document.createElement('div')
    title.className = 'fl-branch-rename-title'
    title.textContent = question.title

    const body = document.createElement('p')
    body.className = 'fl-branch-rename-body'
    body.textContent = question.body

    // The remote half of the warning, and only when there is one to give.
    // `previouslyPushedNote` is the ledger's own wording — a name that has been
    // published stays published, whatever this box does next.
    const published = previouslyPushedNote(thread.previouslyPushedAs ?? null)
    const publishedNote = document.createElement('p')
    publishedNote.className = 'fl-branch-rename-body'
    publishedNote.textContent = published ?? ''
    publishedNote.hidden = published === null

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'fl-branch-rename-input'
    // PRE-FILLED WITH THE NAME IT HAS — the whole of it, including any prefix.
    // `question.initial` is the ledger's answer to this and the reason it is
    // the whole name: a box showing half a branch refuses edits to the half it
    // hid, and renames something other than what is on screen.
    input.value = question.initial
    input.placeholder = question.placeholder
    input.setAttribute('aria-label', question.title)

    const problem = document.createElement('p')
    problem.className = 'fl-branch-rename-problem'
    problem.hidden = true
    // Announced, because a refusal that only appears visually is no refusal for
    // anyone driving this from the keyboard with a screen reader.
    problem.setAttribute('role', 'alert')

    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = 'fl-branch-rename-confirm'
    confirm.textContent = question.confirmLabel

    let settled = false
    let busy = false
    let outsideTimer = 0
    const close = (): void => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKey, true)
      window.clearTimeout(outsideTimer)
      document.removeEventListener('mousedown', onOutside)
      anchorWatch.disconnect()
      overlay.remove()
      resolve()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Stopped here: a panel shortcut further down would close the whole
        // conversation panel instead, and abandoning a typed word is not a
        // reason to lose the surface it was typed on.
        event.stopPropagation()
        close()
        return
      }
      if (event.key === 'Enter' && event.target === input) {
        event.preventDefault()
        void submit()
      }
    }
    const onOutside = (event: MouseEvent): void => {
      if (!popover.contains(event.target as Node)) close()
    }
    // WATCH THE HEADER, NOT THE CHIP. The popover is body-mounted at a position
    // computed once from the chip's rect, so a header that leaves the screen —
    // the chat panel toggled away, the thread cleared out from under it — would
    // otherwise leave a live field floating over whatever took its place.
    //
    // The question is "is the surface this belongs to still there", and the
    // CHIP is the wrong thing to ask: it is an element this controller rebuilds
    // whenever what it says changes. The host outlives every such rebuild, so
    // it is the one that answers the question actually being asked (#1400's
    // lesson, learned here without having to relearn it).
    const anchorWatch = new MutationObserver(() => {
      if (!host.isConnected) close()
    })

    /** Show a refusal under the field, leaving every typed character alone. */
    const refuse = (detail: string): void => {
      problem.textContent = detail
      problem.hidden = false
      busy = false
      input.disabled = false
      confirm.disabled = false
      input.focus()
    }

    const submit = async (): Promise<void> => {
      if (busy || settled) return
      // TYPED, THEREFORE REFUSED — never rewritten (allowed-pattern #22). The
      // name that goes to git is the one in the box, trimmed of the whitespace
      // a text field collects at its ends and otherwise untouched.
      const check = validateBranchName(input.value)
      if (!check.ok) {
        refuse(check.detail)
        return
      }
      const threads = window.flow?.threads
      if (threads === undefined || typeof threads.renameWorktreeBranch !== 'function') {
        refuse('Flow couldn’t rename it. It is exactly where it was.')
        return
      }
      busy = true
      problem.hidden = true
      input.disabled = true
      confirm.disabled = true
      try {
        const result = await threads.renameWorktreeBranch({
          threadId: thread.id,
          name: check.name,
          // NO DEFAULT ON THE OTHER SIDE (forbidden-pattern #15): a branch
          // rename moves a ref, so main runs no writing git unless the call
          // says a person asked for it. A press is that.
          confirmed: true,
        })
        if (result.status === 'renamed') {
          close()
          callbacks.onRenamed?.(result)
          return
        }
        // `unchanged`, `refused` and `failed` all come back as one sentence
        // written for a person. It is shown as-is; re-wording it here would be
        // a second explanation of one refusal.
        refuse(result.detail)
      } catch (error) {
        console.error('flow: renaming a thread branch failed', error)
        refuse('Flow couldn’t rename it. It is exactly where it was.')
      }
    }

    confirm.addEventListener('click', () => void submit())

    const row = document.createElement('div')
    row.className = 'fl-branch-rename-row'
    row.append(input, confirm)
    popover.append(title, body, publishedNote, row, problem)
    overlay.appendChild(popover)
    document.body.appendChild(overlay)
    position(popover, anchor)
    anchorWatch.observe(document.body, { childList: true, subtree: true })
    // Capture phase, for the same reason the start dialog uses it: this field
    // owns the keyboard while it is open.
    document.addEventListener('keydown', onKey, true)
    // Deferred, or the click that opened the popover closes it again.
    // A DISMISS CLOSED BEFORE THIS TIMER FIRES MUST NOT LEAVE ITS LISTENER BEHIND.
    // The add is deferred so the opening click cannot close the menu; the teardown
    // only ever removed a listener, so closing inside that one tick (Escape right
    // after opening, which is what a poll of this menu does) let the timer attach
    // `onOutside` for a panel that was already gone. Nothing could remove it, and
    // its closure tests a DETACHED element — so `!contains(target)` was true for
    // every later press, and the NEXT menu was dismissed on mousedown before the
    // click reached the item. Measured: the item's handler never ran, no write
    // happened, and the menu closed anyway.
    outsideTimer = window.setTimeout(
      () => document.addEventListener('mousedown', onOutside),
      0,
    )
    input.focus()
    input.select()
  })
}

/**
 * Put the popover under its chip, inside the window.
 *
 * Left-aligned to the chip rather than right-aligned like the sidebar's row
 * menus: the chip sits at the start of a header, so its menu grows the way the
 * header reads. Flipped above only when there is genuinely no room below.
 */
function position(popover: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect()
  const margin = 8
  const width = popover.offsetWidth
  let left = rect.left
  if (left + width + margin > window.innerWidth) left = window.innerWidth - width - margin
  if (left < margin) left = margin
  let top = rect.bottom + 4
  if (top + popover.offsetHeight + margin > window.innerHeight) {
    top = Math.max(margin, rect.top - popover.offsetHeight - 4)
  }
  popover.style.left = `${String(Math.round(left))}px`
  popover.style.top = `${String(Math.round(top))}px`
}

// ── Styles ─────────────────────────────────────────────────────────────────


let renameStylesInjected = false

function injectBranchRenameStyles(): void {
  if (renameStylesInjected) return
  renameStylesInjected = true
  const style = document.createElement('style')
  style.textContent = [
    /* The popover takes no screen: the overlay only catches the click that
       dismisses it, so what is behind stays readable and stays lit. */
    '.fl-branch-rename-overlay { position: fixed; inset: 0; z-index: 1000; }',
    '.fl-branch-rename {',
    '  position: fixed;',
    '  width: min(340px, calc(100vw - var(--fl-space-xl)));',
    '  display: flex;',
    '  flex-direction: column;',
    '  gap: var(--fl-space-xs);',
    '  padding: var(--fl-space-md);',
    '  border: var(--fl-border-width) solid var(--fl-color-border);',
    '  border-radius: var(--fl-radius-md);',
    '  background: var(--fl-color-surface);',
    '  box-shadow: var(--fl-shadow-md);',
    '  font-family: var(--fl-font-ui);',
    '  color: var(--fl-color-text);',
    '}',
    '.fl-branch-rename-title {',
    '  font-size: var(--fl-text-ui-size);',
    '  font-weight: var(--fl-text-ui-weight-medium);',
    '}',
    '.fl-branch-rename-body {',
    '  margin: 0;',
    '  font-size: var(--fl-text-caption-size);',
    '  line-height: var(--fl-line-height-dense);',
    '  color: var(--fl-color-text-secondary);',
    '}',
    '.fl-branch-rename-body[hidden] { display: none; }',
    '.fl-branch-rename-row { display: flex; gap: var(--fl-space-xs); align-items: center; }',
    '.fl-branch-rename-input {',
    '  flex: 1;',
    '  min-width: 0;',
    '  padding: var(--fl-space-xs) var(--fl-space-sm);',
    '  border: var(--fl-border-width) solid var(--fl-color-border);',
    '  border-radius: var(--fl-radius-sm);',
    '  background: var(--fl-color-surface-raised);',
    '  color: var(--fl-color-text);',
    '  font-family: var(--fl-font-mono);',
    '  font-size: var(--fl-text-ui-size);',
    '}',
    '.fl-branch-rename-input:focus-visible {',
    '  outline: 2px solid var(--fl-color-focus-ring);',
    '  outline-offset: 1px;',
    '}',
    '.fl-branch-rename-confirm {',
    '  flex: none;',
    '  padding: var(--fl-space-xs) var(--fl-space-sm);',
    '  border: var(--fl-border-width) solid var(--fl-color-border);',
    '  border-radius: var(--fl-radius-sm);',
    '  background: var(--fl-color-surface-raised);',
    '  color: inherit;',
    '  font: inherit;',
    '  font-size: var(--fl-text-ui-size);',
    '  cursor: pointer;',
    '}',
    '.fl-branch-rename-confirm:hover { border-color: var(--fl-color-accent); }',
    '.fl-branch-rename-confirm:disabled { cursor: default; opacity: 0.6; }',
    /* The refusal sits under the field the reader is still looking at. */
    '.fl-branch-rename-problem {',
    '  margin: 0;',
    '  font-size: var(--fl-text-caption-size);',
    '  line-height: var(--fl-line-height-dense);',
    '  color: var(--fl-color-error);',
    '}',
  ].join('\n')
  document.head.appendChild(style)
}
