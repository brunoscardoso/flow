// plan-features reader — the "what was implemented" view's data source.
// Parses plan files into per-feature phase/file structures from a temp
// flow/plans + flow/archive (no real git / subprocess).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { planToFeature, readPlanFeatures } from './plan-features'

function writePlan(root: string, name: string, body: string, where: 'plans' | 'archive'): void {
  mkdirSync(join(root, 'flow', where), { recursive: true })
  writeFileSync(join(root, 'flow', where, name), body, 'utf8')
}

const DEMO_PLAN = [
  '### Phase 1 — Component scaffold',
  '**Files**:',
  '- `app/src/coffee/steps.ts`',
  '- `app/src/coffee/`',
  '',
  '**Tasks**:',
  '- build it',
  '',
  '### Phase 2 — Content & markup',
  '**Files**:',
  '- `app/src/coffee/content.ts`',
  '',
  '### Phase 3 — Tests',
  '**Files**:',
  '- `*.test.ts`',
].join('\n')

describe('planToFeature', () => {
  it('builds a feature with phases, titles, files, and a concrete-file count', () => {
    const feature = planToFeature('plan_coffee_3_steps_v1.md', DEMO_PLAN, false)
    expect(feature).not.toBeNull()
    expect(feature?.feature).toBe('coffee-3-steps')
    expect(feature?.plan).toBe('plan_coffee_3_steps_v1.md')
    expect(feature?.archived).toBe(false)
    expect(feature?.phases.map((p) => `${p.label}:${p.title}`)).toEqual([
      'Phase 1:Component scaffold',
      'Phase 2:Content & markup',
      'Phase 3:Tests',
    ])
    // Phase 1 keeps both the exact file and the directory token.
    expect(feature?.phases[0].files).toEqual(['app/src/coffee/steps.ts', 'app/src/coffee/'])
    // fileCount = distinct CONCRETE files only (dir + glob excluded).
    expect(feature?.fileCount).toBe(2) // steps.ts + content.ts (not the dir, not *.test.ts)
  })

  it('harvests file-looking backticked tokens from the phase body when there is no Files section', () => {
    // Real-world shape: paths embedded in Description/Tasks, not a Files block.
    const plan = [
      '### Phase 1 — Component Scaffold',
      '**Description**: Create the `CoffeeGuide` component in `src/components/guides/CoffeeGuide.tsx`.',
      '**Tasks**:',
      '- [ ] Add `CoffeeGuide.client.test.tsx`',
      '- [ ] Run `tsc --noEmit` and add an `aria-label`',
      '- [ ] Update `package.json`',
    ].join('\n')
    const feature = planToFeature('plan_coffee_3_steps_v1.md', plan, false)
    // Real files kept; the bare symbol `CoffeeGuide`, the command `tsc --noEmit`,
    // and the prose `aria-label` are all excluded.
    expect(feature?.phases[0].files).toEqual([
      'src/components/guides/CoffeeGuide.tsx',
      'CoffeeGuide.client.test.tsx',
      'package.json',
    ])
    expect(feature?.fileCount).toBe(3)
  })

  it('sorts phases numerically (phase-10 after phase-2) and returns null with no phases', () => {
    const plan = ['### Phase 2 — Two', '**Files**:', '- `b.ts`', '### Phase 10 — Ten', '**Files**:', '- `j.ts`'].join('\n')
    expect(planToFeature('plan_x_v1.md', plan, true)?.phases.map((p) => p.phase)).toEqual([
      'phase-2',
      'phase-10',
    ])
    expect(planToFeature('plan_empty_v1.md', '# no phases here', true)).toBeNull()
  })
})

describe('readPlanFeatures', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'flow-features-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('returns an empty list when there are no plan dirs', async () => {
    expect(await readPlanFeatures(root)).toEqual([])
  })

  it('reads active + archived plans, active first, archived flagged', async () => {
    writePlan(root, 'plan_coffee_3_steps_v1.md', DEMO_PLAN, 'archive') // completed
    writePlan(root, 'plan_active_feature_v1.md', '### Phase 1 — Go\n**Files**:\n- `a.ts`', 'plans')
    const features = await readPlanFeatures(root)
    expect(features.map((f) => f.feature)).toEqual(['active-feature', 'coffee-3-steps'])
    expect(features.find((f) => f.feature === 'coffee-3-steps')?.archived).toBe(true)
    expect(features.find((f) => f.feature === 'active-feature')?.archived).toBe(false)
  })

  it('de-dupes by plan filename, active winning over a same-named archived plan', async () => {
    writePlan(root, 'plan_dupe_v1.md', '### Phase 1 — Old\n**Files**:\n- `old.ts`', 'archive')
    writePlan(root, 'plan_dupe_v1.md', '### Phase 1 — New\n**Files**:\n- `new.ts`', 'plans')
    const features = await readPlanFeatures(root)
    const dupe = features.filter((f) => f.plan === 'plan_dupe_v1.md')
    expect(dupe).toHaveLength(1)
    expect(dupe[0].archived).toBe(false)
    expect(dupe[0].phases[0].files).toEqual(['new.ts'])
  })
})
