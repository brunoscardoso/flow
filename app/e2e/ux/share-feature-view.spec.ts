import type { ElectronApplication } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * Sharing a discovery's feature view, end to end through the real renderer.
 *
 * The share service and the sign-in are NOT reached: the six `share:*`
 * handlers are replaced in MAIN (window.flow is a frozen contextBridge proxy —
 * assigning to it from the page silently does nothing), so the spec drives the
 * real feature view tab, the real Share button and the real dialog, and reads
 * back exactly what the renderer asked main to publish.
 *
 *  1. Signed out: the page is framed as always, and the button reads
 *     "Sign in to share".
 *  2. Signed in, never shared: main answers from its local record (nothing
 *     asked of the share host — review R2-M7). "Check sharing status" is the
 *     author's explicit ask, and says when there is nothing shared.
 *  3. Share → add one email → "What will be sent" names both files → Share →
 *     the strip names the share (title · project) and "Shared with 1 person",
 *     and main received the email and the hashes the author was shown.
 *  4. Reopened, main's record now says it is shared — the strip is back.
 *  5. The main window refuses to navigate away from the app (review R2-M8).
 *
 * The view is opened by dispatching the event the DISCOVERY card's
 * "Open feature view" press dispatches — no wait on the file watcher, which is
 * unreliable for macOS temp dirs.
 */

const SLUG = 'ledger-sync'
const DOC = `discovery_${SLUG}_v1.md`
const PAGE = `discovery_${SLUG}_v1.walkthrough.html`
const TITLE = 'Discovery: Ledger Sync'
const EMAIL = 'pm@acme.com'
const PAGE_TEXT = 'Reconcile every ledger in one place'

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Ledger Sync</title></head>
<body><h1>Ledger Sync</h1><p>${PAGE_TEXT}</p></body></html>\n`
const DOC_MD = `# ${TITLE}\n\nReconcile the ledger.\n`

const PAGE_BYTES = Buffer.byteLength(PAGE_HTML, 'utf8')
const DOC_BYTES = Buffer.byteLength(DOC_MD, 'utf8')
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const PAGE_SHA = sha256(PAGE_HTML)
const DOC_SHA = sha256(DOC_MD)
const PAGE_MODIFIED_AT = '2026-10-01T10:00:00.000Z'

test.afterAll(() => cleanupSeeds())

/** Replace every share handler in main. `signedIn` decides what `share:get` answers. */
async function stubShare(app: ElectronApplication, signedIn: boolean): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, input) => {
      const g = globalThis as unknown as { __shareCalls?: Array<{ channel: string; request: unknown }> }
      g.__shareCalls ??= []
      const record = (channel: string, request: unknown): void => {
        g.__shareCalls?.push({ channel, request })
      }
      const local = {
        project: 'proj',
        slug: input.slug,
        title: input.title,
        discoveryVersion: 1,
        pageModifiedAt: input.pageModifiedAt,
        files: [
          { part: 'walkthrough', name: input.page, bytes: input.pageBytes, sha256: input.pageSha },
          { part: 'discovery', name: input.doc, bytes: input.docBytes, sha256: input.docSha },
        ],
        totalBytes: input.pageBytes + input.docBytes,
        maxBytes: 2 * 1024 * 1024,
      }
      const signedOut = { ok: false, reason: 'signed-out', message: 'Sign in to Flow to share this page.' }
      // Main's local record of what this account shared (review R2-M7): empty
      // until a publish succeeds, exactly as the real client keeps it.
      const shared = globalThis as unknown as { __sharedSummary?: unknown }
      for (const channel of ['share:get', 'share:check', 'share:publish', 'share:update', 'share:revoke', 'share:views']) {
        ipcMain.removeHandler(channel)
      }
      ipcMain.handle('share:get', (_event, request) => {
        record('share:get', request)
        return input.signedIn ? { ok: true, share: shared.__sharedSummary ?? null, local } : signedOut
      })
      ipcMain.handle('share:check', (_event, request) => {
        record('share:check', request)
        return input.signedIn ? { ok: true, share: shared.__sharedSummary ?? null, local } : signedOut
      })
      ipcMain.handle('share:publish', (_event, request: { access?: { emails: string[]; domains: string[] } }) => {
        record('share:publish', request)
        if (!input.signedIn) return signedOut
        const access = request.access ?? { emails: [], domains: [] }
        shared.__sharedSummary = {
          id: 'shareIdForE2E0001',
          url: 'https://planflow.sh/v/shareIdForE2E0001',
          project: 'proj',
          slug: input.slug,
          title: input.title,
          version: 1,
          discoveryVersion: 1,
          pageModifiedAt: input.pageModifiedAt,
          publishedAt: input.pageModifiedAt,
          access,
          accessCount: access.emails.length + access.domains.length,
          revokedAt: null,
          expiresAt: null,
        }
        return {
          ok: true,
          invitesSkipped: 1,
          share: {
            id: 'shareIdForE2E0001',
            url: 'https://planflow.sh/v/shareIdForE2E0001',
            project: 'proj',
            slug: input.slug,
            title: input.title,
            version: 1,
            discoveryVersion: 1,
            pageModifiedAt: input.pageModifiedAt,
            publishedAt: input.pageModifiedAt,
            access,
            accessCount: access.emails.length + access.domains.length,
            revokedAt: null,
            expiresAt: null,
          },
        }
      })
      for (const channel of ['share:update', 'share:revoke', 'share:views']) {
        ipcMain.handle(channel, (_event, request) => {
          record(channel, request)
          return signedOut
        })
      }
    },
    {
      signedIn,
      slug: SLUG,
      title: TITLE,
      page: PAGE,
      doc: DOC,
      pageBytes: PAGE_BYTES,
      docBytes: DOC_BYTES,
      pageSha: PAGE_SHA,
      docSha: DOC_SHA,
      pageModifiedAt: PAGE_MODIFIED_AT,
    },
  )
}

