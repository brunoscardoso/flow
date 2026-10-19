/**
 * The acme-shop example world — the ONE fictional product every planflow.sh
 * frame is photographed against.
 *
 * Extracted from marketing-shots.spec.ts so the site's story and its newer acts
 * (Territory, loops, tasks, conflicts) are seeded from the same source. A
 * returning visitor should recognise `payments` and `billing` from one act to
 * the next, so this world is stable on purpose: change it and every shot on the
 * site has to be retaken together.
 *
 * Documented for the site in plan-flow-lp/SITE-REFRESH.md § "Part 4".
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Showcase graph — a believable commerce SaaS: 27 components across all four
 *  kinds, dense-but-readable wiring (imports + calls + uses + exposes). */
export const GRAPH = {
  version: 1,
  derivedAt: new Date().toISOString(),
  coverage: { filesScanned: 1284, filesTotal: 1284, extractorsRun: ['ts'], graphifyEnriched: true },
  nodes: [
    { id: 'module:web', kind: 'module', label: 'web', sourceFile: 'web', meta: { depth: 1 } },
    { id: 'module:mobile', kind: 'module', label: 'mobile', sourceFile: 'mobile', meta: { depth: 1 } },
    { id: 'module:gateway', kind: 'module', label: 'gateway', sourceFile: 'gateway', meta: { depth: 1 } },
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
    { id: 'endpoint:POST /v1/checkout', kind: 'endpoint', label: 'POST /v1/checkout', sourceFile: 'gateway/checkout.ts', meta: {} },
    { id: 'endpoint:GET /v1/orders', kind: 'endpoint', label: 'GET /v1/orders', sourceFile: 'gateway/orders.ts', meta: {} },
    { id: 'endpoint:POST /v1/refunds', kind: 'endpoint', label: 'POST /v1/refunds', sourceFile: 'gateway/refunds.ts', meta: {} },
    { id: 'endpoint:POST /webhooks/stripe', kind: 'endpoint', label: 'POST /webhooks/stripe', sourceFile: 'payments/webhooks.ts', meta: {} },
    { id: 'datastore:postgres', kind: 'datastore', label: 'postgres', sourceFile: 'infra/db.ts', meta: {} },
    { id: 'datastore:redis', kind: 'datastore', label: 'redis', sourceFile: 'infra/cache.ts', meta: {} },
    { id: 'datastore:clickhouse', kind: 'datastore', label: 'clickhouse', sourceFile: 'analytics/store.ts', meta: {} },
    { id: 'integration:stripe', kind: 'integration', label: 'stripe', sourceFile: 'payments/stripe.ts', meta: {} },
    { id: 'integration:sendgrid', kind: 'integration', label: 'sendgrid', sourceFile: 'notifications/email.ts', meta: {} },
    { id: 'integration:twilio', kind: 'integration', label: 'twilio', sourceFile: 'notifications/sms.ts', meta: {} },
    { id: 'integration:s3', kind: 'integration', label: 's3', sourceFile: 'workers/uploads.ts', meta: {} },
    { id: 'integration:slack', kind: 'integration', label: 'slack', sourceFile: 'admin/alerts.ts', meta: {} },
    { id: 'integration:datadog', kind: 'integration', label: 'datadog', sourceFile: 'infra/telemetry.ts', meta: {} },
  ],
  edges: [
    { source: 'module:web', target: 'module:gateway', relation: 'imports' },
    { source: 'module:mobile', target: 'module:gateway', relation: 'calls' },
    { source: 'module:web', target: 'module:catalog', relation: 'calls' },
    { source: 'module:gateway', target: 'endpoint:POST /v1/checkout', relation: 'exposes' },
    { source: 'module:gateway', target: 'endpoint:GET /v1/orders', relation: 'exposes' },
    { source: 'module:gateway', target: 'endpoint:POST /v1/refunds', relation: 'exposes' },
    { source: 'module:gateway', target: 'module:auth', relation: 'imports' },
    { source: 'module:gateway', target: 'module:orders', relation: 'imports' },
    { source: 'module:gateway', target: 'module:payments', relation: 'imports' },
    { source: 'module:gateway', target: 'module:catalog', relation: 'imports' },
    { source: 'module:gateway', target: 'module:search', relation: 'imports' },
    { source: 'module:payments', target: 'integration:stripe', relation: 'calls' },
    { source: 'module:payments', target: 'endpoint:POST /webhooks/stripe', relation: 'exposes' },
    { source: 'module:payments', target: 'module:billing', relation: 'imports' },
    { source: 'module:payments', target: 'datastore:postgres', relation: 'uses' },
    { source: 'module:billing', target: 'datastore:postgres', relation: 'uses' },
    { source: 'module:billing', target: 'integration:stripe', relation: 'calls' },
    { source: 'module:orders', target: 'datastore:postgres', relation: 'uses' },
    { source: 'module:orders', target: 'module:inventory', relation: 'calls' },
    { source: 'module:orders', target: 'module:payments', relation: 'calls' },
    { source: 'module:orders', target: 'module:notifications', relation: 'calls' },
    { source: 'module:inventory', target: 'datastore:postgres', relation: 'uses' },
    { source: 'module:catalog', target: 'datastore:postgres', relation: 'uses' },
    { source: 'module:catalog', target: 'module:search', relation: 'calls' },
    { source: 'module:search', target: 'datastore:redis', relation: 'uses' },
    { source: 'module:auth', target: 'datastore:redis', relation: 'uses' },
    { source: 'module:auth', target: 'datastore:postgres', relation: 'uses' },
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
export const PROPOSALS = [
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
  {
    ts: new Date().toISOString(),
    plan: 'usage_billing',
    phase: 1,
    predictedNodeId: 'module:metering',
    kind: 'module',
    label: 'metering',
    detail: 'Per-tenant request counters at the API edge',
    event: 'proposed',
    provenance: 'cli:propose',
  },
  {
    ts: new Date().toISOString(),
    plan: 'dunning_v2',
    phase: 1,
    predictedNodeId: 'module:dunning',
    kind: 'module',
    label: 'dunning',
    detail: 'Capped retry ladder with a final give-up state',
    event: 'proposed',
    provenance: 'cli:propose',
  },
]

export const STORY = {
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

/**
 * Per-module learning state.
 *
 * The board counts the graph's MODULE NODES, so an entry only lands if its
 * `module` matches one of those ids' labels — which is why an earlier version
 * of this fixture (keyed on capability names) rendered a board reading
 * "0 of 15 modules · 0%" with every dial empty. Ten of fourteen learned, one
 * drifted, three untouched: enough for all three states to be visible at once,
 * and an honest number rather than a suspicious 100%.
 */
export const LEARNING = [
  { module: 'gateway', status: 'learned', notedAt: new Date().toISOString() },
  { module: 'auth', status: 'learned', notedAt: new Date().toISOString() },
  { module: 'orders', status: 'learned', notedAt: new Date().toISOString() },
  { module: 'payments', status: 'learned', notedAt: new Date().toISOString() },
  { module: 'catalog', status: 'learned', notedAt: new Date().toISOString() },
  { module: 'inventory', status: 'learned', notedAt: new Date().toISOString() },
  { module: 'billing', status: 'learned', notedAt: new Date().toISOString() },
  { module: 'notifications', status: 'learned', notedAt: new Date().toISOString() },
  { module: 'workers', status: 'learned', notedAt: new Date().toISOString() },
  { module: 'analytics', status: 'learned', notedAt: new Date().toISOString() },
  { module: 'web', status: 'stale', notedAt: new Date().toISOString() },
]

/**
 * What the loops have filed onto the project's list — the Todo lane's window.
 *
 * Written straight to the ledger JSONL rather than shelled through
 * `planflow-ai loop file`, so seeding costs no CLI boots and works before the
 * root is added. Shape mirrors what `loop file` writes.
 */
export const QUEUE_ITEMS: Array<{ title: string; body: string; labels: string[] }> = [
  {
    title: 'Dunning retries have no cap on the final attempt',
    body: 'workers/dunning.ts retries daily but never gives up — a permanently failing card is retried forever.',
    labels: ['find', 'checkout'],
  },
  {
    title: 'refund() skips the idempotency wrapper',
    body: 'orders/refunds.ts calls payments.refund directly; every other Stripe write derives a key first.',
    labels: ['find', 'checkout'],
  },
  {
    title: 'Proration rounds against the customer',
    body: 'billing/proration.ts floors cents on a downgrade — the tenant loses up to 99c per change.',
    labels: ['find', 'checkout'],
  },
  {
    title: 'usage_counters has no index on (tenant_id, period)',
    body: 'The nightly rollup scans the whole table; migration 0042 declares no index.',
    labels: ['find', 'checkout'],
  },
  {
    title: 'Webhook handler swallows unknown event types',
    body: 'payments/webhooks.ts falls through silently — a new Stripe event type is indistinguishable from a handled one.',
    labels: ['find', 'checkout'],
  },
]

/** Local task records, one per lane, so the board shows work in flight. */
export const TASKS: Array<{ title: string; description: string; lane: 'doing' | 'blocked' | 'done' }> = [
  {
    title: 'Meter API calls per tenant',
    description: 'Phase 1 of usage-based billing — per-tenant counters in redis, incremented in the auth-checked request path.',
    lane: 'doing',
  },
  {
    title: 'Invoice monthly from metered usage',
    description: 'Phase 2 — roll counters into Stripe invoice items nightly, idempotent on retry.',
    lane: 'doing',
  },
  {
    title: 'Backfill invoices for March',
    description: 'Blocked: needs the finance export before it can run against production tenants.',
    lane: 'blocked',
  },
  {
    title: 'Rate-limit /v1/refunds by plan',
    description: 'Refund endpoint now shares the gateway limiter, bucketed per plan.',
    lane: 'done',
  },
  {
    title: 'Pin the Stripe API version',
    description: 'stripe-client.ts pins 2026-06-01 so a Stripe-side default bump cannot change behaviour silently.',
    lane: 'done',
  },
]

/** Chat threads, so the sidebar reads like a project somebody works in. */
export const THREADS: Array<{ title: string; user?: string; assistant?: string }> = [
  {
    title: 'Usage-based billing',
    user: 'Add usage-based billing: meter API calls per tenant and invoice monthly through Stripe.',
    assistant:
      'I explored the codebase and drafted a plan.\n\n**Phase 1 — Meter at the API edge** (`gateway/usage-middleware.ts`): per-tenant counters in redis, incremented in the auth-checked request path.\n\n**Phase 2 — Invoice from usage** (`billing/`): a nightly worker rolls counters into Stripe invoice items; idempotent on retry.\n\nI registered `billing/invoicing` as a proposed component on the Blueprint — you can preview the blast radius phase by phase before I start.',
  },
  { title: 'Why is the dunning worker retrying forever?' },
  { title: 'Refactor the search index writer' },
  { title: 'Postgres connection pool sizing' },
]

export const PAYMENTS_DOC = `# payments

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

/** The 23 modified files of the usage-billing changeset, with real content. */
export const CHANGED: Array<[string, string]> = [
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
  ['payments/stripe-client.ts', "export const stripe = new Stripe(env.STRIPE_KEY, { apiVersion: '2026-06-01' })\n"],
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
  ['gateway/refund-endpoint.ts', "router.post('/v1/refunds', auth, async (req) => refund(req.body.orderId, req.body.cents))\n"],
  ['auth/plan-claims.ts', 'export const withPlan = (claims: Claims) => ({ ...claims, plan: plans.for(claims.tenant) })\n'],
  ['workers/rollup-usage.ts', "export const nightly = cron('0 2 * * *', () => rollupAllTenants())\n"],
  ['workers/dunning.ts', "export const dunning = cron('0 9 * * *', () => retryFailedInvoices())\n"],
  ['notifications/invoice-email.ts', 'export const invoiceEmail = (tenant: Tenant, invoice: Invoice) => sendgrid.send(template(invoice))\n'],
  ['notifications/payment-failed.ts', 'export const paymentFailed = (tenant: Tenant) => twilio.sms(tenant.phone, DUNNING_SMS)\n'],
  ['analytics/revenue-events.ts', "export const track = (e: RevenueEvent) => clickhouse.insert('revenue', e)\n"],
  ['migrations/0042_usage_counters.sql', 'CREATE TABLE usage_counters (tenant_id uuid, route text, count bigint, period date);\n'],
  ['migrations/0043_invoices.sql', 'CREATE TABLE invoices (id uuid primary key, tenant_id uuid, cents bigint, status text);\n'],
  ['admin/revenue-dashboard.ts', 'export const revenue = () => clickhouse.query(MRR_BY_PLAN)\n'],
]

/** The three brand-new files (?? rows) inside now-tracked dirs. */
export const ADDED: Array<[string, string]> = [
  ['billing/usage-rollup.ts', 'export const rollupUsage = (tenant: string, period: Period) => sumCounters(tenant, period)\n'],
  ['payments/dispute-handler.ts', 'export const onDispute = (e: Stripe.Dispute) => freezeTenant(e.customer)\n'],
  ['migrations/0044_dunning_state.sql', 'CREATE TABLE dunning_state (tenant_id uuid, attempts int, next_retry timestamptz);\n'],
]

/** The invariant checker's verdicts for the usage-billing changeset. */
export const INVARIANT_RESULT = {
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
}

/** Files pre-approved (staged) so the review shot reads "3 of 5 approved". */
export const STAGED = ['payments/retries.ts', 'payments/idempotency.ts', 'payments/stripe-client.ts']

/** Write the derived stores + the learned payments doc into a seeded project. */
export function seedStructure(root: string): void {
  const dir = join(root, 'flow', 'brain', '.structure')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(GRAPH))
  writeFileSync(join(dir, 'story.json'), JSON.stringify(STORY))
  writeFileSync(join(dir, 'learning-state.jsonl'), LEARNING.map((l) => JSON.stringify(l)).join('\n') + '\n')
  writeFileSync(join(dir, 'proposals.jsonl'), PROPOSALS.map((p) => JSON.stringify(p)).join('\n') + '\n')
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

/**
 * Run a git command, retrying through the app watcher's index.lock collisions.
 * Portable: the retry sleeps in-process rather than shelling out to `sleep`,
 * which does not exist on Windows.
 */
export function gitIn(root: string, args: string[]): void {
  for (let attempt = 0; ; attempt++) {
    try {
      execFileSync('git', args, { cwd: root, stdio: 'ignore' })
      return
    } catch (error) {
      if (attempt >= 5) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400)
    }
  }
}

/**
 * The FEATURE STORE — what the Territory actually draws.
 *
 * The board's default sheet is the feature blueprint, not the derived graph, so
 * a project with `graph.json` alone renders "No features yet". Each entry below
 * is a capability (`kind: core`) whose anchors are the real acme-shop files, so
 * the changeset in act 02 lights the cells that own the changed files.
 *
 * AREA IS MEASURED CODE, so the anchor counts are deliberately uneven — the
 * money path (billing, payments, checkout) is the biggest ground on the sheet,
 * which is also what the story is about.
 */
const FEATURES: Array<{
  slug: string
  name: string
  /** One line a reader learns something from — never filler; it is on the cell. */
  summary: string
  /** Real files this capability stands on. */
  anchors: string[]
  /**
   * Module directories this capability's filler files go into, and how many
   * each gets. Padding lands in the REAL modules (`billing/`, `payments/`, …)
   * rather than a directory named after the feature, so the module set the
   * board counts is the same 14 the graph declares — which is what lets the
   * learning state below read as a real percentage instead of 0 of 20.
   */
  pad: Array<[dir: string, count: number]>
  parts?: Array<[name: string, summary: string, anchor: string]>
  /** Not yet learned — keeps the understood percentage honest rather than 100%. */
  unread?: boolean
}> = [
  {
    slug: 'billing-invoicing',
    name: 'Billing & Invoicing',
    summary: 'Meters usage per tenant and turns it into a monthly Stripe invoice.',
    anchors: ['billing/invoice.ts', 'billing/meter.ts', 'billing/plans.ts', 'billing/proration.ts', 'billing/stripe-sync.ts', 'billing/usage-rollup.ts'],
    pad: [['billing', 16]],
    parts: [
      ['Invoice Builder', 'Turns metered usage into Stripe invoice items.', 'billing/invoice.ts'],
      ['Metering', 'Per-tenant request counters at the edge.', 'billing/meter.ts'],
      ['Plans & Proration', 'Plan pricing and mid-cycle changes.', 'billing/plans.ts'],
      ['Usage Rollup', 'Nightly aggregation of counters.', 'billing/usage-rollup.ts'],
    ],
  },
  {
    slug: 'payments',
    name: 'Payments',
    summary: 'The boundary to Stripe — charges, webhooks, retries, disputes.',
    anchors: ['payments/stripe-client.ts', 'payments/webhooks.ts', 'payments/retries.ts', 'payments/idempotency.ts', 'payments/dispute-handler.ts'],
    pad: [['payments', 14]],
    parts: [
      ['Stripe Client', 'The only place that talks to Stripe.', 'payments/stripe-client.ts'],
      ['Webhook Fan-in', 'paid / failed / dispute events.', 'payments/webhooks.ts'],
      ['Dunning & Retries', 'Capped backoff on payment failure.', 'payments/retries.ts'],
      ['Disputes', 'Freeze the tenant, alert the team.', 'payments/dispute-handler.ts'],
    ],
  },
  {
    slug: 'checkout',
    name: 'Checkout',
    summary: 'Cart to paid order, behind the rate-limited public API.',
    anchors: ['orders/checkout.ts', 'orders/refunds.ts', 'gateway/rate-limit.ts', 'gateway/refund-endpoint.ts', 'gateway/usage-middleware.ts'],
    pad: [['orders', 7], ['gateway', 6]],
  },
  {
    slug: 'storefront',
    name: 'Storefront',
    summary: 'The web and mobile clients customers actually see.',
    anchors: [],
    pad: [['web', 11], ['mobile', 7]],
  },
  {
    slug: 'catalog-search',
    unread: true,
    name: 'Catalog & Search',
    summary: 'Product records and the redis-backed search index over them.',
    anchors: [],
    pad: [['catalog', 6], ['search', 5]],
  },
  {
    slug: 'identity-access',
    name: 'Identity & Access',
    summary: 'Sessions, tenant claims, and the plan a request is entitled to.',
    anchors: ['auth/plan-claims.ts'],
    pad: [['auth', 8]],
  },
  {
    slug: 'fulfilment',
    name: 'Fulfilment Workers',
    summary: 'Scheduled jobs — nightly usage rollup and daily dunning.',
    anchors: ['workers/rollup-usage.ts', 'workers/dunning.ts'],
    pad: [['workers', 6]],
  },
  {
    slug: 'notifications',
    name: 'Notifications',
    summary: 'Invoice email and payment-failure SMS, via SendGrid and Twilio.',
    anchors: ['notifications/invoice-email.ts', 'notifications/payment-failed.ts'],
    pad: [['notifications', 5]],
  },
  {
    slug: 'revenue-analytics',
    unread: true,
    name: 'Revenue Analytics',
    summary: 'Revenue events into ClickHouse, and the MRR dashboard over them.',
    anchors: ['analytics/revenue-events.ts', 'admin/revenue-dashboard.ts'],
    pad: [['analytics', 4], ['admin', 3]],
  },
  {
    slug: 'inventory',
    unread: true,
    name: 'Inventory',
    summary: 'Stock levels, reserved against an order at checkout.',
    anchors: [],
    pad: [['inventory', 4]],
  },
]

/**
 * Plausible file names per module, so a drilled feature reads like a codebase
 * instead of `billing-invoicing-0.ts`. Cycled with a numeric suffix only once
 * the list runs out, which for these counts it rarely does.
 */
const FILE_NAMES: Record<string, string[]> = {
  billing: ['subscription.ts', 'coupon.ts', 'tax.ts', 'credit-note.ts', 'dunning-policy.ts', 'trial.ts', 'seat-count.ts', 'currency.ts', 'billing-cycle.ts', 'ledger.ts', 'entitlement.ts', 'quota.ts', 'discount.ts', 'refund-policy.ts', 'statement.ts', 'invoice-pdf.ts'],
  payments: ['charge.ts', 'payment-method.ts', 'mandate.ts', 'payout.ts', 'balance.ts', 'fee.ts', 'currency-convert.ts', 'three-d-secure.ts', 'wallet.ts', 'bank-transfer.ts', 'card-token.ts', 'settlement.ts', 'chargeback.ts', 'receipt.ts'],
  orders: ['cart.ts', 'line-item.ts', 'fulfilment.ts', 'shipping.ts', 'address.ts', 'order-state.ts', 'returns.ts'],
  gateway: ['router.ts', 'auth-middleware.ts', 'cors.ts', 'request-id.ts', 'error-handler.ts', 'openapi.ts'],
  web: ['app-shell.tsx', 'checkout-page.tsx', 'product-page.tsx', 'cart-drawer.tsx', 'account-page.tsx', 'search-bar.tsx', 'nav.tsx', 'footer.tsx', 'theme.ts', 'router.tsx', 'analytics.ts'],
  mobile: ['App.tsx', 'CheckoutScreen.tsx', 'ProductScreen.tsx', 'CartScreen.tsx', 'AccountScreen.tsx', 'navigation.ts', 'push.ts'],
  catalog: ['product.ts', 'variant.ts', 'category.ts', 'pricing.ts', 'media.ts', 'availability.ts'],
  search: ['indexer.ts', 'query-parser.ts', 'ranking.ts', 'synonyms.ts', 'facets.ts'],
  auth: ['session.ts', 'token.ts', 'password.ts', 'oauth.ts', 'mfa.ts', 'tenant.ts', 'rbac.ts', 'device.ts'],
  workers: ['queue.ts', 'scheduler.ts', 'retry.ts', 'reindex.ts', 'export.ts', 'cleanup.ts'],
  notifications: ['template.ts', 'digest.ts', 'preferences.ts', 'delivery-log.ts', 'webhook-out.ts'],
  analytics: ['events.ts', 'funnel.ts', 'cohort.ts', 'session-replay.ts'],
  admin: ['audit-log.ts', 'impersonate.ts', 'feature-flags.ts'],
  inventory: ['stock.ts', 'reservation.ts', 'warehouse.ts', 'restock.ts'],
}

/** A real-looking name for the nth filler file in a module. */
function fillerName(dir: string, index: number): string {
  const names = FILE_NAMES[dir]
  if (names === undefined) return `${dir}-${String(index)}.ts`
  const name = names[index % names.length]
  return index < names.length ? name : name.replace(/\.tsx?$/, `-${String(index)}$&`)
}

/** Forty lines of plausible filler — area is measured in lines. */
function filler(n: number): string {
  return Array.from({ length: 40 }, (_v, i) => `export const v${String(n)}_${String(i)} = ${String(i)}`).join('\n') + '\n'
}

/** Write the feature markdown + every file its anchors stand on. */
export function seedFeatures(root: string): void {
  const dir = join(root, 'flow', 'brain', 'features')
  mkdirSync(dir, { recursive: true })
  for (const feature of FEATURES) {
    const padAnchors = feature.pad.flatMap(([dir, count]) =>
      Array.from({ length: count }, (_v, i) => `${dir}/${fillerName(dir, i)}`),
    )
    const anchors = [...feature.anchors, ...padAnchors]
    for (const [index, rel] of anchors.entries()) {
      mkdirSync(join(root, rel.split('/').slice(0, -1).join('/')), { recursive: true })
      writeFileSync(join(root, rel), filler(index))
    }
    const partSection =
      feature.parts === undefined
        ? []
        : [
            '## Parts',
            '',
            ...feature.parts.flatMap(([name, summary, anchor]) => [
              `### ${name}`,
              summary,
              `anchors: ${anchor}`,
              '',
            ]),
          ]
    writeFileSync(
      join(dir, `${feature.slug}.md`),
      [
        '---',
        `id: feature:${feature.slug}`,
        `name: ${feature.name}`,
        'kind: core',
        `anchors: [${anchors.join(', ')}]`,
        'relates: []',
        `lastFullRead: ${feature.unread === true ? 'null' : new Date().toISOString()}`,
        'patchCount: 0',
        '---',
        '',
        `# ${feature.name}`,
        '',
        feature.summary,
        '',
        ...partSection,
      ].join('\n'),
    )
  }
}

