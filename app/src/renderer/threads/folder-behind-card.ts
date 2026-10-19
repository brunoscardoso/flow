/**
 * The folder-behind notice, as an element.
 *
 * DOM ONLY. Every string and every state transition is `folder-behind-model`'s;
 * this reads the live comparison, calls the action, and paints what the model
 * returns. Both of its doors are injected, so the card can be built in a test
 * with no IPC at all (app jest is CJS ts-jest — see the pure model beside this).
 *
 * ONE READ, ONE WRITE, BOTH ALREADY OWNED ELSEWHERE (allowed-pattern #14):
 * the numbers come from `git:status`, the same coalesced scan the git panel
 * reads, and the action is `git:pull`, which measures what actually arrived
 * rather than claiming "up to date" over a twenty-commit fast-forward (#1336).
 * This file adds no git of its own.
 */

import {
  classifyPullFailure,
  folderBehindView,
  type FolderBehindAction,
  type FolderBehindStatus,
  type FolderBehindView,
} from './folder-behind-model'

export interface FolderBehindDeps {
  /** The live comparison, or null when it cannot be read. */
  readStatus: () => Promise<FolderBehindStatus | null>
  /** Bring the folder up to date. Rejects with git's message. */
  pull: () => Promise<{ conflicted: boolean; received: number | null }>
  /** Show the person their changes — the git panel. */
  openChanges: () => void
}

export class FolderBehindCard {
  readonly element: HTMLElement
  readonly #deps: FolderBehindDeps
  readonly #branch: string
  #status: FolderBehindStatus | null = null
  #action: FolderBehindAction = { phase: 'idle' }
  /** True once this card is off the transcript — nothing paints after that. */
  #gone = false

  constructor(branch: string, deps: FolderBehindDeps) {
    this.#branch = branch
    this.#deps = deps
    injectStyles()
    this.element = document.createElement('div')
    this.element.className = 'fl-folder-behind'
    this.#paint()
    void this.#refresh()
  }

  /** Stop painting — the pane rebuilt its feed and this element is detached. */
  dispose(): void {
    this.#gone = true
  }

  /**
   * Re-read the comparison.
   *
   * NOT WHILE A PRESS IS IN FLIGHT OR JUST SETTLED. `git:status` coalesces, so
   * a read taken straight after a pull can be answered by the scan that started
   * before it — and "up to date" flickering back to "7 behind" is the app
   * contradicting itself about something it has just done. The press's own
   * outcome is the better evidence and the model prefers it anyway; this only
   * avoids paying for a read whose answer would be ignored.
   */
  async #refresh(): Promise<void> {
    if (this.#action.phase !== 'idle') return
    try {
      const status = await this.#deps.readStatus()
      if (this.#gone || this.#action.phase !== 'idle') return
      this.#status = status
    } catch {
      // A comparison that cannot be read leaves the row saying what it knows:
      // that the folder WAS behind when the conversation began.
      this.#status = null
    }
    this.#paint()
  }

  async #press(kind: 'pull' | 'changes'): Promise<void> {
    if (kind === 'changes') {
      this.#deps.openChanges()
      return
    }
    if (this.#action.phase === 'working') return
    this.#action = { phase: 'working' }
    this.#paint()
    try {
      const result = await this.#deps.pull()
      if (this.#gone) return
      this.#action = result.conflicted
        ? { phase: 'conflicted', files: this.#status?.dirtyFiles ?? 0 }
        : { phase: 'done', received: result.received }
    } catch (error) {
      if (this.#gone) return
      this.#action = {
        phase: 'refused',
        reason: classifyPullFailure(error instanceof Error ? error.message : String(error)),
      }
    }
    this.#paint()
  }

  #paint(): void {
    if (this.#gone) return
    const view = folderBehindView({ branch: this.#branch, status: this.#status, action: this.#action })
    this.element.replaceChildren(this.#render(view))
    this.element.dataset.tone = view.tone
  }

  #render(view: FolderBehindView): HTMLElement {
    const row = document.createElement('div')
    row.className = 'fl-folder-behind-row'
    row.dataset.tone = view.tone

    const body = document.createElement('div')
    body.className = 'fl-folder-behind-body'
    const headline = document.createElement('p')
    headline.className = 'fl-folder-behind-headline'
    headline.textContent = view.headline
    body.append(headline)
    if (view.sub !== null) {
      const sub = document.createElement('p')
      sub.className = 'fl-folder-behind-sub'
      sub.textContent = view.sub
      body.append(sub)
    }
    row.append(body)

    if (view.control !== null) {
      const control = view.control
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'fl-folder-behind-action'
      button.textContent = control.label
      // SHOWN WHILE IT WORKS, not replaced by a spinner and not removed: a
      // control that vanishes under the cursor moves everything below it.
      button.disabled = control.busy
      if (control.busy) button.dataset.busy = 'true'
      button.addEventListener('click', () => void this.#press(control.kind))
      const act = document.createElement('div')
      act.className = 'fl-folder-behind-act'
      act.append(button)
      row.append(act)
    }
    return row
  }
}

let stylesInjected = false

/**
 * Existing tokens only, and an array of lines rather than a template literal:
 * a backtick in a CSS comment ends the literal and breaks this repo's build
 * with a TS1005 that names no cause.
 */
function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = [
    '.fl-folder-behind-row {',
    '  display: flex;',
    '  align-items: flex-start;',
    '  flex-wrap: wrap;',
    '  gap: var(--fl-space-md);',
    '  padding: var(--fl-space-sm) var(--fl-space-md);',
    '  border: var(--fl-border-width) solid var(--fl-color-border);',
    '  border-left: 2px solid var(--fl-color-warning);',
    '  border-radius: var(--fl-radius-row);',
    '}',
    '.fl-folder-behind-row[data-tone="quiet"] { border-left-color: var(--fl-color-border); }',
    '.fl-folder-behind-row[data-tone="done"] { border-left-color: var(--fl-color-success); }',
    '.fl-folder-behind-row[data-tone="bad"] { border-left-color: var(--fl-color-error); }',
    '.fl-folder-behind-body { flex: 1 1 240px; min-width: 0; }',
    '.fl-folder-behind-headline { margin: 0; color: var(--fl-color-text); }',
    '.fl-folder-behind-sub {',
    '  margin: 2px 0 0;',
    '  color: var(--fl-color-text-secondary);',
    '  font-size: var(--fl-text-caption-size);',
    '}',
    '.fl-folder-behind-act { flex: none; }',
    '.fl-folder-behind-action {',
    '  font: inherit;',
    '  font-size: var(--fl-text-caption-size);',
    '  color: var(--fl-color-text);',
    '  background: var(--fl-color-surface-raised);',
    '  border: var(--fl-border-width) solid var(--fl-color-border);',
    '  border-radius: var(--fl-radius-sm);',
    '  padding: 3px var(--fl-space-sm);',
    '  cursor: pointer;',
    '}',
    '.fl-folder-behind-action:hover:not(:disabled) {',
    '  background: var(--fl-color-accent-soft);',
    '  border-color: var(--fl-color-accent);',
    '}',
    '.fl-folder-behind-action:disabled { opacity: 0.6; cursor: default; }',
  ].join('\n')
  document.head.append(style)
}