/**
 * Wait until the project's `flow/` is its Workspace link.
 *
 * It used to wait for the CLI scaffold's `flow/tasklist.md`; since the
 * Workspaces hard migration an app-managed project is provisioned with
 * `init --workspace-managed` (nothing seeded) and then placed in its Workspace,
 * which REPLACES `flow/` with a link into the Workspace's project folder. A doc
 * written before that lands in the folder being replaced, so the link is the
 * settled state to wait for.
 */
async function waitForWorkspaceLink(root: string): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          return lstatSync(join(root, 'flow')).isSymbolicLink()
        } catch {
          return false
        }
      },
      { timeout: 30_000 },
    )
    .toBe(true)
}

async function shareCalls(app: ElectronApplication): Promise<Array<{ channel: string; request: unknown }>> {
  return app.evaluate(
    () => (globalThis as unknown as { __shareCalls?: Array<{ channel: string; request: unknown }> }).__shareCalls ?? [],
  )
}

test('a feature view is shared from its Share button; signed out it asks to sign in', async ({ app, window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

  const root = await seedProject(window)
  await activateProject(window, root)
  // Write only once the background scaffold is in place (a doc written while it
  // runs can be lost with the folder it landed in).
  await waitForWorkspaceLink(root)
  const discoveryDir = join(root, 'flow', 'discovery')
  mkdirSync(discoveryDir, { recursive: true })
  writeFileSync(join(discoveryDir, DOC), DOC_MD)
  writeFileSync(join(discoveryDir, PAGE), PAGE_HTML)

  await stubShare(app, false)

  const openView = (): Promise<void> =>
    window.evaluate(
      (detail) => {
        document.dispatchEvent(new CustomEvent('flow:open-feature-view', { detail }))
      },
      { rootPath: root, path: `flow/discovery/${PAGE}`, slug: SLUG, title: TITLE },
    )

  // ── Signed out ────────────────────────────────────────────────────────────
  await openView()
  const view = window.locator('.fl-feature-view').filter({ hasText: TITLE })
  await expect(view).toBeVisible({ timeout: 15_000 })
  const button = view.locator('.fl-feature-share-btn')
  await expect(button).toHaveText('Sign in to share', { timeout: 15_000 })
  await expect(button).toBeEnabled()
  // The page itself is framed exactly as it is signed in.
  const frame = view.locator('iframe.fl-feature-frame')
  await expect(frame).toBeVisible()
  await expect(view.frameLocator('iframe.fl-feature-frame').getByText(PAGE_TEXT)).toBeVisible({
    timeout: 15_000,
  })
  // main was asked about THIS discovery — the doc path, not the page path.
  const asked = (await shareCalls(app)).filter((c) => c.channel === 'share:get')
  expect(asked.length).toBeGreaterThan(0)
  expect(asked[asked.length - 1]?.request).toEqual({ rootPath: root, docPath: `flow/discovery/${DOC}` })
  // Not shared, so no strip.
  await expect(view.locator('.fl-feature-share-strip')).toBeHidden()

  // ── Signed in ─────────────────────────────────────────────────────────────
  await stubShare(app, true)
  // Opening again is a fresh look; the view asks main again.
  await openView()
  await expect(button).toHaveText('Share', { timeout: 15_000 })
  await expect(button).toBeEnabled()
  await button.click()

  const dialog = window.locator('.fl-share-dialog[role="dialog"]')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.fl-share-title')).toHaveText('Share this artifact')

  // Opening the view and the dialog asked main only — never "check" (R2-M7).
  expect((await shareCalls(app)).filter((c) => c.channel === 'share:check')).toEqual([])
  // "Check sharing status" is the author's explicit ask; nothing is shared yet.
  const check = dialog.locator('.fl-share-check-status')
  await expect(check).toHaveText('Check sharing status')
  await check.click()
  await expect(dialog.locator('.fl-share-message')).toHaveText("You haven't shared this page from this account.")
  await expect(dialog).toBeVisible()
  const checked = (await shareCalls(app)).filter((c) => c.channel === 'share:check')
  expect(checked).toHaveLength(1)
  expect(checked[0]?.request).toEqual({ rootPath: root, docPath: `flow/discovery/${DOC}` })

  // What will be sent: exactly the two files, by name.
  const sent = dialog.locator('.fl-share-sent')
  await expect(sent).toContainText('What will be sent')
  const names = sent.locator('.fl-share-file-name')
  await expect(names).toHaveText([PAGE, DOC])
  await expect(sent).toContainText('Only these two files leave your computer.')

  // Add one person.
  const people = dialog.locator('input.fl-share-chip-input[type="email"]')
  await people.fill(EMAIL)
  await people.press('Enter')
  await expect(dialog.locator('.fl-share-chip', { hasText: EMAIL })).toBeVisible()

  await dialog.locator('.fl-share-confirm').click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })

  // The strip says who it is shared with, and the button now manages it.
  const strip = view.locator('.fl-feature-share-strip')
  await expect(strip).toBeVisible()
  await expect(strip.locator('.fl-feature-share-subject')).toHaveText(`${TITLE} · proj`)
  await expect(strip.locator('.fl-feature-share-summary')).toHaveText('Shared with 1 person')
  // The server skipped one invite (sending limits): the author is told in words.
  await expect(view.locator('.fl-feature-share-note')).toHaveText(
    "1 person wasn't emailed because of sending limits — share the link with them directly.",
  )
  await expect(strip.locator('.fl-feature-share-link')).toHaveText('https://planflow.sh/v/shareIdForE2E0001')
  await expect(button).toHaveText('Shared')

  // What the renderer asked main to publish: this discovery, the person, and the
  // hashes (and sizes) of what the author was shown — never any content.
  const published = (await shareCalls(app)).filter((c) => c.channel === 'share:publish')
  expect(published).toHaveLength(1)
  const request = published[0]?.request as Record<string, unknown>
  expect(request).toMatchObject({
    rootPath: root,
    docPath: `flow/discovery/${DOC}`,
    reviewed: { walkthroughBytes: PAGE_BYTES, discoveryBytes: DOC_BYTES, walkthroughSha256: PAGE_SHA, discoverySha256: DOC_SHA },
    access: { emails: [EMAIL], domains: [] },
    notify: true,
  })
  expect(Object.keys(request).sort()).toEqual(['access', 'docPath', 'expiresAt', 'notify', 'reviewed', 'rootPath'])
  expect(JSON.stringify(request)).not.toContain(PAGE_TEXT)

  await view.screenshot({ path: 'e2e/results/share-feature-view.png' })

  // ── Reopened: main's record says it is shared ─────────────────────────────
  await openView()
  await expect(strip).toBeVisible()
  await expect(button).toHaveText('Shared')

  // ── The main window stays the app (review R2-M8) ──────────────────────────
  const appUrl = window.url()
  await window.evaluate(() => {
    window.location.href = 'file:///tmp/flow-e2e-not-the-app.html'
  })
  // Give a navigation the time it would need to land, then prove it did not.
  await window.waitForTimeout(500)
  expect(window.url()).toBe(appUrl)
  // Read through evaluate, not a locator: Playwright keeps waiting on the
  // navigation the renderer started and main cancelled.
  expect(
    await window.evaluate(() => ({
      bridge: typeof window.flow?.share?.get,
      view: document.querySelector('.fl-feature-view') !== null,
      href: window.location.href,
    })),
  ).toEqual({ bridge: 'function', view: true, href: appUrl })

  expect(errors).toEqual([])
})

