import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { ElectronApplication, Page } from '@playwright/test'

/**
 * UX sweep — flow 8 (Terminal): the links a COMMAND prints.
 *
 * Terminal is the most-swept flow in the rotation (29 committed specs across 19
 * rounds: open/run/close, tabs, rename, overflow, cwd-follow, scoping, theme,
 * exit recovery, resize/reflow, panel height, control-key steal, background
 * drain, popup affordances). Every one of them drives a control the PANEL owns —
 * a button, a key, a tab, the gutter. None asks what happens to the text the
 * shell writes into it, which is where a developer's clicks actually go: the dev
 * server URL, the stack-trace path, the `gh`/`vitest` hyperlink.
 *
 * What this panel does with that text:
 *
 *   - An **OSC 8 hyperlink** (the standard escape `gh`, `vitest`, `ls
 *     --hyperlink` and friends emit) is rendered by xterm as underlined text and
 *     hovering it puts `xterm-cursor-pointer` on the screen — a real hand cursor.
 *     Clicking it does nothing: `shell.openExternal` is never called, no window
 *     opens, no error, no console warning. Plain, ⌘, ⌃ and ⌥ clicks were all
 *     driven; all four are inert. `terminal-panel.ts` constructs
 *     `new Terminal({ theme, fontFamily, fontSize, scrollback, cursorBlink })` —
 *     it never sets xterm's `linkHandler` and registers no link provider, and
 *     xterm's fallback activation goes through `window.open()`, which this window
 *     denies (`setWindowOpenHandler` → `openExternal` + `deny`, main/index.ts:204).
 *   - A **bare URL** or a **file path** printed by a command gets no treatment at
 *     all: zero anchors, `cursor: text`, nothing on click.
 *
 * The contrast is the same app, 200px away: the chat transcript turns a bare URL
 * into a real external anchor (#1127) and a backticked file path into an
 * `.fl-md-file` chip that opens the file in the editor (#656). Live guard 1 below
 * pins the URL route all the way to the OS (`shell.openExternal` receives it) —
 * the plumbing a terminal fix would reuse.
 *
 * Live guards (the healthy behaviour these protect):
 *   1. a bare URL in the transcript reaches `shell.openExternal` on click,
 *   2. terminal text is at least copy/paste-able — a drag selection + ⌘C lands on
 *      the system clipboard and ⌘V puts it back on the prompt. That round trip is
 *      the ONLY way to act on a URL the terminal printed today, so it must not
 *      regress while the link routes are missing (verified by hand in round 19,
 *      never guarded).
 *
 * The `test.fixme` blocks are fix-agnostic tripwires for #1190: they assert the
 * user-facing outcome (the link opens), not any particular API.
 */

const SCREENS = 'e2e/ux/__screens'

const activeHost = (win: Page) => win.locator('.fl-term-host:not([hidden])')
const activeRows = (win: Page) => activeHost(win).locator('.xterm-rows')

/** Record every URL handed to the OS instead of really opening a browser. */
async function spyOpenExternal(app: ElectronApplication): Promise<() => Promise<string[]>> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __openedUrls: string[] }
    g.__openedUrls = []
    shell.openExternal = async (url: string) => {
      g.__openedUrls.push(url)
    }
  })
  return () => app.evaluate(() => (globalThis as unknown as { __openedUrls: string[] }).__openedUrls)
}

async function revealTerminal(win: Page): Promise<void> {
  // ⌃` TOGGLES — press it only when the panel is genuinely absent (#674 docked default).
  if ((await win.locator(sel.terminalRoot).count()) === 0) {
    await win.keyboard.press('Control+`')
  }
  await expect(win.locator(sel.terminalRoot)).toBeVisible()
}

/** Wait for a real shell PROMPT, not merely the first byte: typing before zsh's
 *  ZLE starts is echoed by the tty line discipline and looks like duplicated output. */
