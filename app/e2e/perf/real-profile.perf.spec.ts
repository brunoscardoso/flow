/**
 * The app, against a COPY of the reporter's own profile.
 *
 * Every other probe builds a worst case out of synthetic parts. This one uses
 * the real thing: 122 threads, 21,745 messages, 5,509 tool calls, four projects
 * — the state the complaint was actually made about. Copied, never opened in
 * place: the app under test writes to the copy and nothing else.
 *
 * Skipped unless FLOW_REAL_PROFILE names a directory holding a `flow.db`.
 * Nothing here leaves the machine.
 */
import { test, expect } from '@playwright/test'
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { close, dismissOnboarding, freshUserData, launch, printTable, slowLines } from './launch'

const SOURCE = process.env['FLOW_REAL_PROFILE'] ?? ''

test('a real profile: launch, list, open the biggest thread', async () => {
  test.setTimeout(900_000)
  test.skip(SOURCE === '' || !existsSync(join(SOURCE, 'flow.db')), 'set FLOW_REAL_PROFILE')
  const userData = freshUserData('real')
  copyFileSync(join(SOURCE, 'flow.db'), join(userData, 'flow.db'))

  const launchStarted = Date.now()
  const { app, window, launchMs } = await launch(userData)
  await dismissOnboarding(window)
  const marks: Record<string, number | string> = { 'launch → window': launchMs }

  // The sidebar's first useful paint: rows for real threads.
  const firstRow = window.locator('.fl-thread-sidebar .row').first()
  await firstRow.waitFor({ timeout: 120_000 })
  marks['launch → a thread list'] = Date.now() - launchStarted

  const counts = await window.evaluate(async () => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    const started = performance.now()
    const threads = (await flow.threads.list({ includeArchived: true })) as Array<{
      id: string
      title: string
    }>
    const listMs = performance.now() - started
    // The heaviest thread in the profile — the one worth opening.
    let biggest = { id: '', title: '', calls: 0 }
    for (const thread of threads.slice(0, 40)) {
      const calls = (await flow.toolCalls.list({ threadId: thread.id, outputLimit: 1 })) as unknown[]
      if (calls.length > biggest.calls) {
        biggest = { id: thread.id, title: thread.title, calls: calls.length }
      }
    }
    return { threads: threads.length, listMs, biggest }
  })
  marks['threads:list'] = counts.listMs
  marks['threads in the profile'] = counts.threads
  marks['biggest thread scanned'] = `${counts.biggest.calls} calls`

  if (counts.biggest.id !== '') {
    const openStarted = Date.now()
    const reads = await window.evaluate(async (id: string) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      const started = performance.now()
      const messages = (await flow.messages.list({ threadId: id, limit: 200 })) as Array<{
        createdAt: string
      }>
      const calls = await flow.toolCalls.list({
        threadId: id,
        outputLimit: 60,
        since: messages[0]?.createdAt,
        atLeast: 250,
      })
      const size = (value: unknown): number =>
        new TextEncoder().encode(JSON.stringify(value ?? null)).length
      return { ms: performance.now() - started, bytes: size(messages) + size(calls) }
    }, counts.biggest.id)
    marks['the reads for that thread'] = reads.ms
    marks['what crossed IPC'] = `${(reads.bytes / 1024).toFixed(0)} KB`

    // Opened the way every other surface opens one (the board's cards, the
    // palette): the same dispatch a click ends in, without depending on the row
    // being scrolled into view in a 122-thread sidebar.
    await window.evaluate((id: string) => {
      document.dispatchEvent(new CustomEvent('flow:open-thread', { detail: { threadId: id } }))
    }, counts.biggest.id)
    try {
      // Two things legitimately cover the composer in a profile like this: a
      // project with no .flowconfig auto-opens flow settings, and a version
      // change opens the release notes ("What's new"). Both are real, both are
      // dismissed by a person in a second, and neither is what this times.
      for (const selector of ['.fl-relnotes-overlay', '.fl-settings-overlay']) {
        const overlay = window.locator(`${selector}:not([hidden])`)
        if ((await overlay.count()) === 0) continue
        const closer = overlay.locator('button', { hasText: /close|got it|dismiss|skip/i })
        if ((await closer.count()) > 0) await closer.first().click().catch(() => undefined)
        else await window.keyboard.press('Escape')
      }
      await window.keyboard.press('Escape')
      await window
        .locator('.fl-composer-input textarea')
        .first()
        .waitFor({ state: 'visible', timeout: 120_000 })
      marks['open → the thread on screen'] = Date.now() - openStarted

      const composer = window.locator('.fl-composer-input textarea').first()
      // What is in the way, if anything — a probe that cannot click should say
      // why rather than report a timeout nobody can act on.
      const blocker = await window.evaluate(() => {
        const box = document.querySelector('.fl-composer-input textarea')?.getBoundingClientRect()
        if (!box) return 'no composer'
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return top === null ? 'nothing' : `${top.tagName.toLowerCase()}.${String(top.className).slice(0, 60)}`
      })
      marks['what covers the composer'] = String(blocker)
      await composer.click({ timeout: 20_000 })
      const typedAt = Date.now()
      await composer.press('h')
      await expect(composer).toHaveValue(/h/, { timeout: 30_000 })
      marks['keystroke → on screen'] = Date.now() - typedAt
    } catch (error) {
      marks['open → the thread on screen'] = `never opened (${String(error).slice(0, 60)})`
    }
  }

  // SWITCHING PROJECTS — the other thing a person with four of them does all
  // day. Every surface rebinds: threads, git, blueprint, tasks, terminals.
  const rootPaths = (await window.evaluate(async () => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    return ((await flow.project.list()) as Array<{ rootPath: string }>).map((r) => r.rootPath)
  })) as string[]
  if (rootPaths.length > 1) {
    for (const [index, target] of rootPaths.slice(0, 3).entries()) {
      const switchedAt = Date.now()
      await window.evaluate(async (rootPath: string) => {
        const flow = (window as unknown as { flow: Record<string, any> }).flow
        await flow.project.setActive({ rootPath })
      }, target)
      // Settled when the git panel has this root's status on screen again.
      await window.waitForTimeout(50)
      await window
        .locator('.gp-root, .fl-sidebar-pane')
        .first()
        .waitFor({ state: 'visible', timeout: 60_000 })
        .catch(() => undefined)
      marks[`switch to project ${String(index + 1)}`] = Date.now() - switchedAt
    }
  }

  await window.waitForTimeout(2_000)
  printTable("the reporter's own profile", marks)
  for (const line of slowLines(userData).slice(-20)) console.log(`  ${line}`)

  await close(app)
  expect(counts.threads).toBeGreaterThan(0)
})
