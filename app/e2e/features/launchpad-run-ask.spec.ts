import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from '../ux/fixtures/seed'

test.afterAll(() => cleanupSeeds())

test('a script that asks first is shown with line numbers and colour', async ({ window }: { window: Page }) => {
  test.setTimeout(90_000)
  const root = await seedProject(window, 'flow-e2e-ask-', undefined, { onboarded: true })
  await activateProject(window, root)
  await expect(window.locator('.fl-term-root')).toBeVisible({ timeout: 30_000 })
  await window.locator('.fl-run-setup-entry').click({ timeout: 30_000 })
  await window.getByRole('button', { name: 'Not now' }).click().catch(() => undefined)
  await window.locator('.fl-run-card').first().locator('.fl-run-name').fill('app')
  await window.locator('.fl-run-card').first().locator('.fl-run-name').press('Tab')
  await window.waitForTimeout(200)
  await window.locator('.fl-run-card').first().locator('.fl-run-command').fill('sleep 1000')
  await window.getByRole('button', { name: '+ Add a one-time action' }).click()
  const card = window.locator('.fl-run-card', { has: window.locator('.fl-run-segment') }).first()
  await card.locator('.fl-run-name').fill('reset-local-database')
  await card.locator('.fl-run-name').press('Tab')
  await window.locator('.fl-run-segment-btn', { hasText: 'Script' }).first().click()
  await window.locator('.fl-run-editor-input').first().fill([
    '#!/usr/bin/env bash', 'set -euo pipefail', '', '# One project name for every checkout and worktree.',
    'export COMPOSE_PROJECT_NAME="jupiter-core"', '', 'docker compose down -v', 'docker compose up --build -d',
    'until docker compose exec -T postgres pg_isready -U $USER; do', '  sleep 1', 'done', 'uv run alembic upgrade head',
  ].join('\n'))
  const box = card.locator('input[type=checkbox]').first()
  if (!(await box.isChecked())) await box.check()
  await window.waitForTimeout(300)
  await window.getByRole('button', { name: 'Save', exact: true }).click({ timeout: 3000 })
  await window.waitForTimeout(800)
  await window.locator('.fl-run-pill-run').click({ timeout: 15_000 })
  await window.getByText('reset-local-database').first().click()
  const dialog = window.locator('.fl-run-ask')
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await expect(dialog.locator('.fl-run-script-view-gutter')).toBeVisible()
  await expect(dialog.locator('.fl-run-sh-program').first()).toBeVisible()
  if (process.env.SHOT) await dialog.screenshot({ path: process.env.SHOT })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
})
