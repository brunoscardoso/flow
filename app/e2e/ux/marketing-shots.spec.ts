// Marketing screenshot generator for planflow.sh (not a regression test —
// skipped unless SHOTS=1). Re-run after visual changes to refresh the site's
// product shots: SHOTS=1 npx playwright test e2e/ux/marketing-shots.spec.ts
// Seeds rich, realistic data and captures retina shots of the money surfaces.
import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

const OUT = '/tmp/flow-shots'

/** Showcase graph — a believable commerce SaaS: 14 nodes across all four
 *  kinds, dense-but-readable wiring (imports + calls + uses + exposes). */
const GRAPH = {
  version: 1,
  derivedAt: new Date().toISOString(),
  coverage: { filesScanned: 1284, filesTotal: 1284, extractorsRun: ['ts'], graphifyEnriched: true },
  nodes: [
    // Client + edge
    { id: 'module:web', kind: 'module', label: 'web', sourceFile: 'web', meta: { depth: 1 } },
    { id: 'module:mobile', kind: 'module', label: 'mobile', sourceFile: 'mobile', meta: { depth: 1 } },
    { id: 'module:gateway', kind: 'module', label: 'gateway', sourceFile: 'gateway', meta: { depth: 1 } },
    // Domain modules
    { id: 'module:auth', kind: 'module', label: 'auth', sourceFile: 'auth', meta: { depth: 1 } },
    { id: 'module:billing', kind: 'module', label: 'billing', sourceFile: 'billing', meta: { depth: 1 } },
    { id: 'module:payments', kind: 'module', label: 'payments', sourceFile: 'payments', meta: { depth: 1 } },
    { id: 'module:orders', kind: 'module', label: 'orders', sourceFile: 'orders', meta: { depth: 1 } },
    { id: 'module:catalog', kind: 'module', label: 'catalog', sourceFile: 'catalog', meta: { depth: 1 } },
    { id: 'module:inventory', kind: 'module', label: 'inventory', sourceFile: 'inventory', meta: { depth: 1 } },
    { id: 'module:search', kind: 'module', label: 'search', sourceFile: 'search', meta: { depth: 1 } },
    { id: 'module:analytics', kind: 'module', label: 'analytics', sourceFile: 'analytics', meta: { depth: 1 } },
    { id: 'module:notifications', kind: 'module', label: 'notifications', sourceFile: 'notifications', meta: { depth: 1 } },
    { id: 'module:workers', kind: 'module', label: 'workers', sourceFile: 'workers', meta: { depth: 1 } },
    { id: 'module:admin', kind: 'module', label: 'admin', sourceFile: 'admin', meta: { depth: 1 } },
    // Exposed endpoints
    { id: 'endpoint:POST /v1/checkout', kind: 'endpoint', label: 'POST /v1/checkout', sourceFile: 'gateway/checkout.ts', meta: {} },
    { id: 'endpoint:GET /v1/orders', kind: 'endpoint', label: 'GET /v1/orders', sourceFile: 'gateway/orders.ts', meta: {} },
    { id: 'endpoint:POST /v1/refunds', kind: 'endpoint', label: 'POST /v1/refunds', sourceFile: 'gateway/refunds.ts', meta: {} },
    { id: 'endpoint:POST /webhooks/stripe', kind: 'endpoint', label: 'POST /webhooks/stripe', sourceFile: 'payments/webhooks.ts', meta: {} },
    // Datastores
    { id: 'datastore:postgres', kind: 'datastore', label: 'postgres', sourceFile: 'infra/db.ts', meta: {} },
    { id: 'datastore:redis', kind: 'datastore', label: 'redis', sourceFile: 'infra/cache.ts', meta: {} },
    { id: 'datastore:clickhouse', kind: 'datastore', label: 'clickhouse', sourceFile: 'analytics/store.ts', meta: {} },
    // Integrations
    { id: 'integration:stripe', kind: 'integration', label: 'stripe', sourceFile: 'payments/stripe.ts', meta: {} },
    { id: 'integration:sendgrid', kind: 'integration', label: 'sendgrid', sourceFile: 'notifications/email.ts', meta: {} },
    { id: 'integration:twilio', kind: 'integration', label: 'twilio', sourceFile: 'notifications/sms.ts', meta: {} },
    { id: 'integration:s3', kind: 'integration', label: 's3', sourceFile: 'workers/uploads.ts', meta: {} },
    { id: 'integration:slack', kind: 'integration', label: 'slack', sourceFile: 'admin/alerts.ts', meta: {} },
    { id: 'integration:datadog', kind: 'integration', label: 'datadog', sourceFile: 'infra/telemetry.ts', meta: {} },
  ],
  edges: [
    // Clients → gateway
    { source: 'module:web', target: 'module:gateway', relation: 'imports' },
    { source: 'module:mobile', target: 'module:gateway', relation: 'calls' },
    { source: 'module:web', target: 'module:catalog', relation: 'calls' },
    // Gateway exposes + fans out
    { source: 'module:gateway', target: 'endpoint:POST /v1/checkout', relation: 'exposes' },
    { source: 'module:gateway', target: 'endpoint:GET /v1/orders', relation: 'exposes' },
    { source: 'module:gateway', target: 'endpoint:POST /v1/refunds', relation: 'exposes' },
    { source: 'module:gateway', target: 'module:auth', relation: 'imports' },
    { source: 'module:gateway', target: 'module:orders', relation: 'imports' },
    { source: 'module:gateway', target: 'module:payments', relation: 'imports' },
    { source: 'module:gateway', target: 'module:catalog', relation: 'imports' },
    { source: 'module:gateway', target: 'module:search', relation: 'imports' },
    // Payments core
    { source: 'module:payments', target: 'integration:stripe', relation: 'calls' },
    { source: 'module:payments', target: 'endpoint:POST /webhooks/stripe', relation: 'exposes' },
    { source: 'module:payments', target: 'module:billing', relation: 'imports' },
    { source: 'module:payments', target: 'datastore:postgres', relation: 'uses' },
    { source: 'module:billing', target: 'datastore:postgres', relation: 'uses' },
    { source: 'module:billing', target: 'integration:stripe', relation: 'calls' },
    // Orders / inventory / catalog
    { source: 'module:orders', target: 'datastore:postgres', relation: 'uses' },
    { source: 'module:orders', target: 'module:inventory', relation: 'calls' },
    { source: 'module:orders', target: 'module:payments', relation: 'calls' },
    { source: 'module:orders', target: 'module:notifications', relation: 'calls' },
    { source: 'module:inventory', target: 'datastore:postgres', relation: 'uses' },
    { source: 'module:catalog', target: 'datastore:postgres', relation: 'uses' },
    { source: 'module:catalog', target: 'module:search', relation: 'calls' },
    { source: 'module:search', target: 'datastore:redis', relation: 'uses' },
    // Auth
    { source: 'module:auth', target: 'datastore:redis', relation: 'uses' },
    { source: 'module:auth', target: 'datastore:postgres', relation: 'uses' },
    // Async / workers / analytics
    { source: 'module:workers', target: 'integration:s3', relation: 'calls' },
    { source: 'module:workers', target: 'datastore:postgres', relation: 'uses' },
    { source: 'module:workers', target: 'module:notifications', relation: 'calls' },
    { source: 'module:notifications', target: 'integration:sendgrid', relation: 'calls' },
    { source: 'module:notifications', target: 'integration:twilio', relation: 'calls' },
    { source: 'module:analytics', target: 'datastore:clickhouse', relation: 'uses' },
    { source: 'module:analytics', target: 'integration:datadog', relation: 'calls' },
    { source: 'module:gateway', target: 'module:analytics', relation: 'calls' },
    { source: 'module:admin', target: 'module:orders', relation: 'imports' },
    { source: 'module:admin', target: 'integration:slack', relation: 'calls' },
  ],
}

