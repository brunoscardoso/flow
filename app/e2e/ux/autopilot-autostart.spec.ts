/**
 * AUTOPILOT ON → THE FIRST MESSAGE STARTS A CHAIN.
 *
 * This is the bug this spec exists for (user, 2026-09-23: "even with the
 * autopilot on on the ide, we are still not calling automatically the next
 * command"). `flow:chain` accepted `run: true` from the day it shipped and
 * nothing ever sent it, so the project key gated a request nobody made.
 *
 * A unit test cannot show this: every piece was already correct on its own, and
 * what was missing was that nothing called them. So this drives the real path —
 * a real project with autopilot on, a real thread, a real message — and asks
 * main what the chain is doing afterwards.
 */
import { test, expect } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

test.afterAll(() => cleanupSeeds())

/** A project whose flow config has autopilot on. */
async function seedAutopilotProject(window: import('@playwright/test').Page, on: boolean) {
  const root = await seedProject(window, 'flow-auto-', (dir) => {
    execFileSync('git', ['config', 'user.email', 'e2e@flow.test'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Flow E2E'], { cwd: dir })
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'base'], { cwd: dir })
    mkdirSync(join(dir, 'flow'), { recursive: true })
    writeFileSync(join(dir, 'flow', '.flowconfig'), `autopilot: ${on}\ncommit: false\npush: false\n`)
  })
  await activateProject(window, root)
  return root
}

async function chainOf(window: import('@playwright/test').Page, threadId: string) {
  return (await window.evaluate(
    async (id: string) => (window as unknown as { flow: any }).flow.flow.chain({ threadId: id }),
    threadId,
  )) as { running: boolean; step: string | null }
}

test('the first message starts a chain when autopilot is on', async ({ window }) => {
  test.setTimeout(240_000)
  const root = await seedAutopilotProject(window, true)

  const threadId = (await window.evaluate(
    async (projectRoot: string) =>
      (await (window as unknown as { flow: any }).flow.threads.create({
        projectRoot,
        title: 'autopilot autostart',
      })).id,
    root,
  )) as string

  // POSITIVE BEFORE ABSENCE: nothing is driving it before the message.
  expect((await chainOf(window, threadId)).running).toBe(false)

  await window.evaluate(
    async (id: string) =>
      (window as unknown as { flow: any }).flow.threads.sendMessage({
        threadId: id,
        content: 'add a dark mode toggle to the settings page',
      }),
    threadId,
  )

  // THE CLAIM. Before this change the answer here was `false` for ever.
  await expect
    .poll(async () => (await chainOf(window, threadId)).running, { timeout: 60_000 })
    .toBe(true)
})

test('an autopilot-off project is untouched', async ({ window }) => {
  test.setTimeout(240_000)
  const root = await seedAutopilotProject(window, false)
  const threadId = (await window.evaluate(
    async (projectRoot: string) =>
      (await (window as unknown as { flow: any }).flow.threads.create({
        projectRoot,
        title: 'autopilot off',
      })).id,
    root,
  )) as string

  await window.evaluate(
    async (id: string) =>
      (window as unknown as { flow: any }).flow.threads.sendMessage({
        threadId: id,
        content: 'add a dark mode toggle to the settings page',
      }),
    threadId,
  )
  await window.waitForTimeout(6000)
  // The key is the consent. With it off, `begin()` refuses and the message is
  // sent as an ordinary turn — which is exactly what happened before autopilot
  // could start anything at all.
  expect((await chainOf(window, threadId)).running).toBe(false)
})

test('a first message with a file is sent normally, never silently stripped', async ({
  window,
}) => {
  test.setTimeout(240_000)
  const root = await seedAutopilotProject(window, true)
  const threadId = (await window.evaluate(
    async (projectRoot: string) =>
      (await (window as unknown as { flow: any }).flow.threads.create({
        projectRoot,
        title: 'autopilot with an attachment',
      })).id,
    root,
  )) as string

  await window.evaluate(
    async (id: string) =>
      (window as unknown as { flow: any }).flow.threads.sendMessage({
        threadId: id,
        content: 'make it look like this',
        attachments: [
          {
            id: 'att-1',
            mediaType: 'image/png',
            fileName: 'shot.png',
            byteSize: 68,
            // A 1x1 PNG.
            dataBase64:
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          },
        ],
      }),
    threadId,
  )
  await window.waitForTimeout(5000)

  // NO CHAIN — because a chain takes the message instead of sending it, and its
  // first rung carries no files. Chaining here would lose the screenshot
  // silently, which is worse than not chaining.
  expect((await chainOf(window, threadId)).running).toBe(false)

  // POSITIVE BEFORE ABSENCE: the message itself really did go through, so the
  // absence above is "not chained" rather than "nothing happened at all".
  const messages = (await window.evaluate(
    async (id: string) => (window as unknown as { flow: any }).flow.messages.list({ threadId: id }),
    threadId,
  )) as unknown[]
  expect(messages.length).toBeGreaterThan(0)
})
