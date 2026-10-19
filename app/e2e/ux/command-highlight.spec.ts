import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * Commands and @-files highlighted wherever you type or read them (mockup
 * variant B: code look, accent blue for commands, neutral grey
 * for files (the user turned down the violet), soft ground).
 *
 *  - the composer input WHILE TYPING: a mirror behind the textarea draws the
 *    text with the tokens coloured; the textarea stays the input. The proof
 *    of alignment is pixel-level: with the token colours neutralised, the
 *    mirror's rendering must match the field drawing its own text.
 *  - a SENT user message: the same tokens as spans, textContent unchanged.
 *  - only real commands: `/usr/bin` stays plain.
 *  - copying a message copies the plain text.
 */

const TYPED = 'lets do that: /create-plan @flow/discovery/discovery_x_v1.md'
const SCREENSHOT = 'e2e/results/command-highlight.png'

async function createThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) => {
      const created = (await (
        window as unknown as {
          flow: { threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> } }
        }
      ).flow.threads.create({ projectRoot: root, title })) as { id: string }
      return created.id
    },
    { root, title },
  )
}

async function appendMessage(win: Page, threadId: string, role: 'user' | 'assistant', content: string): Promise<void> {
  await win.evaluate(
    async ({ threadId, role, content }) => {
      await (
        window as unknown as {
          flow: { messages: { append(i: { threadId: string; role: string; content: string }): Promise<unknown> } }
        }
      ).flow.messages.append({ threadId, role, content })
    },
    { threadId, role, content },
  )
}

function populateSkills(dir: string): void {
  const commandsDir = join(dir, '.claude', 'commands')
  mkdirSync(commandsDir, { recursive: true })
  for (const name of ['create-plan', 'review-code', 'execute-plan']) {
    writeFileSync(join(commandsDir, `${name}.md`), `---\ndescription: ${name}\n---\nbody\n`)
  }
}

/** How many pixels differ (any channel by more than `tolerance`) between two PNGs. */
async function differingPixels(win: Page, a: Buffer, b: Buffer, tolerance = 24): Promise<number> {
  return win.evaluate(
    async ({ a, b, tolerance }) => {
      const load = async (base64: string): Promise<ImageData> => {
        // No fetch(data:) — the app's CSP refuses it; decode by hand.
        const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))
        const blob = new Blob([bytes], { type: 'image/png' })
        const bitmap = await createImageBitmap(blob)
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
        context.drawImage(bitmap, 0, 0)
        return context.getImageData(0, 0, bitmap.width, bitmap.height)
      }
      const [first, second] = await Promise.all([load(a), load(b)])
      if (first.width !== second.width || first.height !== second.height) return Number.MAX_SAFE_INTEGER
      let differing = 0
      for (let i = 0; i < first.data.length; i += 4) {
        for (let c = 0; c < 3; c += 1) {
          if (Math.abs((first.data[i + c] ?? 0) - (second.data[i + c] ?? 0)) > tolerance) {
            differing += 1
            break
          }
        }
      }
      return differing
    },
    { a: a.toString('base64'), b: b.toString('base64'), tolerance },
  )
}

test.afterAll(() => cleanupSeeds())

