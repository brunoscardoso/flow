/**
 * Editor tab strip — owns the ordered list of open files rendered through the
 * <fl-tabs> base component. Tab ids are absolute file paths (same key the
 * Monaco host uses for models).
 *
 * This class only manages tab state; deciding what a select/close means
 * (switch model, confirm dirty discard, …) belongs to the composition layer
 * in ./index.ts, which receives the callbacks.
 */
import type {
  FlTabs,
  TabCloseDetail,
  TabDescriptor,
  TabRevealDetail,
  TabSelectDetail,
} from '../components'
import { neighborOf as neighborInStrip } from '../tab-neighbor'
import { splitProjectPath } from './tab-reveal'
import { isUntitledPath } from './untitled'

export interface EditorTabsCallbacks {
  /** User activated a tab (click or programmatic cycle). */
  onSelect: (id: string) => void
  /** User asked to close a tab — the owner decides whether it really closes. */
  onClose: (id: string) => void
}

export class EditorTabs {
  #el: FlTabs
  #tabs: TabDescriptor[] = []

  constructor(el: FlTabs, callbacks: EditorTabsCallbacks) {
    this.#el = el
    el.addEventListener('fl-tab-select', (event) => {
      callbacks.onSelect((event as CustomEvent<TabSelectDetail>).detail.id)
    })
    el.addEventListener('fl-tab-close', (event) => {
      callbacks.onClose((event as CustomEvent<TabCloseDetail>).detail.id)
    })
    // #1063 — reveal the tab's file in the OS file manager. The tab id is an
    // absolute path; map it to the owning project root so the reveal flows
    // through the same root-contained guard the file-tree uses.
    el.addEventListener('fl-tab-reveal', (event) => {
      void this.#reveal((event as CustomEvent<TabRevealDetail>).detail.id)
    })
  }

  /** Resolve an absolute tab path to {rootPath, relPath} against the roots the
   *  renderer may address and reveal it. Skips (with a warning) when the file
   *  maps to no known root, and never throws (R-2, FR-7).
   *
   *  ADDRESSABLE ROOTS, NOT THE PROJECT LIST. `project.list()` is the
   *  projects a person added; a thread works in its own checkout, which sits
   *  BESIDE the project rather than inside it. Mapping a tab against the
   *  project list therefore found no root for any file in a thread's worktree,
   *  and Reveal in Finder took the "no root" branch and did nothing at all —
   *  while main would have accepted the very same path, because its guard asks
   *  the wider question. Two lists, one question: ask main's. */
  async #reveal(absPath: string): Promise<void> {
    try {
      const roots = (await window.flow.project.addressableRoots()).map((rootPath) => ({ rootPath }))
      const mapped = splitProjectPath(absPath, roots)
      if (!mapped) {
        console.warn('flow: reveal skipped — no project root for', absPath)
        return
      }
      await window.flow.project.revealPath(mapped)
    } catch (error) {
      console.warn('flow: reveal failed', error)
    }
  }

  get ids(): string[] {
    return this.#tabs.map((tab) => tab.id)
  }

  get activeId(): string | null {
    return this.#el.activeId
  }

  get isEmpty(): boolean {
    return this.#tabs.length === 0
  }

  /** Add a tab for `id` (no-op if already open). Icon defaults to 'file'. */
  add(id: string, label: string, icon = 'file'): void {
    if (this.#tabs.some((tab) => tab.id === id)) {
      return
    }
    // #1442: an unsaved note's id is synthetic — the reveal resolved to
    // `<root>/Untitled-N`, a path that exists nowhere, and showItemInFolder on a
    // nonexistent path is a silent no-op. The row stays (this is an editor tab
    // among editor tabs) but says why it can't act.
    this.#tabs.push({
      id,
      label,
      icon,
      closable: true,
      dirty: false,
      revealable: true,
      ...(isUntitledPath(id)
        ? { revealBlockedReason: 'Save the note first — it has no file on disk yet' }
        : {}),
    })
    this.#render()
  }

  has(id: string): boolean {
    return this.#tabs.some((tab) => tab.id === id)
  }

  remove(id: string): void {
    const index = this.#tabs.findIndex((tab) => tab.id === id)
    if (index === -1) {
      return
    }
    this.#tabs.splice(index, 1)
    this.#render()
  }

  setActive(id: string | null): void {
    this.#el.activeId = id
  }

  /** Re-label a tab (#991: a basename that collides with another open file
   *  grows a disambiguating path tail). No-op when nothing changes, so the
   *  relabel sweep after every open/close never churns the strip. */
  setLabel(id: string, label: string): void {
    const tab = this.#tabs.find((candidate) => candidate.id === id)
    if (tab && tab.label !== label) {
      tab.label = label
      this.#render()
    }
  }

  setDirty(id: string, dirty: boolean): void {
    const tab = this.#tabs.find((candidate) => candidate.id === id)
    if (tab && tab.dirty !== dirty) {
      tab.dirty = dirty
      this.#render()
    }
  }

  /**
   * Set (or clear, with undefined) a tab's project-accent dot + tooltip —
   * multi-project threads mark files from secondary scope roots. No-op when
   * nothing changes, so scope-refresh sweeps don't churn the strip.
   */
  setAccent(id: string, accent: string | undefined, tooltip: string | undefined): void {
    const tab = this.#tabs.find((candidate) => candidate.id === id)
    if (tab && (tab.accent !== accent || tab.tooltip !== tooltip)) {
      tab.accent = accent
      tab.tooltip = tooltip
      this.#render()
    }
  }

  /**
   * The tab to activate once `id` closes: the one to its right, else the one
   * to its left, else null (strip becomes empty). Call BEFORE remove(). Shared
   * with the terminal tab strip so both behave identically (#408).
   */
  neighborOf(id: string): string | null {
    return neighborInStrip(
      this.#tabs.map((tab) => tab.id),
      id,
    )
  }

  /**
   * Next tab id in strip order for ctrl+tab cycling (`offset` +1 forward,
   * -1 backward, wrapping). Null when no tabs are open.
   */
  cycle(offset: 1 | -1): string | null {
    if (this.#tabs.length === 0) {
      return null
    }
    const currentIndex = this.#tabs.findIndex((tab) => tab.id === this.#el.activeId)
    const nextIndex =
      currentIndex === -1
        ? 0
        : (currentIndex + offset + this.#tabs.length) % this.#tabs.length
    return this.#tabs[nextIndex]?.id ?? null
  }

  #render(): void {
    // fl-tabs re-renders on assignment; pass a copy so its state stays ours.
    this.#el.tabs = this.#tabs.map((tab) => ({ ...tab }))
  }
}
