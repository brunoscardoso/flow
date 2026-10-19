import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * FENCED CODE IN THE CHAT IS COLOURED, BY THE EDITOR'S OWN TOKENIZER.
 *
 * Reported 2026-09-09 with a side-by-side: our code blocks rendered as one flat
 * colour while the reference showed keywords, strings and types apart.
 */
test('a fenced TypeScript block is syntax-coloured', async ({ window, userDataDir }) => {
  test.setTimeout(180_000)
  try {
    const root = await seedProject(window, 'orbit-app-')
    await activateProject(window, root)
    const threadId: string = await window.evaluate(async (r) => {
      const t = await (window as any).flow.threads.create({ projectRoot: r, title: 'Code colour' })
      return t.id
    }, root)
    await window.waitForTimeout(1000)

    const { execFileSync } = await import('node:child_process')
    const { join } = await import('node:path')
    const answer = [
      'Here is the shape:',
      '',
      '```ts',
      'interface ChatState<UI_MESSAGE extends UIMessage> {',
      "  status: 'ready' | 'error' // the current phase",
      '  messages: UI_MESSAGE[]',
      '}',
      '```',
    ].join('\n')
    const q = (v: string): string => `'${v.replace(/'/g, "''")}'`
    execFileSync('sqlite3', [join(userDataDir, 'flow.db')], {
      input:
        `INSERT INTO messages (id,thread_id,role,content,created_at,model) ` +
        `VALUES ('m1',${q(threadId)},'assistant',${q(answer)},'2026-09-09T12:00:00.000Z','claude-opus-5');`,
    })

    // By its text: a `fl-list .row` locator resolves, then the list re-renders
    // under it and the click lands on nothing.
    await window.locator('.fl-thread-sidebar').getByText('Code colour', { exact: true }).first().click()
    await window.waitForTimeout(1500)

    // The tokenizer loads lazily, so the colour arrives after the plain text.
    await expect
      .poll(
        async () =>
          window.evaluate(() => document.querySelectorAll('.fl-md-codeblock .fl-tok-keyword').length),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0)

    const painted = await window.evaluate(() => {
      const code = document.querySelector('.fl-md-codeblock code')
      const tok = (cls: string): string[] =>
        Array.from(code?.querySelectorAll('.' + cls) ?? []).map((el) => el.textContent ?? '')
      const keywordColor = (): string | null => {
        const el = code?.querySelector('.fl-tok-keyword')
        return el === null || el === undefined ? null : getComputedStyle(el).color
      }
      return {
        text: code?.textContent ?? '',
        keywords: tok('fl-tok-keyword'),
        strings: tok('fl-tok-string'),
        comments: tok('fl-tok-comment'),
        keywordColor: keywordColor(),
        bodyColor: code === null ? null : getComputedStyle(code as HTMLElement).color,
        scriptNodes: code?.querySelectorAll('script').length ?? -1,
      }
    })

    // The SOURCE survives exactly — colour is presentation, and a highlighter
    // that drops a character has corrupted code somebody is about to copy.
    expect(painted.text).toContain('interface ChatState<UI_MESSAGE extends UIMessage> {')
    expect(painted.text).toContain("status: 'ready' | 'error'")
    // Real token classes, from Monaco's own grammar.
    expect(painted.keywords).toContain('interface')
    expect(painted.strings.join(' ')).toContain('ready')
    expect(painted.comments.join(' ')).toContain('the current phase')
    // …and they are actually a DIFFERENT colour from the block's body text,
    // which is the whole point and the thing a class name alone cannot prove.
    expect(painted.keywordColor).not.toBeNull()
    expect(painted.keywordColor).not.toBe(painted.bodyColor)
    // Still text, never structure.
    expect(painted.scriptNodes).toBe(0)
  } finally {
    cleanupSeeds()
  }
})