/** A ghost on the board: the plan proposes an invoicing module (not yet built). */
const PROPOSALS = [
  {
    ts: new Date().toISOString(),
    plan: 'usage_billing',
    phase: 2,
    predictedNodeId: 'module:invoicing',
    kind: 'module',
    label: 'invoicing',
    detail: 'Nightly usage rollup → Stripe invoice items',
    event: 'proposed',
    provenance: 'cli:propose',
  },
]

const STORY = {
  plan: 'usage_billing',
  sourcePath: 'flow/plans/plan_usage_billing_v1.md',
  mode: 'strict',
  steps: [
    {
      id: 'phase-1',
      title: 'Meter usage at the API edge',
      body: 'Every request increments per-tenant counters in redis.',
      anchors: [
        { kind: 'module', ref: 'gateway' },
        { kind: 'module', ref: 'auth' },
      ],
      flow: ['module:gateway', 'module:auth'],
      phases: [1],
      decisions: [],
      rejected: [],
      questions: [],
      unresolvedAnchors: [],
      draft: false,
    },
    {
      id: 'phase-2',
      title: 'Invoice from metered usage',
      body: 'The billing module rolls counters into Stripe invoice items.',
      anchors: [
        { kind: 'module', ref: 'billing' },
        { kind: 'module', ref: 'workers' },
      ],
      flow: ['module:billing', 'module:workers'],
      phases: [2],
      decisions: [],
      rejected: [],
      questions: [],
      unresolvedAnchors: [],
      draft: false,
    },
  ],
  warnings: [],
}