async function waitPrompt(win: Page): Promise<void> {
  await expect(win.locator('.fl-term-host:not([hidden]) .xterm').first()).toBeVisible({
    timeout: 20000,
  })
  await expect
    .poll(async () => (await activeRows(win).innerText()) ?? '', { timeout: 25000 })
    .toMatch(/(?:[$%#>]\s*$)|(?:➜[^\n]*$)/m) // any shell prompt, not one machine's theme
}

async function typeInShell(win: Page, text: string): Promise<void> {
  await activeHost(win).click()
  await expect(win.locator('.fl-term-host:not([hidden]) .xterm-helper-textarea')).toBeFocused()
  await win.keyboard.type(text)
  await win.keyboard.press('Enter')
}

/**
 * Geometry of a substring inside the LAST row that contains it — the command
 * line the shell echoes back holds the same text, so the output row is the last.
 *
 * Measured INSIDE the xterm span that holds the text, never from the row: a row's
 * `innerText` is trimmed while its box spans the full column count, so
 * `rowWidth / textLength` misses the target by several characters. Within one
 * span the run is uniform, so `spanWidth / spanTextLength` is the true cell width.
 */
async function cellRect(
  win: Page,
  needle: string,
): Promise<{ x: number; y: number; left: number; right: number } | null> {
  return win.evaluate((n) => {
    const rows = [...document.querySelectorAll('.fl-term-host:not([hidden]) .xterm-rows > div')]
    const matches = rows.filter((r) => (r as HTMLElement).innerText.includes(n))
    const row = matches[matches.length - 1] as HTMLElement | undefined
    if (!row) return null
    const spans = [...row.querySelectorAll('span')] as HTMLElement[]
    const candidates: HTMLElement[] = spans.length > 0 ? spans : [row]
    for (const span of candidates) {
      const text = span.textContent ?? ''
      const start = text.indexOf(n)
      if (start < 0) continue
      const rect = span.getBoundingClientRect()
      const cell = rect.width / Math.max(text.length, 1)
      return {
        x: rect.x + (start + n.length / 2) * cell,
        y: rect.y + rect.height / 2,
        left: rect.x + start * cell,
        right: rect.x + (start + n.length) * cell,
      }
    }
    return null
  }, needle)
}

async function createThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) =>
      (
        (await (
          window as unknown as {
            flow: {
              threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> }
            }
          }
        ).flow.threads.create({ projectRoot: root, title })) as { id: string }
      ).id,
    { root, title },
  )
}

async function appendAssistant(win: Page, threadId: string, content: string): Promise<void> {
  await win.evaluate(
    async ({ threadId, content }) => {
      await (
        window as unknown as {
          flow: {
            messages: {
              append(i: { threadId: string; role: string; content: string }): Promise<unknown>
            }
          }
        }
      ).flow.messages.append({ threadId, role: 'assistant', content })
    },
    { threadId, content },
  )
}

const CHAT_URL = 'https://example.com/from-chat'
const URL_HEAD = 'https://example.com/'
const URL_TAIL = 'from-terminal'
const TERM_URL = `${URL_HEAD}${URL_TAIL}`

test.afterAll(() => cleanupSeeds())