/**
 * Run a git command ONCE and swallow a non-zero exit — for commands whose
 * failure is the point (`git merge` on a seeded conflict). Retrying that would
 * re-run the merge against an already-conflicted index and report the wrong
 * error.
 */
export function gitTry(root: string, args: string[]): void {
  try {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  } catch {
    /* expected */
  }
}

/**
 * File the queue items through the CLI the app itself spawns.
 *
 * Deliberately not a hand-written JSONL: the ledger's on-disk shape (seq ids,
 * state, dedup key) is the CLI's business, and a fixture that guessed it would
 * be a fixture that silently drifts from the reader. Slower, and correct.
 */
export function seedQueue(root: string): void {
  // THREE levels up: this file is e2e/ux/fixtures/, and the bundled CLI lives
  // at app/resources/cli/. Two levels reaches e2e/, where nothing exists — and
  // because the loop below swallows failures, getting this wrong produced a
  // board whose Todo lane read "Nothing here yet" with no error anywhere.
  const cli = join(__dirname, '..', '..', '..', 'resources', 'cli', 'planflow-ai.mjs')
  if (!existsSync(cli)) throw new Error(`seedQueue: no CLI at ${cli}`)
  for (const item of QUEUE_ITEMS) {
    execFileSync(
      process.execPath,
      [cli, 'loop', 'file', '--loop', 'find', '--title', item.title, '--body', item.body],
      { cwd: root, stdio: 'ignore' },
    )
  }
}