const LEARNING = [
  { module: 'gateway', status: 'learned', updatedAt: new Date().toISOString() },
  { module: 'auth', status: 'learned', updatedAt: new Date().toISOString() },
  { module: 'orders', status: 'learned', updatedAt: new Date().toISOString() },
  { module: 'payments', status: 'learned', updatedAt: new Date().toISOString() },
  { module: 'catalog', status: 'learned', updatedAt: new Date().toISOString() },
  { module: 'inventory', status: 'learned', updatedAt: new Date().toISOString() },
  { module: 'billing', status: 'learned', updatedAt: new Date().toISOString() },
  { module: 'web', status: 'stale', updatedAt: new Date().toISOString() },
]

const PAYMENTS_DOC = `# payments

**Purpose**: everything that moves money — Stripe client, webhook fan-in,
retries, idempotency, disputes. Boundary module: nothing else talks to
Stripe directly.

## Key flows
- **Charge**: orders/checkout → payments.charge → Stripe → webhook
  \`invoice.paid\` → notifications/invoice-email
- **Dunning**: \`invoice.payment_failed\` → retries.withRetry (backoff, max 5)
  → workers/dunning retries daily at 09:00
- **Disputes**: \`charge.dispute.created\` → dispute-handler freezes the tenant

## Invariants (verified against code)
- Every Stripe write carries an idempotency key (\`idempotency.ts\`) —
  webhook redelivery is expected, not exceptional
- Webhook handlers never throw: failures land in the retry queue
- Refunds go through orders/refunds, never straight to Stripe

## Files
| file | role |
|---|---|
| stripe-client.ts | pinned api version 2026-06-01 |
| webhooks.ts | event fan-in (paid / failed / dispute) |
| retries.ts | backoff wrapper |
| idempotency.ts | key derivation |
| dispute-handler.ts | freeze + alert |

*Verified against 5 files · re-learns automatically on drift*
`

