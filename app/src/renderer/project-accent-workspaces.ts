/**
 * Every open project wears its Workspace colour (user, 2026-10-06: "the colors
 * of … each one … according to the color that we are using on the app").
 *
 * A project's colour before anyone picks one is its POSITION in its Workspace —
 * the slot the Workspace map gives its country. This reads the Workspaces and
 * the open projects, matches each Workspace project's checkout to the root
 * Flow has open, and records the slots in `project-accent.ts`, which every
 * surface paints through (file tree, tabs, git groups, chips, the switcher).
 * It also applies each root's picked colour, so a pick shows everywhere
 * whichever surface happens to be open.
 *
 * Re-read when the Workspaces change and when the open projects change; both
 * are rare, so there is nothing to filter (allowed-pattern #17).
 */
import { applyAccentOverrides, setAccentSlots } from './project-accent'
import { slotsFor } from './project-accent-slots'

/** Start following. Returns a stop function. */
export function startProjectAccentSlots(): () => void {
  const flow = window.flow
  const workspaces = flow.workspaces
  if (workspaces === undefined) return () => undefined
  let disposed = false
  let pending: Promise<void> | null = null
  let again = false

  const refresh = async (): Promise<void> => {
    if (pending !== null) {
      again = true
      return
    }
    pending = (async () => {
      try {
        const [listed, roots] = await Promise.all([workspaces.list(), flow.project.list()])
        if (disposed) return
        applyAccentOverrides(roots)
        if (listed.ok) setAccentSlots(slotsFor(listed.workspaces, roots.map((root) => root.rootPath)))
      } catch (error) {
        console.warn('flow: could not read the project colours', error)
      }
    })()
    await pending
    pending = null
    if (again && !disposed) {
      again = false
      void refresh()
    }
  }

  const stops = [workspaces.onChanged(() => void refresh()), flow.project.onListChanged(() => void refresh())]
  void refresh()
  return () => {
    disposed = true
    for (const stop of stops) stop()
  }
}
