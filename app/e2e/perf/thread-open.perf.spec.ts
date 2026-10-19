/**
 * Opening a long thread, and typing into one.
 *
 * The reported symptom in the surface where it was reported: a session with
 * hundreds of tool calls, a click on it, then a cursor that spins. Each stage
 * is timed separately, because "opening a thread" is three different costs
 * wearing one name — the IPC read, the DOM the renderer writes, and whether the
 * thread is still responsive once it is on screen.
 */
import { test, expect } from '@playwright/test'

import {
  close,
  dismissOnboarding,
  ensurePerfRepo,
  freshUserData,
  launch,
  printTable,
  seedHeavyThread,
  slowLines,
} from './launch'

/** The heaviest session in the reporter's own profile is 1,789 calls; this is
 *  that, rounded up, with outputs the size the measurements found. */
const TOOL_CALLS = 1_800
const MESSAGES = 1_200

test('open a 1,800-call thread and type in it', async () => {
  test.setTimeout(900_000)
  const repo = ensurePerfRepo()
  const userData = freshUserData('thread')

  let threadTitle = 'The heaviest session'
  {
    const first = await launch(userData)
    await dismissOnboarding(first.window)
    const threadId = await first.window.evaluate(
      async ({ path, messages, title }: { path: string; messages: number; title: string }) => {
        const flow = (window as unknown as { flow: Record<string, any> }).flow
        await flow.project.add({ path })
        const roots = (await flow.project.list()) as Array<{ rootPath: string }>
        const canonical = roots.at(-1)?.rootPath ?? path
        await flow.project.setActive({ rootPath: canonical })
        const thread = await flow.threads.create({ projectRoot: canonical, title })
        for (let i = 0; i < messages; i += 1) {
          await flow.messages.append({
            threadId: thread.id,
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `turn ${String(i)} — ${'lorem ipsum dolor sit amet '.repeat(15)}`,
          })
        }
        return thread.id
      },
      { path: repo, messages: MESSAGES, title: threadTitle },
    )
    await first.window.waitForTimeout(20_000)
    await close(first.app)
    seedHeavyThread(userData, threadId, TOOL_CALLS)
  }

  const { app, window } = await launch(userData)
  await dismissOnboarding(window)
  const marks: Record<string, number | string> = {}

  const row = window.locator('.fl-thread-sidebar .row', { hasText: threadTitle }).first()
  await row.waitFor({ timeout: 120_000 })

  // 1. THE READ. What the renderer waits on before it can draw anything.
  const readMs = (await window.evaluate(async (title: string) => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    const threads = (await flow.threads.list({ includeArchived: true })) as Array<{
      id: string
      title: string
    }>
    const target = threads.find((t) => t.title === title)
    if (!target) throw new Error('seeded thread not found')
    // EXACTLY WHAT THE PANE DOES: a bounded message window, then the tool
    // calls that window covers. The unbounded reads are measured beside it,
    // because the difference is the point.
    const started = performance.now()
    const detail = await flow.threads.get({ threadId: target.id })
    const messages = (await flow.messages.list({ threadId: target.id, limit: 200 })) as Array<{
      createdAt: string
    }>
    const calls = await flow.toolCalls.list({
      threadId: target.id,
      outputLimit: 60,
      since: messages[0]?.createdAt,
      atLeast: 250,
    })
    const size = (value: unknown): number =>
      new TextEncoder().encode(JSON.stringify(value ?? null)).length
    return {
      ms: performance.now() - started,
      detailBytes: size(detail),
      messagesBytes: size(messages),
      callsBytes: size(calls),
      // What the composer asks for on EVERY thread-entity event during a
      // streaming turn — dozens of times a minute — to read three fields.
      wholeMessagesBytes: size(await flow.messages.list({ threadId: target.id })),
      wholeCallsBytes: size(await flow.toolCalls.list({ threadId: target.id, outputLimit: 60 })),
      repeatMs: await (async () => {
        const at = performance.now()
        for (let i = 0; i < 10; i += 1) await flow.threads.get({ threadId: target.id })
        return (performance.now() - at) / 10
      })(),
    }
  }, threadTitle)) as {
    ms: number
    detailBytes: number
    messagesBytes: number
    callsBytes: number
    wholeMessagesBytes: number
    wholeCallsBytes: number
    repeatMs: number
  }
  marks['the reads (IPC)'] = readMs.ms
  marks['threads:get payload'] = `${(readMs.detailBytes / 1024).toFixed(0)} KB`
  marks['messages:list (window)'] = `${(readMs.messagesBytes / 1024).toFixed(0)} KB`
  marks['toolCalls:list (window)'] = `${(readMs.callsBytes / 1024).toFixed(0)} KB`
  marks['messages:list (whole)'] = `${(readMs.wholeMessagesBytes / 1024).toFixed(0)} KB`
  marks['toolCalls:list (whole)'] = `${(readMs.wholeCallsBytes / 1024).toFixed(0)} KB`
  marks['threads:get, repeated'] = readMs.repeatMs

  // 2. THE DRAW. Click to a mounted conversation.
  const clickedAt = Date.now()
  await row.click()
  await window.locator('.fl-composer-input textarea').first().waitFor({ state: 'visible', timeout: 120_000 })
  marks['click → composer on screen'] = Date.now() - clickedAt

  // 3. STILL RESPONSIVE? The press that was reported as slow, made after the
  // heavy thing is already on screen.
  const composer = window.locator('.fl-composer-input textarea').first()
  await composer.click()
  const typedAt = Date.now()
  await composer.press('a')
  await expect(composer).toHaveValue(/a/, { timeout: 30_000 })
  marks['keystroke → on screen'] = Date.now() - typedAt

  // 4. AND WHILE SCROLLING — the other thing hands do in a long transcript.
  const scrollStarted = Date.now()
  await window.mouse.move(700, 400)
  for (let i = 0; i < 20; i += 1) await window.mouse.wheel(0, -600)
  await window.waitForTimeout(500)
  marks['20 wheel scrolls'] = Date.now() - scrollStarted

  // What the DOM actually holds once a 1,800-call thread is mounted.
  const dom = await window.evaluate(() => ({
    nodes: document.querySelectorAll('*').length,
    cards: document.querySelectorAll('.fl-tool-call, .fl-msg, .fl-message').length,
  }))
  marks['DOM nodes in the window'] = dom.nodes
  marks['cards mounted'] = dom.cards

  await window.waitForTimeout(1_500)
  printTable(`thread with ${String(TOOL_CALLS)} tool calls`, marks)
  for (const line of slowLines(userData).slice(-18)) console.log(`  ${line}`)

  await close(app)
  expect(marks['keystroke → on screen']).toBeGreaterThan(0)
})