function seedStructure(root: string): void {
  const dir = join(root, 'flow', 'brain', '.structure')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(GRAPH))
  writeFileSync(join(dir, 'story.json'), JSON.stringify(STORY))
  writeFileSync(
    join(dir, 'learning-state.jsonl'),
    LEARNING.map((l) => JSON.stringify(l)).join('\n') + '\n',
  )
  writeFileSync(
    join(dir, 'proposals.jsonl'),
    PROPOSALS.map((p) => JSON.stringify(p)).join('\n') + '\n',
  )
  // Trust tiers: foreign docs are CLAIMS, adjudicated against the code the
  // learn pass actually read (corroborated / contradicted / unverified).
  writeFileSync(
    join(dir, 'file-tiers.json'),
    JSON.stringify({
      entries: [
        { path: 'docs/ARCHITECTURE.md', tier: 'claim', verdict: { verdict: 'corroborated' } },
        { path: 'docs/billing-notes.md', tier: 'claim', verdict: { verdict: 'contradicted' } },
        { path: 'payments/payment-flow.png', tier: 'claim' },
      ],
    }),
  )
  const modulesDir = join(root, 'flow', 'brain', 'modules')
  mkdirSync(modulesDir, { recursive: true })
  writeFileSync(join(modulesDir, 'payments.md'), PAYMENTS_DOC)
}

async function openBoard(window: Page): Promise<void> {
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator('.flow-board-root')).toBeVisible()
  // STALE (plan_code-storyline_v1 phase 7): the code map these module-card
  // assertions read was removed — replaced by the code storyline.
  await expect(window.locator('.fb-node[data-node-id="module:gateway"]')).toBeVisible({ timeout: 10_000 })
}

test.afterAll(() => cleanupSeeds())

