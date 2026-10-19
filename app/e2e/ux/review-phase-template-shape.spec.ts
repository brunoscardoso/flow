/**
 * A PLAN IN THE SHAPE `/create-plan` ACTUALLY WRITES STILL SPLITS BY PHASE.
 *
 * WHAT THE USER REPORTED. "We are not detecting any more phases and we are
 * showing everything just one list of files, the same thing that we had on the
 * changes." The Phases tab had become a second copy of the Changes tab.
 *
 * WHY, AND WHY NOTHING LOOKED BROKEN. Phase attribution reads each phase's
 * `**Files**:` declaration — and the plan template emits `**Scope**`,
 * `**Complexity**`, `**Dependencies**` and no Files line at all. So every plan
 * written by the current template attributed nothing, everything fell into
 * "Other changes", and the panel rendered one flat list. Both halves were
 * behaving exactly as written; they had simply stopped agreeing about the
 * field that joins them. Measured across this repo's plans: 11 of 43 declared
 * Files, 68 of 278 phases.
 *
 * `review-phase-commit-scope.spec.ts` covers the declared-Files path and passed
 * throughout — which is precisely why this needed its own spec. It seeds the
 * shape the panel was documented for, not the shape plans are written in.
 *
 * So this seeds a plan the way the template does: phase metadata, no Files
 * line, and the file paths named in Task bullets the way a plan author names
 * them. Two phases, two changed files, and the panel must still show two
 * groups with the right file in each.
 */
import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const seededDirs: string[] = []

test.afterAll(() => {
  for (const dir of seededDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
  cleanupSeeds()
})

/**
 * A plan exactly as the template emits one — Scope / Complexity / Dependencies,
 * tasks that name their files in backticks, and NO `**Files**:` line anywhere.
 */
function templateShapedPlan(alpha: string, beta: string): string {
  return `# Plan: Panel work

## Phases

### Phase 1: Landing controls

**Scope**: move the controls into the group they act on
**Complexity**: 4/10
**Dependencies**: None

- [ ] Move the block in \`${alpha}\`
  <verify>npx tsc --noEmit</verify>
- [ ] Check it renders

**Build Verification**: Run \`npm run build\`

### Phase 2: Group separation

**Scope**: give each project a visible end
**Complexity**: 3/10
**Dependencies**: Phase 1

- [ ] Add the band rule in \`${beta}\`

**Build Verification**: Run \`npm run build\`
`
}

interface Seeded {
  dir: string
  alpha: string
  beta: string
}

/** A repo with one working-tree change per phase, and a template-shaped plan. */
async function seedRepo(win: Page, tag: string): Promise<Seeded> {
  const dir = mkdtempSync(join(tmpdir(), `flow-ux-phtmpl-${tag}-`))
  const alpha = `src/alpha-${tag}.ts`
  const beta = `src/beta-${tag}.ts`
  seededDirs.push(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Flow QA'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.claude/\nflow\n')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, alpha), 'export const alpha = 1\n')
  writeFileSync(join(dir, beta), 'export const beta = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })
  mkdirSync(join(dir, 'flow', 'plans'), { recursive: true })
  writeFileSync(
    join(dir, 'flow', 'plans', 'plan_panel_work_v1.md'),
    templateShapedPlan(alpha, beta),
  )
  writeFileSync(join(dir, alpha), 'export const alpha = 2\n')
  writeFileSync(join(dir, beta), 'export const beta = 2\n')
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, dir)
  await activateProject(win, dir)
  return { dir, alpha, beta }
}

async function openReview(win: Page): Promise<void> {
  await win.locator('[data-rail-item="source-control"]').click()
  await win.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click()
  await expect(win.locator('.fl-review')).toBeAttached()
}

function group(win: Page, label: string) {
  return win.locator('.fl-review-group', { has: win.locator(`text=${label}`) })
}

test('a plan written in the template’s own shape still splits into phase groups', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(error.message))

  const { alpha, beta } = await seedRepo(window, 'a')
  await openReview(window)

  const p1 = group(window, 'Phase 1')
  const p2 = group(window, 'Phase 2')
  await expect(p1).toHaveCount(1, { timeout: 15_000 })
  await expect(p2).toHaveCount(1)
  // Each phase claims the file its own tasks named — the whole point.
  await expect(p1.locator('.fl-review-file-name')).toHaveText([alpha])
  await expect(p2.locator('.fl-review-file-name')).toHaveText([beta])
  // Each group is independently committable, with its own message.
  await expect(p1.locator('.fl-review-message')).toHaveValue(/panel-work/)
  await expect(p2.locator('.fl-review-message')).toHaveValue(/panel-work/)

  // And the failure being guarded against: NOT one undifferentiated list.
  await expect(group(window, 'Other changes')).toHaveCount(0)

  expect(errors, errors.join(', ')).toHaveLength(0)
})
