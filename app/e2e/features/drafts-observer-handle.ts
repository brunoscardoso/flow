import type { ElectronApplication } from '@playwright/test'

/**
 * Run an agent's write to a canvas file through the drafts observer's OWN
 * chain and processing, from main — the same call the file watcher's settled
 * event makes (snapshot of the previous version, stamp, broadcast). The watcher
 * on a macOS temp folder is not reliable enough for a spec to wait on. The
 * handle is published only in a hidden, unpackaged run (main/e2e-seams.ts).
 *
 * Resolves with whether the observer found the change worth broadcasting. A
 * watcher event that got there first leaves this one a no-op (false), so a
 * spec asserts the observable result, not this answer.
 */
export async function observeAgentWrite(app: ElectronApplication, root: string, absPath: string): Promise<boolean> {
  return app.evaluate(
    async (_electron, { root, absPath }) => {
      const handles = (
        globalThis as {
          __flowE2EHandles?: { draftsObserver?: { processChange(r: string, p: string): Promise<boolean> } }
        }
      ).__flowE2EHandles
      if (handles?.draftsObserver === undefined) throw new Error('the drafts observer handle is not published')
      return handles.draftsObserver.processChange(root, absPath)
    },
    { root, absPath },
  )
}