test('commands and @-files are highlighted in the input, aligned with the text, and in the sent message', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  populateSkills(dir)
  await activateProject(window, dir)
  const id = await createThread(window, dir, 'Highlight probe')
  await appendMessage(window, id, 'user', '/create-plan @flow/discovery/discovery_acme2866_direct_link_error_v1.md')
  await appendMessage(window, id, 'assistant', 'On it.')
  await appendMessage(window, id, 'user', 'ok, run /review-code on what changed in @app/src/renderer/threads/composer.ts and then /execute-plan')
  await appendMessage(window, id, 'user', 'is /usr/bin on the path? and 1/2 of a@b.com, /not-a-command')
  await window.getByText('Highlight probe', { exact: true }).first().click()
  await expect(window.locator(sel.composer)).toBeVisible()

  // ── The input, while typing ────────────────────────────────────────────
  const input = window.locator(sel.composerInput)
  const textarea = input.locator('textarea')
  await textarea.click()
  await textarea.pressSequentially(TYPED)
  await expect(textarea).toHaveValue(TYPED) // the field is the source of truth, unchanged

  const mirror = input.locator('.fl-composer-highlight')
  const command = mirror.locator('.fl-token-command')
  const file = mirror.locator('.fl-token-file')
  // Positive first: the mirror is live and drawing (allowed-pattern #28).
  await expect(input).toHaveClass(/fl-composer-highlighting/)
  await expect(command).toHaveText('/create-plan')
  await expect(file).toHaveText('@flow/discovery/discovery_x_v1.md')
  expect(await mirror.textContent()).toBe(TYPED)

  // The token boxes sit inside the field's text box.
  const fieldBox = await textarea.boundingBox()
  const commandBox = await command.boundingBox()
  const fileBox = await file.boundingBox()
  expect(fieldBox && commandBox && fileBox).toBeTruthy()
  if (fieldBox && commandBox && fileBox) {
    for (const box of [commandBox, fileBox]) {
      expect(box.x).toBeGreaterThanOrEqual(fieldBox.x)
      expect(box.y).toBeGreaterThanOrEqual(fieldBox.y)
      expect(box.x + box.width).toBeLessThanOrEqual(fieldBox.x + fieldBox.width + 1)
      expect(box.y + box.height).toBeLessThanOrEqual(fieldBox.y + fieldBox.height + 1)
    }
    // Reading order: the file follows the command on its line, or wraps below it.
    const after = fileBox.x > commandBox.x + commandBox.width - 1 || fileBox.y >= commandBox.y + commandBox.height - 1
    expect(after).toBe(true)
  }

  // Colours: the command wears the accent, the file the neutral mention grey (the secondary text colour).
  const colours = await window.evaluate(() => {
    const root = getComputedStyle(document.documentElement)
    const probe = document.createElement('span')
    document.body.appendChild(probe)
    const resolve = (token: string): string => {
      probe.style.color = root.getPropertyValue(token)
      return getComputedStyle(probe).color
    }
    const accent = resolve('--fl-color-accent')
    const mention = resolve('--fl-color-mention')
    const secondary = resolve('--fl-color-text-secondary')
    probe.remove()
    const at = (selector: string): string =>
      getComputedStyle(document.querySelector(selector) as Element).color
    return {
      accent,
      mention,
      secondary,
      command: at('.fl-composer-highlight .fl-token-command'),
      file: at('.fl-composer-highlight .fl-token-file'),
      fieldText: getComputedStyle(document.querySelector('.fl-composer-input textarea') as Element).color,
    }
  })
  expect(colours.command).toBe(colours.accent)
  expect(colours.file).toBe(colours.mention)
  expect(colours.mention).toBe(colours.secondary)
  expect(colours.fieldText).toBe('rgba(0, 0, 0, 0)') // the mirror draws the glyphs

  // Alignment, pixel by pixel: neutralise the token colours and the caret, then
  // the mirror's picture must match the field drawing its own text.
  await window.addStyleTag({
    content: `
      .fl-composer-highlight .fl-token { color: inherit !important; background: none !important; box-shadow: none !important; }
      .fl-composer-input textarea { caret-color: transparent !important; }
    `,
  })
  const mirrored = await textarea.screenshot()
  await window.evaluate(() => document.querySelector('.fl-composer-input')?.classList.remove('fl-composer-highlighting'))
  const native = await textarea.screenshot()
  const differing = await differingPixels(window, mirrored, native)
  expect(differing, `${differing} pixels differ between the mirror and the field's own text`).toBeLessThan(40)
  // Put the real state back (the next input re-syncs it anyway).
  await textarea.press('End')
  await textarea.pressSequentially(' ')
  await textarea.press('Backspace')
  await expect(input).toHaveClass(/fl-composer-highlighting/)
  await expect(textarea).toHaveValue(TYPED)
  await window.evaluate(() => {
    for (const style of document.querySelectorAll('style')) {
      if (style.textContent?.includes('caret-color: transparent !important')) style.remove()
    }
  })

  // ── The sent messages ─────────────────────────────────────────────────
  const bodies = window.locator('.fl-conv-user-body')
  await expect(bodies).toHaveCount(3)
  const first = bodies.nth(0)
  await expect(first.locator('.fl-token-command')).toHaveText('/create-plan')
  await expect(first.locator('.fl-token-file')).toHaveText('@flow/discovery/discovery_acme2866_direct_link_error_v1.md')
  const second = bodies.nth(1)
  await expect(second.locator('.fl-token-command')).toHaveText(['/review-code', '/execute-plan'])
  await expect(second.locator('.fl-token-file')).toHaveText('@app/src/renderer/threads/composer.ts')
  // Only real commands: a path, a fraction, an email and an unknown word stay plain.
  const plain = bodies.nth(2)
  await expect(plain).toHaveText('is /usr/bin on the path? and 1/2 of a@b.com, /not-a-command')
  await expect(plain.locator('.fl-token')).toHaveCount(0)
  // The message is unchanged: textContent is the original text exactly.
  expect(await second.textContent()).toBe(
    'ok, run /review-code on what changed in @app/src/renderer/threads/composer.ts and then /execute-plan',
  )
  const sentFont = await first
    .locator('.fl-token-command')
    .evaluate((el) => getComputedStyle(el).fontFamily)
  expect(sentFont.toLowerCase()).toContain('mono')

  // Copying a message copies plain text.
  await app.evaluate(({ clipboard }) => clipboard.writeText(''))
  await second.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.execCommand('copy')
    selection?.removeAllRanges()
  })
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
  expect(copied).toBe(
    'ok, run /review-code on what changed in @app/src/renderer/threads/composer.ts and then /execute-plan',
  )

  await window.screenshot({ path: SCREENSHOT })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('the input keeps behaving like a textarea: undo, programmatic clear, plain paths stay plain', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  populateSkills(dir)
  await activateProject(window, dir)
  await createThread(window, dir, 'Highlight behaviour')
  await window.getByText('Highlight behaviour', { exact: true }).first().click()
  const input = window.locator(sel.composerInput)
  const textarea = input.locator('textarea')
  await textarea.click()

  // A plain path never turns the mirror on.
  await textarea.pressSequentially('ls /usr/bin ')
  await expect(textarea).toHaveValue('ls /usr/bin ')
  await expect(input).not.toHaveClass(/fl-composer-highlighting/)

  await textarea.pressSequentially('/create-plan')
  await expect(input).toHaveClass(/fl-composer-highlighting/)
  await expect(input.locator('.fl-composer-highlight .fl-token-command')).toHaveText('/create-plan')

  // Undo goes through the field's own stack, and the mirror follows.
  const undo = process.platform === 'darwin' ? 'Meta+z' : 'Control+z'
  await textarea.press(undo)
  const undone = await textarea.inputValue()
  expect(undone).not.toBe('ls /usr/bin /create-plan')
  if (/(^|\s)\/create-plan$/.test(undone)) {
    await expect(input.locator('.fl-composer-highlight')).toHaveText(undone)
  } else {
    await expect(input).not.toHaveClass(/fl-composer-highlighting/)
  }

  // A direct `value =` assignment (how the composer clears after send) is seen.
  await textarea.fill('')
  await textarea.pressSequentially('/review-code ')
  await expect(input).toHaveClass(/fl-composer-highlighting/)
  await textarea.evaluate((el) => {
    ;(el as HTMLTextAreaElement).value = ''
  })
  await expect(input).not.toHaveClass(/fl-composer-highlighting/)
  expect(errors, errors.join(', ')).toHaveLength(0)
})
