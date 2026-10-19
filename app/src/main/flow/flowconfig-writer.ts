// flowconfig-writer — the app's write path into a project's flow/.flowconfig.
//
// NON-DESTRUCTIVE: the file is co-edited by the `/flow` CLI and read by the
// heartbeat daemon, so a write must update ONLY the target keys and leave every
// other line — comments, blank lines, keys we don't touch — exactly as it was.
//
// THE MERGE ITSELF IS NOT HERE ANY MORE. It used to be: this module had its own
// line-based merge, and `src/cli/state/flowconfig-writer.ts` had another, and
// `flow-observer.ts` a third — three implementations of one algorithm over one
// hand-editable file, differing in the details a person only discovers by losing
// a comment. There is now exactly one (allowed-pattern #14), re-exported here so
// every existing caller and test keeps the name it already imports.
//
// `writeFlowconfig` is what this file still owns: the atomic application of that
// merge (temp + rename).

import { promises as fsPromises } from 'fs'
import { join } from 'path'
import { LEGACY_AUTOPILOT_FILE } from './autopilot'

import { mergeFlowconfig } from '../../shared/flowconfig-merge'
import { withAliasedWrites } from '../../shared/worktree-config-aliases'

export { mergeFlowconfig }

const FLOWCONFIG_FILE = '.flowconfig'

/**
 * Apply `updates` to `<flowDir>/.flowconfig` atomically. Creates the file (and
 * flowDir) when absent.
 *
 * A `null` value REMOVES the key — which is how a project stops overriding a
 * default and goes back to inheriting it. Removal is a value of the update
 * rather than a second function beside it, so "set this" and "stop setting this"
 * cannot drift into two merges that disagree.
 *
 * RENAMED KEYS LAND UNDER BOTH NAMES. A key that was renamed (the
 * `workspace_*` → `worktree_*` table, `worktree-config-aliases.json`) is written
 * under its new spelling AND its old one, with the same value, and a removal
 * removes both — older Flow builds read only the old spelling and share the
 * project (transitional, until they are retired). A setting the write does not
 * name keeps whatever spelling its file uses; nobody's file is rewritten behind
 * their back. Same rule as the CLI's `flow set` / `flow unset`.
 *
 * When `autopilot` is written, the legacy `.autopilot` marker file is removed so
 * it can never disagree with the `autopilot:` key (the observer treats the key
 * as authoritative once present) — including when the key is being removed,
 * which is why the check is on the key's presence in `updates`, not its value.
 */
export async function writeFlowconfig(
  flowDir: string,
  updates: Record<string, string | null>,
): Promise<void> {
  if (Object.keys(updates).length === 0) return
  const writes = withAliasedWrites(updates)
  const configPath = join(flowDir, FLOWCONFIG_FILE)

  let existing = ''
  try {
    existing = await fsPromises.readFile(configPath, 'utf-8')
  } catch {
    existing = '' // absent → start fresh
  }

  const merged = mergeFlowconfig(existing, writes)
  await fsPromises.mkdir(flowDir, { recursive: true })
  const tmpPath = join(flowDir, `${FLOWCONFIG_FILE}.tmp-${process.pid}`)
  await fsPromises.writeFile(tmpPath, merged, 'utf-8')
  await fsPromises.rename(tmpPath, configPath) // atomic replace

  if ('autopilot' in updates) {
    await fsPromises.rm(join(flowDir, LEGACY_AUTOPILOT_FILE), { force: true }).catch(() => undefined)
  }
}
