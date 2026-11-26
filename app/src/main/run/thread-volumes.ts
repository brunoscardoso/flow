// A THREAD'S DOCKER DATA AT DELETE TIME — what the delete confirm reads, and
// the one call that removes it.
//
// READ (`threads:dataVolumes`): only when a person opens the delete confirm,
// never on a hot path (allowed-pattern #17). Docker is asked only for projects
// that have a Compose file; a project without one never spawns `docker`.
//
// RELEASE (`threads:releaseDataVolumes`): runs NOTHING without
// `confirmed: true` (forbidden-pattern #15). It stops the thread's services if
// they are live, then removes its volumes through `removeThreadVolumes` (which
// itself refuses without the same confirmation). A delete that skips the
// sidebar never gets here, so its volumes stay — see docker-on-thread-archived.ts.

import { projectDataSlug } from './compose-thread'
import { listThreadVolumes, removeThreadVolumes } from './compose-thread-store'
import type { DockerRunner } from './docker-runner'

export interface ThreadVolumesSummary {
  count: number
  /** Sum of the volumes' sizes; null when Docker did not say any one of them. */
  totalBytes: number | null
}

export interface ThreadVolumesDeps {
  runner: DockerRunner
  /** Every project the conversation works in (the primary one first). Empty when the thread is gone. */
  rootsOf: (threadId: string) => string[]
  /** Whether a project has a Compose file — the only projects Docker is asked about. */
  hasCompose: (rootPath: string) => Promise<boolean>
  /** `RunSupervisor.stopThreadDocker`. */
  stopThreadDocker: (threadId: string) => Promise<boolean>
  slugOf?: (rootPath: string) => string
}

async function composeRoots(deps: ThreadVolumesDeps, threadId: string): Promise<string[]> {
  const roots: string[] = []
  for (const root of deps.rootsOf(threadId)) {
    try {
      if (await deps.hasCompose(root)) roots.push(root)
    } catch {
      // unreadable: treated as having no Compose file
    }
  }
  return roots
}

/** The conversation's volumes and their total size; null when there are none or Docker cannot say. */
export async function readThreadVolumes(
  deps: ThreadVolumesDeps,
  threadId: string,
): Promise<ThreadVolumesSummary | null> {
  const slugOf = deps.slugOf ?? projectDataSlug
  let count = 0
  let total: number | null = 0
  for (const root of await composeRoots(deps, threadId)) {
    let listed
    try {
      listed = await listThreadVolumes(deps.runner, slugOf(root), threadId)
    } catch {
      return null
    }
    if (!listed.ok) return null
    for (const volume of listed.items) {
      count += 1
      total = total === null || volume.sizeBytes === null ? null : total + volume.sizeBytes
    }
  }
  return count === 0 ? null : { count, totalBytes: total }
}

export interface ReleaseVolumesRequest {
  confirmed?: unknown
}

export type ReleaseVolumesResult = { ok: true; removed: number } | { ok: false; detail: string }

const SENTENCE = {
  unconfirmed: "Removing a conversation's data needs an explicit confirmation.",
}

/** Stop the conversation's services if live, then remove its volumes in every project that has a Compose file. */
export async function releaseThreadVolumes(
  deps: ThreadVolumesDeps,
  threadId: string,
  request: ReleaseVolumesRequest = {},
): Promise<ReleaseVolumesResult> {
  if (request.confirmed !== true) return { ok: false, detail: SENTENCE.unconfirmed }
  const slugOf = deps.slugOf ?? projectDataSlug
  const roots = await composeRoots(deps, threadId)
  if (roots.length === 0) return { ok: true, removed: 0 }
  // removeThreadVolumes refuses while a container runs; stop the group first.
  try {
    await deps.stopThreadDocker(threadId)
  } catch {
    // a failed stop surfaces as the removal's own refusal below
  }
  let removed = 0
  for (const root of roots) {
    const result = await removeThreadVolumes(deps.runner, slugOf(root), threadId, { confirmed: true })
    if (!result.ok) return { ok: false, detail: result.detail }
    removed += result.removed.length
  }
  return { ok: true, removed }
}
