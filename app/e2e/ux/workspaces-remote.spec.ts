/**
 * Connecting a Workspace to a shared repository from Settings → Workspaces.
 *
 * The person's report: the Default card said "Shared repository: None — this
 * Workspace stays on this computer" beside a Sync now that could never do
 * anything, and nothing let them change it. Here, end to end and real
 * everywhere: the Default has no shared repository → "Connect a shared
 * repository…" → "Use an existing repository" with the sandbox's address (a
 * LOCAL bare repository behind an ordinary https address — git in the app is
 * locked to `file`, fixtures/workspaces.ts) → main runs the CLI's set-remote
 * and one sync → the bare repository holds the Workspace's commits → Sync now
 * publishes a later change → Disconnect brings the Connect button back.
 *
 * The host tools (`gh`, `az`) never run: under FLOW_E2E main answers every one
 * "not installed", so only "Use an existing repository" is offered.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect, test } from '../fixtures/electron'
import { closeProjectOnboarding, lazySandbox } from '../fixtures/workspaces'

const SCREENS =
  process.env['FLOW_E2E_REMOTE_SCREENS'] ?? process.env['FLOW_E2E_SCREENS'] ?? resolve(__dirname, '__screens')

const seeded = lazySandbox('remote', (sandbox) => ({ backend: sandbox.seedRepo('backend') }))

test.use({ appEnv: async ({}, use) => use(seeded.get().sandbox.appEnv()) })

test.afterAll(async () => {
  await seeded.cleanup()
})

test('Default has no shared repository → Connect → an existing repository → Sync now publishes → Disconnect', async ({ window }) => {
  const { sandbox, backend } = seeded.get()
  test.setTimeout(180_000)
  mkdirSync(SCREENS, { recursive: true })
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(error.message))

  await window.evaluate(async (path) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the preload bridge, untyped in the spec
    const api = (window as unknown as { flow: any }).flow
    await api.project.add({ path })
    await api.project.setActive({ rootPath: path })
  }, backend)
  await closeProjectOnboarding(window, 3_000)
  const switcher = window.locator('.fl-ws-switcher')
  await expect(switcher.locator('.fl-project-name')).toHaveText('Default', { timeout: 60_000 })

  // ── Settings → Workspaces: the Default card offers Connect, not a dead Sync now ──
  await window.evaluate(() =>
    document.dispatchEvent(new CustomEvent('flow:open-settings', { detail: { group: 'workspaces' } })),
  )
  const section = window.locator('.fl-settings-page .fl-wss')
  await expect(section).toBeVisible({ timeout: 15_000 })
  const card = section.locator('.fl-wss-card[data-workspace="default"]')
  await expect(card.locator('[data-part="shared-repository"]')).toContainText('None — this Workspace stays on this computer')
  // POSITIVE FIRST: the card is drawn and offers the way in …
  await expect(card.locator('[data-part="connect-remote"]')).toHaveText('Connect a shared repository…')
  // … and no Sync now that can't do anything.
  await expect(card.locator('[data-part="sync-now"]')).toHaveCount(0)
  await expect(card.locator('[data-part="change-remote"]')).toHaveCount(0)

  // ── Connect: no host tool here, so an existing repository is the one way ──
  await card.locator('[data-part="connect-remote"]').click()
  const dialog = window.locator('.fl-ws-dialog[data-dialog="connect-remote"]')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.fl-ws-dialog-title')).toHaveText('Share Default with your team')
  await expect(dialog.locator('[data-part="host-tools"]')).toContainText('sign in to the GitHub or Azure DevOps command-line tool', {
    timeout: 30_000,
  })
  await expect(dialog.locator('input[name="fl-ws-remote-choice"]')).toHaveCount(1)
  await expect(dialog.locator('.fl-ws-dialog-choice')).toHaveText(['Use an existing repository'])

  // The shared grammar answers in words before anything is sent.
  const address = dialog.locator('#fl-ws-remote-address')
  await address.fill('http://git.example.test/team/ws.git')
  await dialog.locator('[data-action="connect-remote-confirm"]').click()
  await expect(dialog.locator('.fl-ws-dialog-message')).not.toHaveText('')
  expect(sandbox.remoteFiles()).toEqual([])

  await address.fill(sandbox.remoteUrl)
  await window.screenshot({ path: join(SCREENS, 'workspaces-remote-connect-dialog.png') })
  await dialog.locator('[data-action="connect-remote-confirm"]').click()
  const result = dialog.locator('[data-part="connect-result"]')
  await expect(result).toHaveText('Default is shared now. Its knowledge syncs through this repository.', { timeout: 90_000 })
  await window.screenshot({ path: join(SCREENS, 'workspaces-remote-connected.png') })

  // The bare repository holds the Workspace's commits — the Workspace's HEAD exactly.
  const workspaceDir = join(sandbox.flowHome, 'workspaces', 'default')
  expect(sandbox.remoteFiles()).toEqual(expect.arrayContaining(['workspace.json']))
  expect(sandbox.git(workspaceDir, 'rev-parse', 'HEAD').trim()).toBe(
    sandbox.git(sandbox.root, '--git-dir', sandbox.bareDir, 'rev-parse', 'main').trim(),
  )
  expect(JSON.parse(sandbox.remoteFile('workspace.json') ?? '{}')).toMatchObject({ remote: sandbox.remoteUrl })

  await dialog.locator('.fl-ws-dialog-btn', { hasText: 'Done' }).click()
  await expect(dialog).toHaveCount(0)

  // ── The card now shows the address, an enabled Sync now and when it last synced ──
  await expect(card.locator('.fl-wss-remote')).toHaveText(sandbox.remoteUrl, { timeout: 30_000 })
  const syncNow = card.locator('[data-part="sync-now"]')
  await expect(syncNow).toBeEnabled()
  await expect(card.locator('[data-part="sync-status"]')).toHaveText(/^(Synced|Up to date)/, { timeout: 30_000 })
  await expect(card.locator('[data-part="connect-remote"]')).toHaveCount(0)
  await expect(card.locator('[data-part="change-remote"]')).toHaveText('Change…')
  await expect(card.locator('[data-part="disconnect-remote"]')).toHaveText('Disconnect…')
  await window.screenshot({ path: join(SCREENS, 'workspaces-remote-card.png') })

  // ── Sync now publishes a later change ──
  const note = 'projects/backend/discovery/discovery_remote_v1.md'
  writeFileSync(join(workspaceDir, note), '# Shared from this computer\n')
  await syncNow.click()
  await expect.poll(() => sandbox.remoteFile(note), { timeout: 60_000 }).toBe('# Shared from this computer\n')
  await expect(card.locator('[data-part="sync-status"]')).toHaveText(/^(Synced|Up to date)/, { timeout: 30_000 })

  // ── Disconnect: everything stays here, the repository is untouched, Connect is back ──
  const published = sandbox.git(sandbox.root, '--git-dir', sandbox.bareDir, 'rev-parse', 'main').trim()
  await card.locator('[data-part="disconnect-remote"]').click()
  const disconnect = window.locator('.fl-ws-dialog[data-dialog="disconnect-remote"]')
  await expect(disconnect).toContainText('the shared repository is left as it is')
  await disconnect.locator('[data-action="confirm-disconnect"]').click()
  await expect(disconnect).toContainText('Default is no longer shared.', { timeout: 30_000 })
  await disconnect.locator('.fl-ws-dialog-btn', { hasText: 'Done' }).click()
  await expect(card.locator('[data-part="connect-remote"]')).toBeVisible({ timeout: 30_000 })
  await expect(card.locator('[data-part="sync-now"]')).toHaveCount(0)
  expect(sandbox.git(sandbox.root, '--git-dir', sandbox.bareDir, 'rev-parse', 'main').trim()).toBe(published)
  expect(sandbox.remoteFile(note)).toBe('# Shared from this computer\n')

  expect(errors).toEqual([])
})