test('shots', async ({ window, app }) => {
  test.skip(!process.env.SHOTS, 'marketing shot generator — run with SHOTS=1 (writes /tmp/flow-shots)')
  test.setTimeout(180_000)
  const root = await seedProject(window, 'acme-shop-')
  seedStructure(root)

  // Realistic repo state for the review shot. The app's git watcher polls the
  // repo concurrently, so retry through transient index.lock collisions.
  const git = (args: string[]): void => {
    for (let attempt = 0; ; attempt++) {
      try {
        execFileSync('git', args, { cwd: root })
        return
      } catch (error) {
        if (attempt >= 5) throw error
        execFileSync('sleep', ['0.4'])
      }
    }
  }
  git(['config', 'user.email', 'shots@flow.test'])
  git(['config', 'user.name', 'Flow'])
  // The PROBLEM: an agent turn that touched ~23 files across the platform —
  // the wall of changes a reviewer actually faces.
  const changed: Array<[string, string]> = [
    ['billing/meter.ts', 'export const meter = (tenant: string, route: string) => counters.incr(`${tenant}:${route}`)\n'],
    ['billing/invoice.ts', `import { rollupUsage } from './usage-rollup'
import { PLANS } from './plans'
import { stripe } from '../payments/stripe-client'
import { idempotencyKey } from '../payments/idempotency'

/** Build a tenant's monthly invoice from metered usage. */
export async function buildInvoice(tenant: Tenant, period: Period) {
  const usage = await rollupUsage(tenant.id, period)
  const base = PLANS[tenant.plan]
  const overage = Math.max(0, usage.requests - included(tenant.plan))

  const items = [
    { description: \`\${tenant.plan} plan\`, amount: base },
    { description: \`\${overage} metered requests\`, amount: overage * RATE_CENTS },
  ]

  return stripe.invoices.create(
    { customer: tenant.stripeId, line_items: items, auto_advance: true },
    { idempotencyKey: idempotencyKey(tenant.id, \`invoice:\${period.month}\`) },
  )
}
`],
    ['billing/proration.ts', 'export const prorate = (from: Plan, to: Plan, at: Date) => diffCents(from, to) * remaining(at)\n'],
    ['billing/plans.ts', 'export const PLANS = { free: 0, pro: 4900, scale: 19900 } as const\n'],
    ['billing/stripe-sync.ts', 'export async function syncCustomer(tenant: string) {\n  /* idempotent upsert */\n}\n'],
    ['payments/stripe-client.ts', 'export const stripe = new Stripe(env.STRIPE_KEY, { apiVersion: \'2026-06-01\' })\n'],
    ['payments/webhooks.ts', `import { withRetry } from './retries'
import { invoiceEmail } from '../notifications/invoice-email'
import { paymentFailed } from '../notifications/payment-failed'

/** Stripe webhook fan-in — MUST stay idempotent (Stripe re-delivers). */
export async function onStripeEvent(event: Stripe.Event) {
  switch (event.type) {
    case 'invoice.paid':
      await markPaid(event.data.object.id)
      return invoiceEmail(tenantOf(event), event.data.object)
    case 'invoice.payment_failed':
      await withRetry(() => scheduleDunning(tenantOf(event)))
      return paymentFailed(tenantOf(event))
    case 'charge.dispute.created':
      return onDispute(event.data.object)
  }
}
`],
    ['payments/retries.ts', 'export const withRetry = (fn: () => Promise<void>) => backoff(fn, { max: 5 })\n'],
    ['payments/idempotency.ts', 'export const idempotencyKey = (tenant: string, op: string) => hash(`${tenant}:${op}`)\n'],
    ['orders/refunds.ts', 'export async function refund(orderId: string, cents: number) {\n  await payments.refund(orderId, cents)\n}\n'],
    ['orders/checkout.ts', 'export async function checkout(cart: Cart) {\n  const order = await orders.create(cart)\n  await payments.charge(order)\n}\n'],
    ['gateway/usage-middleware.ts', 'export const usage = (req: Req) => meter(req.tenant, req.route)\n'],
    ['gateway/rate-limit.ts', 'export const rateLimit = limiter({ windowMs: 60_000, byPlan: true })\n'],
    ['gateway/refund-endpoint.ts', 'router.post(\'/v1/refunds\', auth, async (req) => refund(req.body.orderId, req.body.cents))\n'],
    ['auth/plan-claims.ts', 'export const withPlan = (claims: Claims) => ({ ...claims, plan: plans.for(claims.tenant) })\n'],
    ['workers/rollup-usage.ts', 'export const nightly = cron(\'0 2 * * *\', () => rollupAllTenants())\n'],
    ['workers/dunning.ts', 'export const dunning = cron(\'0 9 * * *\', () => retryFailedInvoices())\n'],
    ['notifications/invoice-email.ts', 'export const invoiceEmail = (tenant: Tenant, invoice: Invoice) => sendgrid.send(template(invoice))\n'],
    ['notifications/payment-failed.ts', 'export const paymentFailed = (tenant: Tenant) => twilio.sms(tenant.phone, DUNNING_SMS)\n'],
    ['analytics/revenue-events.ts', 'export const track = (e: RevenueEvent) => clickhouse.insert(\'revenue\', e)\n'],
    ['migrations/0042_usage_counters.sql', 'CREATE TABLE usage_counters (tenant_id uuid, route text, count bigint, period date);\n'],
    ['migrations/0043_invoices.sql', 'CREATE TABLE invoices (id uuid primary key, tenant_id uuid, cents bigint, status text);\n'],
    ['admin/revenue-dashboard.ts', 'export const revenue = () => clickhouse.query(MRR_BY_PLAN)\n'],
  ]
  // Baseline: every file exists as a stub and is COMMITTED, so the changeset
  // shows individual modified rows (fully-untracked dirs would roll up).
  for (const [rel] of changed) {
    mkdirSync(join(root, rel.split('/')[0]), { recursive: true })
    writeFileSync(join(root, rel), '// TODO\n')
  }
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'baseline'])
  for (const [rel, content] of changed) {
    writeFileSync(join(root, rel), content)
  }
  // Plus a few brand-new files (?? rows) inside now-tracked dirs.
  writeFileSync(join(root, 'billing', 'usage-rollup.ts'), 'export const rollupUsage = (tenant: string, period: Period) => sumCounters(tenant, period)\n')
  writeFileSync(join(root, 'payments', 'dispute-handler.ts'), 'export const onDispute = (e: Stripe.Dispute) => freezeTenant(e.customer)\n')
  writeFileSync(join(root, 'migrations', '0044_dunning_state.sql'), 'CREATE TABLE dunning_state (tenant_id uuid, attempts int, next_retry timestamptz);\n')

  await activateProject(window, root)

  // Realistic chat thread
  const threadId = await window.evaluate(async ({ root }) => {
    const flow = (window as unknown as { flow: { threads: { create(i: object): Promise<{ id: string }> }; messages: { append(i: object): Promise<unknown> } } }).flow
    const t = await flow.threads.create({ projectRoot: root, title: 'Usage-based billing' })
    await flow.messages.append({ threadId: t.id, role: 'user', content: 'Add usage-based billing: meter API calls per tenant and invoice monthly through Stripe.' })
    await new Promise((r) => setTimeout(r, 150))
    await flow.messages.append({
      threadId: t.id,
      role: 'assistant',
      content: 'I explored the codebase and drafted a plan.\n\n**Phase 1 — Meter at the API edge** (`api/usage-middleware.ts`): per-tenant counters in redis, incremented in the auth-checked request path.\n\n**Phase 2 — Invoice from usage** (`billing/`): a nightly worker rolls counters into Stripe invoice items; idempotent on retry.\n\nI registered `billing/invoice` as a proposed component on the Blueprint — you can preview the blast radius phase-by-phase before I start.',
    })
    return t.id
  }, { root })
  void threadId

  mkdirSync(OUT, { recursive: true })

  // 1x capture context — enlarge the real window so shots carry real pixels
  // (2240x1400 ≈ 2.8x density when displayed at ~800px wide on the site).
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.setSize(2240, 1400)
    win?.center()
  })
  await window.waitForTimeout(600)

  // Native capturePage → honors the retina display's device pixel ratio.
  // The evaluate sandbox has no require/import — ship the PNG back as base64.
  // Declutter: no terminal pane in any shot (⌘J toggles it off).
  await window.keyboard.press('ControlOrMeta+j')
  await window.waitForTimeout(400)

  const shoot = async (path: string, rect?: { x: number; y: number; width: number; height: number }): Promise<void> => {
    const b64 = await app.evaluate(async ({ BrowserWindow }, r) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return ''
      const image = r
        ? await win.webContents.capturePage({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) })
        : await win.webContents.capturePage()
      return image.toPNG().toString('base64')
    }, rect ?? null)
    if (b64) writeFileSync(path, Buffer.from(b64, 'base64'))
  }
  /** Deterministic sidebar state — ⌘B toggles, so check before pressing. */
  const setSidebar = async (visible: boolean): Promise<void> => {
    const shown = await window.locator('.fl-sidebar').isVisible()
    if (shown !== visible) {
      await window.keyboard.press('ControlOrMeta+b')
      await window.waitForTimeout(300)
    }
  }
  /** Crop to a locator's box, padded and clamped to the window. `bottomSelector`
   *  optionally ends the crop at another element's bottom (content, not panel). */
  const shootRegion = async (path: string, selector: string, pad = 24, bottomSelector?: string): Promise<void> => {
    const box = await window.locator(selector).first().boundingBox()
    if (!box) throw new Error(`no box for ${selector}`)
    let bottom = box.y + box.height
    if (bottomSelector) {
      const bottomBox = await window.locator(bottomSelector).last().boundingBox()
      if (bottomBox) bottom = bottomBox.y + bottomBox.height
    }
    const vp = window.viewportSize() ?? { width: 2240, height: 1400 }
    const x = Math.max(0, box.x - pad)
    const y = Math.max(0, box.y - pad)
    await shoot(path, {
      x,
      y,
      width: Math.min(vp.width - x, box.width + pad * 2),
      height: Math.min(vp.height - y, bottom - y + pad),
    })
  }

  // Warm the editor surface first (the diff overlay mounts over it) and
  // pre-stage the board for act 2: wires on, fitted.
  await window.keyboard.press('ControlOrMeta+Alt+c') // chat collapsed throughout
  await openBoard(window)
  await setSidebar(false)
  await window.locator('[aria-label="Toggle connection wires"]').click()
  await window.keyboard.press('0') // the fit control retired with Territory; the key did not
  await window.waitForTimeout(600)
  await setSidebar(true)

  // ── ACT 1 · THE PROBLEM: the file wall + a real diff open ─────────────
  await window.locator('[data-rail-item="source-control"]').click()
  await window.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click()
  await expect(window.locator('.fl-review')).toBeAttached()
  await expect(window.locator('.fl-review-file').first()).toBeVisible()
  await window.locator('.fl-review-file-name', { hasText: 'billing/invoice.ts' }).click()
  await expect(window.locator('.gd-overlay')).toBeVisible()
  await window.waitForTimeout(700)
  await shoot(`${OUT}/story-1-problem.png`, { x: 0, y: 0, width: 2240, height: 1020 })
  await window.keyboard.press('Escape')

  // ── ACT 2 · THE MAP: the whole platform (pre-staged above) ────────────
  // Dismiss the ambient changeset layer for THIS act — the full map with wires
  // and amber counters is the story here; act 6 re-arms it (staging changes
  // the changeset fingerprint) for the decorated review.
  await openBoard(window)
  await setSidebar(false)
  const dismissChip = window.locator('.fb-changeset-chip-dismiss')
  if (await dismissChip.isVisible()) await dismissChip.click()
  await window.waitForTimeout(300)
  await shoot(`${OUT}/story-2-map.png`)

  // ── ACT 4 · THE KNOWLEDGE: the learned module doc, opened for real ─────
  await window.keyboard.press('Escape')
  await window.evaluate(({ root }) => {
    document.dispatchEvent(
      new CustomEvent('flow:open-file', { detail: { rootPath: root, relPath: 'flow/brain/modules/payments.md' } }),
    )
  }, { root })
  await window.waitForTimeout(1200)
  // Rendered markdown reads better than source for the knowledge act.
  const preview = window.getByText('Preview', { exact: true })
  if (await preview.isVisible()) {
    await preview.click()
    await window.waitForTimeout(700)
  }
  await shoot(`${OUT}/story-4-knowledge.png`, { x: 0, y: 0, width: 1560, height: 820 })

  // ── ACT 4b · THE SYNC: learning panel with trust tiers + staleness ─────
  // The Sync section is the mechanism made visible: graph freshness, stale
  // annotations, claim-doc adjudication tallies (trust tiers), and the
  // per-module learning state (learned / learning / stale).
  await openBoard(window)
  await setSidebar(false)
  await window.locator('.fb-learn-chip').click()
  await expect(window.locator('.fb-learn-panel')).toBeVisible()
  await window.waitForTimeout(700)
  {
    const panelBox = await window.locator('.fb-learn-panel').boundingBox()
    if (!panelBox) throw new Error('no learn panel box')
    const y = Math.max(0, panelBox.y - 300)
    await shoot(`${OUT}/story-4b-sync.png`, { x: 44, y, width: 1180, height: Math.min(1400 - y - 28, panelBox.height + 300) })
  }
  await window.locator('.fb-peek-close').first().click()
  await window.waitForTimeout(300)

  // ── ACT 5 · THE REHEARSAL: scrubber + the phase's real code, ONE screen ──
  // No composition: click a file inside the preview popover's Files tab and
  // the peek drawer opens the real code beside the walkthrough.
  await openBoard(window)
  await window.keyboard.press('0') // the fit control retired with Territory; the key did not
  await window.waitForTimeout(500)
  await window.locator('fl-button:has-text("Preview")').click()
  const menu = window.locator('.fb-preview-menu')
  await expect(menu).toBeVisible()
  await menu.locator('.fb-preview-menu-item', { hasText: 'Follow active chat' }).click()
  await window.waitForTimeout(900)
  // Phase 2 — invoice from metered usage; the popover embeds billing.
  await window.locator('[title="Next phase"]').click()
  await window.waitForTimeout(700)
  // Open the phase's code from the popover itself: Files → invoice.ts peeks
  // into the drawer on the same screen.
  await window.locator('.fb-popover-tab', { hasText: 'Files' }).click()
  await window.locator('.fb-popover-file', { hasText: 'invoice.ts' }).click()
  await expect(window.locator('.fb-peek-drawer')).toBeVisible()
  await window.waitForTimeout(1500) // monaco paint
  await window.keyboard.press('0') // the fit control retired with Territory; the key did not
  await window.waitForTimeout(600)
  await shoot(`${OUT}/story-5-simulation.png`, { x: 0, y: 28, width: 2240, height: 1372 })
  await window.locator('[title="Close preview"]').click()
  await window.locator('.fb-peek-close').first().click()
  await window.keyboard.press('0') // the fit control retired with Territory; the key did not
  await window.waitForTimeout(400)

  // ── ACT 6 · THE APPROVAL: the board IS the review (#898) ─────────────
  // Real surface, no mocks: the dirty tree decorates the board (lit + counts,
  // chip), staging is approval, and the invariant checker's advisory findings
  // ride inside the popover's Changes tab.
  await openBoard(window)
  await setSidebar(false)
  await window.keyboard.press('0') // the fit control retired with Territory; the key did not
  await window.waitForTimeout(400)
  // Partial approval: a few files already staged (approval IS git staging).
  // Staging changes the changeset fingerprint, so the layer dismissed in act 2
  // re-arms — the chip reappearing doubles as the git:changed sync signal.
  await window.evaluate(async ({ root }) => {
    const flow = (window as unknown as { flow: { git: { stage(i: object): Promise<void> } } }).flow
    await flow.git.stage({
      rootId: root,
      filePaths: ['payments/retries.ts', 'payments/idempotency.ts', 'payments/stripe-client.ts'],
    })
  }, { root })
  // The tmp-dir .git watcher is flaky — nudge the refresh over the same IPC
  // event it would emit; the renderer re-reads the REAL staged state.
  await app.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('git:changed', payload)
  }, { rootId: root })
  await expect(window.locator('.fb-changeset-chip')).toBeVisible({ timeout: 15_000 })
  await window.waitForTimeout(400)
  // The checker's verdicts, pushed over the real IPC event the service uses.
  await app.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('blueprint:invariantVerdicts', payload)
  }, {
    rootId: root,
    checkedAt: new Date().toISOString(),
    result: {
      verdicts: [
        {
          module: 'payments',
          invariant: 'Webhook handlers never throw',
          verdict: 'violates',
          filePath: 'payments/webhooks.ts',
          evidence: "+case 'charge.dispute.created' — the new dispute path skips withRetry",
        },
        {
          module: 'payments',
          invariant: 'Every Stripe write carries an idempotency key',
          verdict: 'touches',
          filePath: 'payments/idempotency.ts',
          evidence: '+idempotencyKey derivation changed — hash(`${tenant}:${op}`)',
        },
        {
          module: 'billing',
          invariant: 'Nothing outside payments talks to Stripe directly',
          verdict: 'violates',
          filePath: 'billing/stripe-sync.ts',
          evidence: '+syncCustomer() writes to Stripe without going through payments',
        },
      ],
      modules: [
        { module: 'payments', status: 'checked', cached: false },
        { module: 'billing', status: 'checked', cached: false },
        { module: 'gateway', status: 'no-invariants', reason: 'no invariants learned yet' },
      ],
    },
  })
  await window.waitForTimeout(600)
  await expect(window.locator('.fb-changeset-chip')).toBeVisible()
  await expect(
    window.locator('.fb-node[data-node-id="module:payments"] .fb-invariant-flag'),
  ).toBeVisible()
  // Open payments — the Changes tab leads: rows with staged ✓s, Approve all,
  // and the amber findings with evidence beneath.
  await window.locator('.fb-node[data-node-id="module:payments"]').click()
  await expect(window.locator('.fb-popover')).toBeVisible()
  await expect(window.locator('.fb-popover-finding').first()).toBeVisible()
  await window.waitForTimeout(600)
  await shoot(`${OUT}/story-6-approve.png`, { x: 0, y: 28, width: 2240, height: 1372 })

  // Close-up of the Changes tab itself — the reviewer's cockpit.
  await shootRegion(`${OUT}/story-6b-changes.png`, '.fb-popover', 220)
})
