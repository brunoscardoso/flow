import { existsSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page } from '@playwright/test'

/**
 * WAIT FOR THE PROJECT'S KNOWLEDGE TO LIVE IN ITS WORKSPACE, AND ITS FIRST
 * DERIVE TO LAND — then a spec may seed `flow/brain/.structure`.
 *
 * Every project joins a Workspace on its first add (the hard migration,
 * 2026-10-06): `<repo>/flow` is copied into the Workspace's project folder and
 * replaced by a link to it, and the original is kept as
 * `flow.pre-workspace-<date>/`. The copy skips the GENERATED sync class
 * (`knowledge-classes.ts`): `graph.json`, `file-stamps.json`,
 * `file-tiers.json`, `surface.json`, … are "rebuilt on each machine", and the
 * provisioner's first derive does rebuild them — from the repo as it is NOW.
 *
 * So a fixture written into `flow/brain/.structure` BEFORE the project is
 * added is silently dropped (a seeded tier store vanishes; a drift baseline is
 * re-taken after the change it was meant to precede). Seed derived files after
 * this resolves instead; they then land in the Workspace through the link.
 */
export async function waitForLinkedStructure(
  win: Page,
  root: string,
  timeout = 90_000,
): Promise<string> {
  const flow = join(root, 'flow')
  const structure = join(flow, 'brain', '.structure')
  // The provisioner (init + its fire-and-forget first derive) is done with it.
  await expect
    .poll(
      () =>
        win.evaluate(async (rootPath) => {
          const roots = (await (
            window as unknown as {
              flow: { project: { list(): Promise<Array<{ rootPath: string; provisioningState?: string; provisionedAt?: string }>> } }
            }
          ).flow.project.list()) as Array<{ rootPath: string; provisioningState?: string; provisionedAt?: string }>
          const row = roots.find((r) => r.rootPath === rootPath)
          if (row === undefined) return 'not registered'
          if (row.provisioningState === 'provisioning') return 'provisioning'
          return row.provisionedAt === undefined ? 'not provisioned yet' : 'provisioned'
        }, root),
      { timeout, intervals: [250], message: `${root}: never finished provisioning` },
    )
    .toBe('provisioned')
  // Settled = linked, and the structure folder has stopped changing for a
  // while (a first derive, when the provisioner runs one, rewrites it).
  let lastSignature = ''
  let stableSince = Date.now()
  await expect
    .poll(
      () => {
        if (!existsSync(flow) || !lstatSync(flow).isSymbolicLink()) return 'flow/ not linked into its Workspace yet'
        const signature = existsSync(structure)
          ? readdirSync(structure)
              .sort()
              // A lock file can vanish between the listing and its stat — a
              // file gone mid-read is a change, not an error.
              .map((name) => {
                try {
                  return `${name}:${statSync(join(structure, name)).mtimeMs}`
                } catch {
                  return `${name}:gone`
                }
              })
              .join('|')
          : 'none'
        if (signature !== lastSignature) {
          lastSignature = signature
          stableSince = Date.now()
        }
        return Date.now() - stableSince >= 3_000 ? 'ready' : 'structure still changing'
      },
      { timeout, intervals: [250], message: `${root}: flow/ never settled in its Workspace` },
    )
    .toBe('ready')
  // A project whose first derive wrote nothing has no `.structure` yet; the
  // caller is about to seed it, through the link.
  mkdirSync(structure, { recursive: true })
  return structure
}