test.describe('terminal — links in command output', () => {
  test('control: a bare URL in the transcript reaches shell.openExternal on click', async ({
    window: win,
    app,
  }) => {
    const opened = await spyOpenExternal(app)
    const dir = await seedProject(win, 'flow-term-link-chat-')
    await activateProject(win, dir)

    const id = await createThread(win, dir, 'Terminal link parity')
    await appendAssistant(win, id, `Dev server ready: ${CHAT_URL}`)
    await win.getByText('Terminal link parity', { exact: true }).first().click()
    await expect(win.locator(sel.conversation)).toBeVisible()

    const anchor = win.locator(`.fl-conv-feed a[href="${CHAT_URL}"]`)
    await expect(anchor, 'a bare URL in the transcript must be an anchor (#1127)').toHaveCount(1)
    await anchor.first().click()

    // All the way to the OS — the route a terminal link would reuse.
    await expect
      .poll(opened, { timeout: 5000 })
      .toContain(CHAT_URL)
    // Clicking must never navigate the app away (setWindowOpenHandler denies).
    expect(win.url()).not.toContain('example.com')
  })

  test('control: terminal text can be copied out and pasted back (⌘C / ⌘V)', async ({
    window: win,
    app,
  }) => {
    const dir = await seedProject(win, 'flow-term-link-copy-')
    await activateProject(win, dir)
    await revealTerminal(win)
    await waitPrompt(win)

    // Print the URL alone on its own line so the drag selects only the URL. The
    // shell ECHOES what you type, so the literal is assembled from a variable —
    // otherwise the echoed command line matches the search too and the probe can
    // measure it instead of the output (a race, not a product fact).
    await typeInShell(win, `T=${URL_TAIL}; printf '%s\\n' "${URL_HEAD}$T"`)
    await expect
      .poll(async () => (await activeRows(win).innerText()) ?? '', { timeout: 20000 })
      .toContain(TERM_URL)

    const rect = await cellRect(win, TERM_URL)
    expect(rect, 'the printed URL must be on screen').not.toBeNull()

    await app.evaluate(({ clipboard }) => clipboard.writeText('__flow_clipboard_seed__'))
    // Triple-click selects the whole output line (xterm line selection) — the
    // URL is alone on it, so this is the user's "grab that URL" gesture without
    // depending on per-character geometry.
    await win.mouse.click(rect!.left + 2, rect!.y, { clickCount: 3 })
    await win.keyboard.press('ControlOrMeta+c')
    await expect
      .poll(async () => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5000 })
      .toContain(TERM_URL)

    // ...and back in: ⌘V puts it on the prompt (bracketed paste keeps it unrun).
    await activeHost(win).click()
    await win.keyboard.press('ControlOrMeta+v')
    await expect
      .poll(
        async () => {
          const rows = (await activeRows(win).innerText()) ?? ''
          const promptLine = rows.split('\n').filter((l) => /(?:[$%#>]\s*$)|(?:➜[^\n]*$)/.test(l)).pop() ?? ''
          return promptLine
        },
        { timeout: 8000 },
      )
      .toContain(TERM_URL)
  })

  // ── Tripwires for the filed defect (fix-agnostic) ──────────────────────

  test(
    'an OSC 8 hyperlink printed by a command opens when clicked (#1190)',
    async ({ window: win, app }) => {
      const opened = await spyOpenExternal(app)
      const dir = await seedProject(win, 'flow-term-link-osc8-')
      await activateProject(win, dir)
      await revealTerminal(win)
      await waitPrompt(win)

      // `%sME` + $L so the echoed command line never contains "CLICKME" — only
      // the rendered hyperlink does (see the copy guard's note).
      await typeInShell(
        win,
        `L=CLICK; printf '\\033]8;;${TERM_URL}\\033\\\\%sME\\033]8;;\\033\\\\\\n' "$L"`,
      )
      await expect
        .poll(async () => (await activeRows(win).innerText()) ?? '', { timeout: 20000 })
        .toContain('CLICKME')

      const rect = await cellRect(win, 'CLICKME')
      expect(rect, 'the hyperlink label must be on screen').not.toBeNull()
      // Two-step move: xterm's linkifier reacts to mouse MOVEMENT across the
      // screen, so a single teleporting move can land before it has looked.
      await win.mouse.move(rect!.x - 8, rect!.y)
      await win.waitForTimeout(200)
      await win.mouse.move(rect!.x, rect!.y)
      await win.waitForTimeout(700)

      // The affordance the app already shows: a hand cursor over the link.
      const cursor = await win.evaluate(
        ({ x, y }) => {
          const el = document.elementFromPoint(x, y) as HTMLElement | null
          return el ? getComputedStyle(el).cursor : 'none'
        },
        { x: rect!.x, y: rect!.y },
      )
      expect(cursor, 'a hyperlink must look clickable').toBe('pointer')

      await win.mouse.click(rect!.x, rect!.y)
      await expect
        .poll(opened, { timeout: 5000 })
        .toContain(TERM_URL)
    },
  )

  test('a bare URL printed by a command is a link (#1190)', async ({ window: win, app }) => {
    const opened = await spyOpenExternal(app)
    const dir = await seedProject(win, 'flow-term-link-bare-')
    await activateProject(win, dir)
    await revealTerminal(win)
    await waitPrompt(win)

    await typeInShell(win, `T=${URL_TAIL}; printf 'Local: %s\\n' "${URL_HEAD}$T"`)
    await expect
      .poll(async () => (await activeRows(win).innerText()) ?? '', { timeout: 20000 })
      .toContain(TERM_URL)

    const rect = await cellRect(win, TERM_URL)
    expect(rect, 'the printed URL must be on screen').not.toBeNull()
    await win.mouse.move(rect!.x - 8, rect!.y)
    await win.waitForTimeout(200)
    await win.mouse.move(rect!.x, rect!.y)
    await win.waitForTimeout(700)
    const cursor = await win.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y) as HTMLElement | null
        return el ? getComputedStyle(el).cursor : 'none'
      },
      { x: rect!.x, y: rect!.y },
    )
    expect(cursor, 'a URL in command output must look clickable').toBe('pointer')

    await win.mouse.click(rect!.x, rect!.y)
    await expect
      .poll(opened, { timeout: 5000 })
      .toContain(TERM_URL)
    await win.screenshot({ path: `${SCREENS}/terminal-output-links.png` })
  })
})