/**
 * The CHANGE records — plans that touched a capability.
 *
 * These are what make a feature able to say *what is coming to it*. The join is
 * exact rather than heuristic: `proposal.plan → change node (same slug) → its
 * parent feature`. Without a change node named for the plan, a proposal has no
 * capability to belong to and the feature's "coming" row stays empty — which is
 * why the fixture seeds the change alongside the proposal that references it.
 */
const CHANGES: Array<[slug: string, name: string, parent: string]> = [
  ['usage_billing', 'Usage-based billing', 'billing-invoicing'],
  ['dunning_v2', 'Dunning v2', 'payments'],
]

export function seedChanges(root: string): void {
  const dir = join(root, 'flow', 'brain', 'features')
  mkdirSync(dir, { recursive: true })
  for (const [slug, name, parent] of CHANGES) {
    writeFileSync(
      join(dir, `${slug}.md`),
      [
        '---',
        `id: feature:${slug}`,
        `name: ${name}`,
        'kind: child',
        // AN ID, NOT A SLUG. The graph resolves a change's parent with
        // `byId.has(feature.parent)`, so a bare slug silently fails to attach
        // and the change lands in the board's "could not be identified" footer.
        `parent: feature:${parent}`,
        'anchors: []',
        'relates: []',
        'lastFullRead: null',
        'patchCount: 0',
        '---',
        '',
        `# ${name}`,
        '',
        'A plan that touched this capability — carried in the graph for its',
        'parent link, and never drawn as a cell.',
        '',
      ].join('\n'),
    )
  }
}

