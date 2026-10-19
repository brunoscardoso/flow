import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Does a non-Claude runtime actually ANSWER? (multi_runtime_support)
 *
 * Everything around this was tested — the picker, the probe, the sign-in — and
 * the one thing that was not is the thing a user does: pick Copilot, type a
 * message, and wait. It produced nothing at all. The composer offered Opus
 * whatever runtime was selected, the thread handed that to `copilot --model
 * opus`, which refuses it, and the refusal was printed as plain text that the
 * JSON parser dropped on the floor. No answer, no error, no clue.
 *
 * So this test sends a real message to the real CLI and requires real words
 * back. It costs one Copilot request and about two minutes, and it is the only
 * test in the suite that can fail the way the user did.
 */

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')

/** Skip unless this machine can actually run the thing under test. */
function copilotSignedIn(): boolean {
  const config = join(process.env['COPILOT_HOME'] ?? join(homedir(), '.copilot'), 'config.json')
  if (!existsSync(config)) return false
  try {
    const text = readFileSync(config, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    const parsed = JSON.parse(text) as { loggedInUsers?: unknown[] }
    return Array.isArray(parsed.loggedInUsers) && parsed.loggedInUsers.length > 0
  } catch {
    return false
  }
}

test('a Copilot thread answers a message', async () => {
  test.skip(!copilotSignedIn(), 'Copilot is not signed in on this machine')
  test.setTimeout(240_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-copilot-turn-'))
  const project = mkdtempSync(join(tmpdir(), 'flow-copilot-proj-'))
  execFileSync('git', ['init', '-q'], { cwd: project })
  writeFileSync(join(project, 'README.md'), '# hi\n')
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '', NODE_ENV: 'production', FLOW_E2E: '1' },
    })
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    const transcript = await win.evaluate(async (root: string) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      await flow.settings.setDefaultProvider({ provider: 'copilot' })
      await flow.project.add({ path: root })
      const thread = await flow.threads.create({ title: 'copilot probe', projectRoot: root })
      const seen: string[] = []
      flow.threads.onStream((event: Record<string, string>) => {
        if (event['threadId'] !== thread.id) return
        if (event['kind'] === 'message-delta') seen.push(event['text'] ?? '')
        if (event['kind'] === 'error') seen.push(`ERROR: ${event['message'] ?? ''}`)
        if (event['kind'] === 'done') seen.push('<<done>>')
      })
      await flow.threads.sendMessage({ threadId: thread.id, content: 'Reply with exactly: pong' })
      for (let i = 0; i < 400; i += 1) {
        if (seen.some((entry) => entry === '<<done>>' || entry.startsWith('ERROR'))) break
        await new Promise((r) => setTimeout(r, 500))
      }
      return seen.join('')
    }, project)

    // Real words from the real runtime — not an empty turn wearing a tick.
    expect(transcript).not.toContain('ERROR:')
    expect(transcript.replace('<<done>>', '').trim().length).toBeGreaterThan(0)
    expect(transcript.toLowerCase()).toContain('pong')
  } finally {
    await app?.close()
  }
})
