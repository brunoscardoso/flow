/**
 * A PROJECT'S SHARING IDENTITY — 32 random lower-hex characters, minted the
 * first time a share needs one and kept in the project's own settings
 * (`share_project_id` in its flow config).
 *
 * WHY NOT THE FOLDER NAME (review R2-M3): shares used to be found by (author,
 * folder name, slug), so `~/clientB/app` saw `~/clientA/app`'s share and
 * "Update shared page" published B's content to A's audience. The folder name
 * is now a display label only; this id is how a share is found.
 *
 * ONE ID PER PROJECT, NOT PER CHECKOUT: a thread's worktree resolves to its
 * owner checkout's settings, so a discovery shared from either is the same
 * share.
 *
 * READING NEVER WRITES. `existing` answers null for a project that never
 * shared; only `ensure` mints, and only on an action a person took (publish,
 * "Check sharing status"). Two concurrent `ensure`s for one project agree: the
 * mint is serialized per settings file, and re-read before it is written.
 */
import { randomBytes } from 'crypto'
import { join } from 'path'

import { SHARE_PROJECT_ID_PATTERN } from '../../shared/share-contract'

/** The settings key the id is kept under. */
export const SHARE_PROJECT_ID_KEY = 'share_project_id'

export interface ProjectIdDeps {
  /** The owner checkout of a worktree; null for a root that is its own owner. */
  ownerCheckoutFor(rootPath: string): string | null
  /** The parsed settings of `<flowDir>` — `{}` when there are none. */
  readConfig(flowDir: string): Promise<Record<string, string>>
  /** Write keys into `<flowDir>`'s settings, leaving every other line alone. */
  writeConfig(flowDir: string, updates: Record<string, string>): Promise<void>
  /** 32 lower-hex characters. Injectable so a test can pin it. */
  mint?: () => string
}

export interface ProjectIds {
  /** The project's id, or null when it has none yet. Never writes. */
  existing(rootPath: string): Promise<string | null>
  /** The project's id, minting and storing one when it has none. */
  ensure(rootPath: string): Promise<string>
}

export function mintProjectId(): string {
  return randomBytes(16).toString('hex')
}

export function createProjectIds(deps: ProjectIdDeps): ProjectIds {
  const mint = deps.mint ?? mintProjectId
  const inFlight = new Map<string, Promise<string>>()

  function flowDirOf(rootPath: string): string {
    return join(deps.ownerCheckoutFor(rootPath) ?? rootPath, 'flow')
  }

  async function stored(flowDir: string): Promise<string | null> {
    const value = (await deps.readConfig(flowDir))[SHARE_PROJECT_ID_KEY]
    // Anything but the contract's shape is not an id (a hand edit, a merge
    // conflict): treated as absent, so `ensure` replaces it with a real one.
    return typeof value === 'string' && SHARE_PROJECT_ID_PATTERN.test(value) ? value : null
  }

  return {
    existing: (rootPath) => stored(flowDirOf(rootPath)),

    ensure(rootPath) {
      const flowDir = flowDirOf(rootPath)
      const pending = inFlight.get(flowDir)
      if (pending !== undefined) return pending
      const run = (async (): Promise<string> => {
        const found = await stored(flowDir)
        if (found !== null) return found
        const minted = mint()
        if (!SHARE_PROJECT_ID_PATTERN.test(minted)) throw new Error('minted project id has the wrong shape')
        await deps.writeConfig(flowDir, { [SHARE_PROJECT_ID_KEY]: minted })
        return minted
      })()
      inFlight.set(flowDir, run)
      void run.then(
        () => inFlight.delete(flowDir),
        () => inFlight.delete(flowDir),
      )
      return run
    },
  }
}
