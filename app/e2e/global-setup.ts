/**
 * SWEEP BEFORE, NOT ONLY AFTER.
 *
 * Every spec that seeds a project already calls `cleanupSeeds()` in its
 * `afterAll` — 409 of the 421 that seed do. That is not the leak.
 *
 * The leak is that `afterAll` DOES NOT RUN when a run is killed: a timeout, a
 * ⌃C, a harness that backgrounds and then reaps the process. Each of those
 * leaves behind every repository that run had seeded, and nothing ever comes
 * back for them.
 *
 * Measured 2026-09-17, after a day of interrupted runs: **10,212 leaked seed
 * directories** under the temp dir. The cost is not disk — it is that the suite
 * gets slower and slower against a temp directory holding ten thousand git
 * repositories, until tests that took seconds take a quarter of an hour and
 * fail on timeouts that have nothing to do with the code under test. Two did.
 *
 * So the sweep runs at START. A kill can skip a teardown; it cannot skip the
 * next run's setup. This is belt and braces with `cleanupSeeds`, deliberately:
 * the per-spec teardown keeps a healthy run tidy as it goes, and this catches
 * whatever the last unhealthy one left.
 *
 * SCOPED TO THE FIXTURES' OWN PREFIX. Only `flow-*` directories directly inside
 * the temp dir, which is what `seedProject` creates and nothing else does.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

/** How many leaked directories to report before going quiet. */
const NOISE_CAP = 5

export default function globalSetup(): void {
  sweepTempSeeds()
  sweepVaultFoldersOfDeletedTempProjects()
}

function sweepTempSeeds(): void {
  const root = tmpdir()
  let swept = 0
  let held = 0
  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  for (const name of entries) {
    if (!name.startsWith('flow-')) continue
    const dir = join(root, name)
    try {
      if (!statSync(dir).isDirectory()) continue
      rmSync(dir, { recursive: true, force: true })
      swept += 1
    } catch {
      // Still held open by something. The next run will try again.
      held += 1
    }
  }
  if (swept > 0) {
    console.log(`[seed] swept ${String(swept)} leaked seed director${swept === 1 ? 'y' : 'ies'}`)
  }
  if (held > 0 && held <= NOISE_CAP) {
    console.warn(`[seed] ${String(held)} leaked director${held === 1 ? 'y' : 'ies'} still held open`)
  }
}

/** `/private/var/…` and `/var/…` are one place on macOS. */
function withoutPrivatePrefix(path: string): string {
  return path.replace(/^\/private(?=\/)/, '')
}

/**
 * THE VAULT LEAKED TOO. Provisioning links every project's flow/ into the
 * developer's real vault (`~/plan-flow/brain/projects/<name>/`), so each spec
 * project left a folder there after its temp directory was gone — 17,600+ by
 * 2026-10-01, including specs that launch the app themselves.
 *
 * Removed: a vault folder whose own index note (`<name>/<name>.md`, written by
 * provisioning) records a project path inside the system temp dir that NO
 * LONGER EXISTS (or under the one home-folder spec prefix, `~/.flow-ux-`).
 * A real project never lives in either place, and a live one
 * (a run in progress) still exists — so neither is touched.
 */
function sweepVaultFoldersOfDeletedTempProjects(): void {
  const projects = join(process.env['PLAN_FLOW_VAULT_DIR'] || join(homedir(), 'plan-flow', 'brain'), 'projects')
  // The temp dir, plus the one spec that must seed under the home folder
  // (file-tree-create-delete: its repo has to live outside the temp dir).
  const throwaway = [`${withoutPrivatePrefix(tmpdir())}/`, join(homedir(), '.flow-ux-')]
  let names: string[] = []
  try {
    names = readdirSync(projects)
  } catch {
    return
  }
  let swept = 0
  for (const name of names) {
    const folder = join(projects, name)
    let recorded: string | undefined
    try {
      recorded = /\*\*Path\*\*: `([^`]+)`/.exec(readFileSync(join(folder, `${name}.md`), 'utf8'))?.[1]
    } catch {
      continue // no index note — not a folder provisioning wrote; leave it
    }
    if (recorded === undefined) continue
    const where = withoutPrivatePrefix(recorded)
    if (!throwaway.some((prefix) => where.startsWith(prefix))) continue
    if (existsSync(recorded)) continue
    try {
      rmSync(folder, { recursive: true, force: true })
      swept += 1
    } catch {
      // Held open — the next run tries again.
    }
  }
  if (swept > 0) {
    console.log(`[seed] swept ${String(swept)} vault folder${swept === 1 ? '' : 's'} of deleted temp projects`)
  }
}
