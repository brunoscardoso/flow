import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, openEmptyThread } from './fixtures/seed'

test('a thread waiting on background agents shows it in the list and the chat', async ({
  app,
  window,
}) => {
  test.setTimeout(180_000)
  try {
    const root = await seedProject(window, 'orbit-app-')
    await activateProject(window, root)
    // Opened the way a person opens it, and only then fed the event: a fixed
    // wait after a click raced the thread list's first paint under load, and
    // the stream event then landed on no selected thread.
    const threadId = await openEmptyThread(window, root, 'Large PR multi-agent review started')

    // Push a real `background-tasks` stream event from MAIN, exactly as the
    // stream bridge does — the renderer's own contextBridge cannot be poked.
    await app.evaluate(({ BrowserWindow }, id) => {
      const win = BrowserWindow.getAllWindows()[0]
      win?.webContents.send('threads:stream', {
        kind: 'background-tasks',
        threadId: id,
        tasks: [
          { id: 'bg1', taskType: 'subagent', description: 'security review pass',
            agentType: 'general-purpose', lastTool: 'Grep', elapsedMs: 21000,
            startedAt: new Date().toISOString() },
          { id: 'bg2', taskType: 'subagent', description: 'performance review pass',
            agentType: 'general-purpose', elapsedMs: 4000,
            startedAt: new Date().toISOString() },
        ],
      })
    }, threadId)
    await expect
      .poll(() =>
        window.evaluate(() =>
          Array.from(
            document.querySelector('.fl-thread-list fl-list')?.shadowRoot?.querySelectorAll('.row') ?? [],
          ).length,
        ),
      )
      .toBe(3)

    const rows = await window.evaluate(() => {
      const list = document.querySelector('.fl-thread-list fl-list')
      return Array.from(list?.shadowRoot?.querySelectorAll('.row') ?? []).map((r) => ({
        text: (r.textContent ?? '').trim(),
        h: Math.round(r.getBoundingClientRect().height),
      }))
    })
    // THE SIDEBAR: a row per agent, nested under the thread that started them,
    // each naming the agent and how long it has been at it.
    const nested = rows.filter((row) => row.h < 28)
    expect(nested.map((row) => row.text)).toEqual([
      'security review pass21s',
      'performance review pass4s',
    ])

    // …and the thread's own row reads as alive, though its TURN never ran. This
    // is the whole report: status said resting, so nothing was drawn.
    const parentGlyph = await window.evaluate(() => {
      const list = document.querySelector('.fl-thread-list fl-list')
      const row = Array.from(list?.shadowRoot?.querySelectorAll('.row') ?? []).find((candidate) =>
        (candidate.textContent ?? '').includes('Large PR'),
      )
      return row?.querySelector('fl-icon')?.getAttribute('name') ?? '(none)'
    })
    expect(parentGlyph).toBe('message')

    // THE CHAT: a standing note that an answer is still coming, on a thread
    // whose composer is free.
    const activity = await window.evaluate(() => {
      const el = document.querySelector('.fl-conv-activity') as HTMLElement | null
      return {
        shown: el !== null && !el.hidden,
        label: document.querySelector('.fl-conv-activity-label')?.textContent ?? '',
      }
    })
    expect(activity).toEqual({ shown: true, label: '2 agents running in the background' })

    // TWO SAME-TYPE AGENTS ARE TWO DIFFERENT ROWS. Both are `general-purpose`
    // here, which is what people actually run — labelling by type rendered
    // eight identical rows and looked like the list had duplicated itself.
    const labels = nested.map((row) => row.text)
    expect(new Set(labels).size).toBe(labels.length)

    // AND THEY CANNOT BE PUT AWAY while they run. The thread row's one
    // disclosure folds FINISHED sub-agents only (`#childrenToggle`): a running
    // row is the only trace of running work, so a live-only nest carries no
    // chevron. The row itself is found first, so the absence is about the
    // control and not about a row that was never there.
    const parentRow = window.locator('.fl-thread-list fl-list .row', { hasText: 'Large PR' }).first()
    await expect(parentRow).toBeVisible()
    await expect(parentRow.locator('.fl-children-toggle')).toHaveCount(0)

    // AND IT ALL GOES AWAY when the runtime reports the set empty — the level
    // signal exists precisely so a spinner cannot outlive its work.
    await app.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('threads:stream', {
        kind: 'background-tasks',
        threadId: id,
        tasks: [],
      })
    }, threadId)
    await expect
      .poll(async () =>
        window.evaluate(() => {
          const list = document.querySelector('.fl-thread-list fl-list')
          return Array.from(list?.shadowRoot?.querySelectorAll('.row') ?? []).filter(
            (row) => Math.round(row.getBoundingClientRect().height) < 28,
          ).length
        }),
      )
      .toBe(0)
  } finally {
    cleanupSeeds()
  }
})
