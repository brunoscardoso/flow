import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, openEmptyThread } from './fixtures/seed'
import { AGENT_AUTH_ISOLATED } from './fixtures/worktree'
import { sel } from '../selectors'

/**
 * #772 — attach .md (text) files, not only images. A picked text file folds its
 * CONTENT into the message as a context chip (the #152 mechanism): the badge
 * shows the file name, and on send the message content carries the fenced text.
 */

// The send below must never reach the developer's own account.
test.use({ appEnv: AGENT_AUTH_ISOLATED })

test.afterAll(() => cleanupSeeds())

test('attaching an .md file creates a context chip whose content sends (#772)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const scratch = mkdtempSync(join(tmpdir(), 'flow-e2e-md-'))
  const mdPath = join(scratch, 'design-notes.md')
  writeFileSync(mdPath, '# Design notes\n\nThe MD_ATTACH_MARKER content travels with the message.\n')

  try {
    const dir = await seedProject(window)
    await activateProject(window, dir)
    // "+" opens the new-thread page (whose Create sends a first message); this
    // spec is about the composer of an open thread, so it opens an empty one.
    await openEmptyThread(window, dir)
    await expect(window.locator(sel.composer)).toBeVisible()

    // Pick the .md through the composer's file input (the 📎 path).
    await window.locator(`${sel.composer} input[type="file"]`).setInputFiles(mdPath)

    // A context chip labeled with the file name appears.
    const chip = window.locator(`${sel.composer} .fl-composer-chip`, { hasText: 'design-notes.md' })
    await expect(chip).toBeVisible()

    // Send with a typed question — the message content carries the fenced file text.
    const box = window.locator(`${sel.composer} textarea`)
    await box.click()
    await box.fill('what do you think?')
    await box.press('Enter')
    await expect(box).toHaveValue('', { timeout: 5000 })

    // The optimistic transcript echo contains the file's content marker.
    await expect(window.getByText('MD_ATTACH_MARKER', { exact: false }).first()).toBeVisible({
      timeout: 5000,
    })

    expect(errors, errors.join(', ')).toHaveLength(0)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
