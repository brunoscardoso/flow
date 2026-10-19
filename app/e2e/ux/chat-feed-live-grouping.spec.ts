import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * A LIVE RUN OF COMMANDS GROUPS WHILE IT IS STILL RUNNING.
 *
 * Reported with a screenshot (2026-09-08): "still seeing bash runs" — three
 * consecutive `Bash` cards, no prose between them, on a turn that was still
 * in flight. The same turn folded correctly the moment it settled, which made
 * it look like the fold simply ignored live turns.
 *
 * It did not. The runtime opens a new assistant block for every tool round, so
 * a three-command turn emits three `message-start`s — most carrying no prose.
 * The pane appended an assistant wrapper on every one of them, and an EMPTY
 * wrapper is invisible to a reader but is still the feed's last child, which is
 * what the live fold reads to decide whether a run continues. Every run was
 * broken by a node with nothing in it.
 *
 * The reconcile never showed it, because a text-less block is not persisted.
 *
 * Since plan_chat-cleanup the per-turn fold this guards is BALANCED; Compact
 * folds the whole request into one live row instead. Both are driven below.
 */

/** Drive a live turn exactly as the bridge does: a new assistant block per
 *  tool round, none of them producing text, three commands in a row. */
async function streamThreeCommands(app: any, threadId: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }: any, id: string) => {
    const w = BrowserWindow.getAllWindows()[0]
    const send = (e: unknown): void => w?.webContents.send('threads:stream', e)
    send({ kind: 'status', threadId: id, status: 'working' })
    for (let i = 0; i < 3; i += 1) {
      send({ kind: 'message-start', threadId: id, messageId: `m${i}` })
      send({
        kind: 'tool-start',
        threadId: id,
        toolCall: {
          id: `c${i}`,
          threadId: id,
          messageId: `m${i}`,
          toolName: 'Bash',
          inputJson: JSON.stringify({ command: `git log --oneline -${i + 1}` }),
          outputJson: null,
          status: 'running',
          startedAt: new Date().toISOString(),
          completedAt: null,
        },
      })
    }
  }, threadId)
}

/** Open a thread by its title (the list-row selector finds a row whose list
 *  then empties in this harness). */
async function openLiveThread(window: any, title: string): Promise<string> {
  const root = await seedProject(window, 'orbit-app-')
  await activateProject(window, root)
  const threadId: string = await window.evaluate(async ({ r, t }: { r: string; t: string }) => {
    const created = await (window as any).flow.threads.create({ projectRoot: r, title: t })
    return created.id
  }, { r: root, t: title })
  await window.waitForTimeout(1200)
  await window.getByText(title, { exact: true }).first().click()
  await window.waitForTimeout(800)
  return threadId
}

test('Compact: a live run of commands is one live row, no empty bubble', async ({ app, window }) => {
  test.setTimeout(180_000)
  try {
    const threadId = await openLiveThread(window, 'Live run compact')
    await streamThreeCommands(app, threadId)
    await window.waitForTimeout(900)

    const rows = window.locator('.fl-request-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toHaveClass(/live/)
    await expect(rows.first().locator('.fl-request-row-header')).toContainText('3 tools')
    await expect(window.locator('.fl-conv-entry-turn')).toHaveCount(0)
    // No empty assistant bubble was left standing between the tool calls.
    await expect(window.locator('.fl-conv-entry-assistant')).toHaveCount(0)
  } finally {
    cleanupSeeds()
  }
})

test('Balanced: consecutive commands group while the turn is still live', async ({ app, window }) => {
  test.setTimeout(180_000)
  try {
    // Balanced through the control a person uses.
    await window.locator('.fl-titlebar-icon[aria-label="Settings"]').click()
    await window.locator('.fl-settings-tab', { hasText: 'App' }).click()
    await window.locator('select[aria-label="Conversation density"]').selectOption('balanced')
    await window.keyboard.press('Escape')
    const threadId = await openLiveThread(window, 'Live run')
    await streamThreeCommands(app, threadId)
    await window.waitForTimeout(900)

    // One group, not three loose cards.
    // ONE ROW FOR A TURN THAT IS STILL RUNNING. The live turn folds exactly
    // like a finished one — the count climbs as tools land, and the commands
    // still group one level down.
    await expect(window.locator('.fl-conv-entry-turn')).toHaveCount(1)
    await expect(window.locator('.fl-turn-row-label')).toHaveText('Ran 3 tools')
    await expect(window.locator('.fl-tool-group-label')).toHaveText(/Ran 3 commands/)
    // No empty assistant bubble was left standing between the tool calls.
    await expect(window.locator('.fl-conv-entry-assistant')).toHaveCount(0)
    // …and the feed still MOVES. The loader used to be suppressed on the
    // grounds that "the tool card is its own running indicator" — true until
    // the cards were folded away, after which a folded turn plus a hidden
    // loader meant nothing on screen moved at all while the agent worked.
    const activity = await window.evaluate(() => {
      const el = document.querySelector('.fl-conv-activity') as HTMLElement | null
      return el === null ? null : !el.hidden
    })
    expect(activity).toBe(true)

  } finally {
    cleanupSeeds()
  }
})