/**
 * ONE SIGN-IN STATE. A stored session the share host refuses (its signing
 * secret rotated, the session ran out) is cleared by main and broadcast as
 * `auth:changed`, so the Share button AND Settings both read signed out.
 *
 * Main's half — the share client reporting the refusal and the auth module
 * clearing the identity — is unit-tested (`share-client.test.ts`,
 * `auth-session.test.ts`). Here the share and auth handlers are replaced in
 * main by a stub that does what main does on a 401: forget the identity, send
 * the real `auth:changed` event to every window, answer `unauthenticated`. What
 * this proves is the renderer half, through the real preload: the button flips,
 * Settings stops naming the person, and signing in from the button reopens the
 * Share dialog without publishing.
 */
async function stubRejectingAuth(app: ElectronApplication): Promise<void> {
  await app.evaluate(
    ({ ipcMain, BrowserWindow }, input) => {
      const g = globalThis as unknown as {
        __shareCalls?: Array<{ channel: string; request: unknown }>
        __signedIn?: boolean
      }
      g.__shareCalls = []
      g.__signedIn = true
      const record = (channel: string, request: unknown): void => {
        g.__shareCalls?.push({ channel, request })
      }
      const tellEveryWindow = (cause: string): void => {
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('auth:changed', { cause })
        }
      }
      const local = {
        project: 'proj',
        slug: input.slug,
        title: input.title,
        discoveryVersion: 1,
        pageModifiedAt: input.pageModifiedAt,
        files: [
          { part: 'walkthrough', name: input.page, bytes: input.pageBytes, sha256: input.pageSha },
          { part: 'discovery', name: input.doc, bytes: input.docBytes, sha256: input.docSha },
        ],
        totalBytes: input.pageBytes + input.docBytes,
        maxBytes: 2 * 1024 * 1024,
      }
      const signedOut = { ok: false, reason: 'signed-out', message: 'Sign in to Flow to share this page.' }
      const channels = [
        'share:get',
        'share:check',
        'share:publish',
        'share:update',
        'share:revoke',
        'share:views',
        'auth:whoAmI',
        'auth:available',
        'auth:signIn',
      ]
      for (const channel of channels) ipcMain.removeHandler(channel)
      ipcMain.handle('auth:available', () => true)
      ipcMain.handle('auth:whoAmI', () => (g.__signedIn ? { subject: 'github|42', displayName: 'Ada Lovelace' } : null))
      ipcMain.handle('auth:signIn', () => {
        record('auth:signIn', {})
        g.__signedIn = true
        tellEveryWindow('signed-in')
        return { ok: true, subject: 'github|42', displayName: 'Ada Lovelace' }
      })
      const getOrCheck = (channel: string) => (_event: unknown, request: unknown) => {
        record(channel, request)
        return g.__signedIn ? { ok: true, share: null, local } : signedOut
      }
      ipcMain.handle('share:get', getOrCheck('share:get'))
      ipcMain.handle('share:check', getOrCheck('share:check'))
      // The rotated secret: the stored token is presented and refused. Main
      // clears the identity and tells every window — as the real wiring does.
      ipcMain.handle('share:publish', (_event, request) => {
        record('share:publish', request)
        g.__signedIn = false
        tellEveryWindow('session-rejected')
        return {
          ok: false,
          reason: 'unauthenticated',
          message: 'Your Flow sign-in is no longer valid. Sign in again to share.',
        }
      })
      for (const channel of ['share:update', 'share:revoke', 'share:views']) {
        ipcMain.handle(channel, (_event, request) => {
          record(channel, request)
          return signedOut
        })
      }
    },
    {
      slug: SLUG,
      title: TITLE,
      page: PAGE,
      doc: DOC,
      pageBytes: PAGE_BYTES,
      docBytes: DOC_BYTES,
      pageSha: PAGE_SHA,
      docSha: DOC_SHA,
      pageModifiedAt: PAGE_MODIFIED_AT,
    },
  )
}