/** Commit everything on disk, so the tree is clean before a changeset is made. */
export function commitBaseline(root: string): void {
  gitIn(root, ['config', 'user.email', 'shots@flow.test'])
  gitIn(root, ['config', 'user.name', 'Flow'])
  for (const [rel] of CHANGED) {
    mkdirSync(join(root, rel.split('/')[0]), { recursive: true })
    if (!existsSync(join(root, rel))) writeFileSync(join(root, rel), '// TODO\n')
  }
  gitIn(root, ['add', '-A'])
  gitIn(root, ['commit', '-q', '-m', 'acme-shop baseline'])
}

/** Write the real changeset over the committed baseline — 23 modified, 3 new. */
export function dirtyChangeset(root: string): void {
  for (const [rel, content] of CHANGED) writeFileSync(join(root, rel), content)
  for (const [rel, content] of ADDED) {
    mkdirSync(join(root, rel.split('/')[0]), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
}

/** A producer and a consumer loop, both on a LOCAL ledger queue — no network,
 *  no `gh`, no credentials. Mirrors the loops the site will describe. */
export function seedLoops(root: string): void {
  mkdirSync(join(root, 'loops'), { recursive: true })
  mkdirSync(join(root, 'flow', 'loops'), { recursive: true })
  writeFileSync(
    join(root, 'loops', 'find.md'),
    [
      '---',
      'loop: find',
      'engine: producer',
      'mission: Find gaps and cleanup targets in the checkout path',
      'queue: ledger',
      'path: flow/loops/queue.jsonl',
      'paused: false',
      'scope: [billing/, payments/, orders/]',
      'slice: changed',
      'topic: checkout',
      'max_open_issues: 8',
      'max_run_minutes: 25',
      '---',
      '',
      '## Direction',
      '',
      'Sweep the money path — billing, payments, orders. A good finding is one a',
      'reader can reproduce from the file and line it names.',
      '',
      '## Rules',
      '',
      'Reproduce before you believe it. File what survives; never narrate a sweep',
      'into the thread.',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(root, 'loops', 'fix.md'),
    [
      '---',
      'loop: fix',
      'engine: consumer',
      'mission: Take work off the list and finish it',
      'queue: ledger',
      'path: flow/loops/queue.jsonl',
      'paused: false',
      'topic: checkout',
      'max_open_issues: 8',
      '---',
      '',
      '## Direction',
      '',
      'Claim one item, judge it big or small, and either fix it directly or drive',
      'the full pipeline on autopilot.',
      '',
    ].join('\n'),
  )
  writeFileSync(join(root, 'flow', 'loops', 'queue.jsonl'), '')
}
