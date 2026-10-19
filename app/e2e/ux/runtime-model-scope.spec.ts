import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')

/**
 * A model belongs to the runtime that can run it.
 *
 * Reported live: pinning gpt-5.1-codex-max while Codex was selected, then
 * switching back to Anthropic, opened a BRAND-NEW chat that failed on its
 * first message — "There's an issue with the selected model
 * (gpt-5.1-codex-max). It may not exist or you may not have access to it."
 * The preference was one app-wide value applied to every new thread, so the
 * pin outlived the runtime it was chosen for.
 */
test('a Codex pin does not follow you back to Claude', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-switch-'))
  const project = mkdtempSync(join(tmpdir(), 'flow-switch-proj-'))
  execFileSync('git', ['init', '-q'], { cwd: project })
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '', NODE_ENV: 'production', FLOW_E2E: '1' },
    })
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    const out = await win.evaluate(async (root: string) => {
      const flow = (window as any).flow
      await flow.project.add({ path: root })
      // Under Codex: pin a Codex model on a thread (what the composer does).
      await flow.settings.setDefaultProvider({ provider: 'codex' })
      const codexThread = await flow.threads.create({ projectRoot: root, title: 'cx' })
      await flow.threads.setModel({
        threadId: codexThread.id,
        selection: { model: 'gpt-5.1-codex-max' },
      })
      // Back to Claude, brand-new chat.
      await flow.settings.setDefaultProvider({ provider: 'claude' })
      const claudeThread = await flow.threads.create({ projectRoot: root, title: 'cl' })
      const back = await flow.threads.get({ threadId: claudeThread.id })
      // …and Codex's own pin is still Codex's when you go back.
      await flow.settings.setDefaultProvider({ provider: 'codex' })
      const codexAgain = await flow.threads.create({ projectRoot: root, title: 'cx2' })
      const codexBack = await flow.threads.get({ threadId: codexAgain.id })
      return { newThreadModel: back?.model ?? null, codexModel: codexBack?.model ?? null }
    }, project)
    console.log('### NEW CLAUDE THREAD MODEL:', JSON.stringify(out))
    expect(out.newThreadModel).not.toBe('gpt-5.1-codex-max')
    expect(out.codexModel).toBe('gpt-5.1-codex-max')
  } finally {
    await app?.close()
  }
})