test('a refused sign-in signs the whole app out, and signing in from Share picks up where it was', async ({
  app,
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

  const root = await seedProject(window)
  await activateProject(window, root)
  await waitForWorkspaceLink(root)
  const discoveryDir = join(root, 'flow', 'discovery')
  mkdirSync(discoveryDir, { recursive: true })
  writeFileSync(join(discoveryDir, DOC), DOC_MD)
  writeFileSync(join(discoveryDir, PAGE), PAGE_HTML)

  await stubRejectingAuth(app)

  // Settings names the person first — POSITIVE before the absence below.
  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
  const settingsPage = window.locator('.fl-settings-page')
  await expect(settingsPage).toBeVisible({ timeout: 15_000 })
  const appTab = window.locator('.fl-settings-tab', { hasText: 'App' })
  await expect(appTab).toBeVisible({ timeout: 15_000 })
  if ((await appTab.getAttribute('aria-selected')) !== 'true') await appTab.click()
  const who = settingsPage.locator('.fl-settings-account-identity')
  await expect(who).toHaveText('Ada Lovelace', { timeout: 15_000 })

  await window.evaluate(
    (detail) => {
      document.dispatchEvent(new CustomEvent('flow:open-feature-view', { detail }))
    },
    { rootPath: root, path: `flow/discovery/${PAGE}`, slug: SLUG, title: TITLE },
  )
  const view = window.locator('.fl-feature-view').filter({ hasText: TITLE })
  await expect(view).toBeVisible({ timeout: 15_000 })
  const button = view.locator('.fl-feature-share-btn')
  await expect(button).toHaveText('Share', { timeout: 15_000 })
  await button.click()

  const dialog = window.locator('.fl-share-dialog[role="dialog"]')
  await expect(dialog).toBeVisible()
  const people = dialog.locator('input.fl-share-chip-input[type="email"]')
  await people.fill(EMAIL)
  await people.press('Enter')
  await dialog.locator('.fl-share-confirm').click()

  // The host refused the session: the dialog says so in plain words…
  await expect(dialog.locator('.fl-share-message')).toHaveText(
    'Your Flow sign-in is no longer valid. Sign in again to share.',
    { timeout: 15_000 },
  )
  expect((await shareCalls(app)).filter((c) => c.channel === 'share:publish')).toHaveLength(1)
  await window.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // …the button asks to sign in…
  await expect(button).toHaveText('Sign in to share', { timeout: 15_000 })
  await expect(button).toBeEnabled()
  // …and Settings, which was already open, no longer names anybody — it heard
  // the same broadcast and re-read who is signed in.
  await expect(who).toHaveCount(0, { timeout: 15_000 })
  await expect(settingsPage.locator('button', { hasText: 'Sign in with GitHub' })).toHaveCount(1)
  expect(await app.evaluate(() => (globalThis as unknown as { __signedIn?: boolean }).__signedIn)).toBe(false)

  // Signing in from the Share button reopens the Share dialog — and publishes
  // nothing on its own.
  await button.click()
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await expect(dialog.locator('.fl-share-title')).toHaveText('Share this artifact')
  await expect(button).toHaveText('Share')
  const calls = await shareCalls(app)
  expect(calls.filter((c) => c.channel === 'auth:signIn')).toHaveLength(1)
  expect(calls.filter((c) => c.channel === 'share:publish')).toHaveLength(1)

  expect(errors).toEqual([])
})
