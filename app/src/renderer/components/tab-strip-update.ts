/**
 * Pure decision logic for <fl-tabs> strip updates (#993).
 *
 * The strip used to rebuild ALL tab DOM on every `tabs`/`activeId` assignment
 * and unconditionally scroll the active tab into view. With several live
 * shells feeding title changes (~1×/s each), that reset the user's manual
 * scroll position within a second, making overflowed tabs unreachable.
 *
 * `planStripUpdate` compares the last-rendered snapshot against the incoming
 * one and decides the cheapest sufficient DOM operation:
 *
 *   - `none`    — nothing rendered would change; skip entirely (idempotence).
 *   - `patch`   — same tabs in the same order with the same structure; only
 *                 labels / dirty dots / the active tab differ. Patch the
 *                 existing DOM in place; the user's scrollLeft is untouched.
 *   - `rebuild` — tabs added/removed/reordered or structural fields changed;
 *                 tear down and rebuild (scrollLeft preserved by the caller).
 *
 * Auto-scroll-into-view (#700) fires ONLY when the active tab actually
 * changed — a user action — never on background label churn.
 */
import type { TabDescriptor } from './fl-tabs'

export interface StripSnapshot {
  tabs: TabDescriptor[]
  activeId: string | null
}

export type StripUpdatePlan =
  | { kind: 'none' }
  | {
      kind: 'patch'
      /** Indices whose label text (and close-button aria-label) must update. */
      relabel: number[]
      /** Indices whose dirty-dot presence must toggle. */
      redirty: number[]
      /** The active tab moved — update active classes / aria-selected. */
      activeChanged: boolean
      /** Scroll the (new) active tab into view — only on a real active change. */
      scrollActiveIntoView: boolean
    }
  | { kind: 'rebuild'; scrollActiveIntoView: boolean }

/** Structural fields — a change in any of these invalidates the tab's DOM
 *  shape (icons, close buttons, handlers, project-accent dot, tooltip),
 *  forcing a rebuild. Accent/tooltip flips happen only on thread-scope
 *  changes (rare), so rebuilding keeps the patch path free of them while
 *  label/dirty churn still patches in place. */
function sameStructure(prev: TabDescriptor, next: TabDescriptor): boolean {
  return (
    prev.id === next.id &&
    prev.icon === next.icon &&
    (prev.closable ?? false) === (next.closable ?? false) &&
    (prev.renamable ?? false) === (next.renamable ?? false) &&
    prev.accent === next.accent &&
    prev.tooltip === next.tooltip
  )
}

export function planStripUpdate(prev: StripSnapshot, next: StripSnapshot): StripUpdatePlan {
  const activeChanged = prev.activeId !== next.activeId
  // Only a real active-tab change may auto-scroll (#993) — and only when there
  // IS an active tab to scroll to.
  const scrollActiveIntoView = activeChanged && next.activeId !== null

  const structureSame =
    prev.tabs.length === next.tabs.length &&
    prev.tabs.every((tab, i) => sameStructure(tab, next.tabs[i]))
  if (!structureSame) {
    return { kind: 'rebuild', scrollActiveIntoView }
  }

  const relabel: number[] = []
  const redirty: number[] = []
  next.tabs.forEach((tab, i) => {
    if (prev.tabs[i].label !== tab.label) relabel.push(i)
    if ((prev.tabs[i].dirty ?? false) !== (tab.dirty ?? false)) redirty.push(i)
  })

  if (relabel.length === 0 && redirty.length === 0 && !activeChanged) {
    return { kind: 'none' }
  }
  return { kind: 'patch', relabel, redirty, activeChanged, scrollActiveIntoView }
}
