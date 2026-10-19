/**
 * SHOOTING FLOW AGAINST FLOW'S OWN CODEBASE.
 *
 * The acme-shop world was too small for the UI to look like anything: ten
 * invented capabilities over ~150 generated files, which on a 2240px sheet is a
 * handful of enormous, nearly-empty rectangles. A treemap only says something
 * when there is real mass behind it. This repository has that mass — 1,868
 * files, 57 modules, 20 capabilities the team named itself — and using it makes
 * the site's "Flow builds Flow" claim literal instead of asserted.
 *
 * NOTHING HERE TOUCHES THE WORKING TREE. Everything runs against a throwaway
 * `git clone --local` of the repo, so the IDE may provision, derive, learn and
 * write as freely as it does in a real project without a single byte landing in
 * the checkout somebody is working in.
 *
 * TWO PIECES OF STATE ARE SEEDED, and both are demo state rather than fact:
 *
 *  1. `lastFullRead` on most features. The real store has it null everywhere —
 *     nobody has run Learn over this repo — so an unseeded shot reports "0 of
 *     20 features · 0%", which is true of the repo and useless as a picture of
 *     the product. The clone is set to the state of a project whose team HAS
 *     learned it.
 *  2. One learned document (`flow/brain/code/tasks.md`). It is written from the
 *     real modules it describes, but it was written here, not produced by a
 *     learn pass.
 *
 * Anything else on screen — the names, the sizes, the module graph, the file
 * tree, the line counts — is this repository, unedited.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** The repo this file lives in: e2e/ux/fixtures → app → repo root. */
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')

/** Where the real (symlinked-out) brain vault keeps this project's knowledge. */
const REAL_BRAIN = join(REPO_ROOT, 'flow', 'brain')

/** Capabilities left unlearned, so the sheet shows all three states at once. */
const UNREAD = new Set(['terminal', 'update-claude-models', 'fixing-discovery-view', 'unattended-auto-branch'])

/**
 * A learned document for the Tasks Board, written from the modules it names.
 *
 * The knowledge pillar needs a real document to show and the repo has none, so
 * this is fixture content — accurate about the code, but authored rather than
 * learned. Flagged in SITE-REFRESH.md so nobody later mistakes it for output.
 */
const TASKS_DOC = `# Tasks Board

**Purpose**: the IDE's kanban surface. Cards are 1:1 with agent threads; lanes
are \`todo | doing | blocked | review | done\`, with a Remote column in front of
them when a tracker is connected.

## Key flows
- **Take on**: a remote ticket opens as a card; taking it on is a deliberate
  second press, never a side effect of opening it
- **Work**: the card's thread runs the task; the card shows an accent pulse
  while the agent works and an amber chip the moment it needs a decision
- **Land**: a clean finish opens a pull request and moves the card to Review;
  Merge squash-merges it and advances it to Done

## Invariants (verified against code)
- Todo is a WINDOW onto whoever owns the list; Doing, Blocked, Review and Done
  are records this app wrote — \`items: null\` and \`items: []\` never collapse
- Dragging a queue item into Doing performs the same write a headless run
  performs, so a person and a loop cannot disagree about who holds an item
- \`agent_blocked_from\` is both the "the agent parked this" marker and the lane
  to restore to; NULL is the human's block

## Files
| file | role |
|---|---|
| board-model.ts | lanes, chips, grouping — every decision the board makes |
| board-render.ts | layout only; no \`if\` about a card's state |
| task-service.ts | creation across the task, thread and integration stores |
| board-loop.ts | opens the PR and moves the card to Review |

*Verified against 4 files · re-learns automatically on drift*
`

/**
 * An ISOLATED central vault for the shot run.
 *
 * A project's `flow/` is a symlink into `~/plan-flow/brain/projects/<name>/`,
 * keyed on the project's DIRECTORY NAME. The clone is called `plan-flow`, so
 * provisioning pointed it at the real vault and every seeded byte was ignored —
 * the shots came out byte-identical to an unseeded run, reading the live store.
 * Pointing `PLAN_FLOW_VAULT_DIR` at a temp directory gives the run a vault of
 * its own, and is also the only thing standing between a shot run and the
 * user's real knowledge store.
 */
export const SELF_VAULT = mkdtempSync(join(tmpdir(), 'flow-self-vault-'))

let cached: string | null = null

/**
 * A throwaway clone of this repository, seeded to a demo state.
 *
 * Built once per process and reused: a local clone is cheap (git hardlinks the
 * object store) but not free, and every shot wants the same world.
 */
export function flowSelfRepo(): string {
  if (cached !== null) return cached
  const dir = mkdtempSync(join(tmpdir(), 'flow-self-'))
  const target = join(dir, 'plan-flow')
  execFileSync('git', ['clone', '--local', '--quiet', REPO_ROOT, target], { stdio: 'ignore' })
  // The IDE-owned scaffold is untracked in the source repo, so a clone lacks it
  // and would otherwise dirty `git status` the moment provisioning runs.
  writeFileSync(join(target, '.git', 'info', 'exclude'), '.claude/\nflow\n.gitignore\nout/\n')
  seedBrain(target)
  cached = target
  return cached
}

/**
 * Copy the real feature store + derived graph in, then set the demo state.
 *
 * Written into the ISOLATED vault rather than the clone, because that is where
 * the app will look: provisioning replaces `<root>/flow` with a link to
 * `<vault>/projects/<name>/flow`, so anything written to the clone's own
 * directory is discarded the moment the project is added.
 */
function seedBrain(target: string): void {
  const project = target.split(/[\\/]/).pop() ?? 'plan-flow'
  const brain = join(SELF_VAULT, 'projects', project, 'flow', 'brain')
  mkdirSync(join(brain, '.structure'), { recursive: true })
  mkdirSync(join(brain, 'features'), { recursive: true })
  mkdirSync(join(brain, 'code'), { recursive: true })

  const realStructure = join(REAL_BRAIN, '.structure')
  for (const file of ['graph.json', 'file-tiers.json', 'proposals.jsonl', 'annotations.jsonl']) {
    const from = join(realStructure, file)
    if (existsSync(from)) cpSync(from, join(brain, '.structure', file))
  }

  const realFeatures = join(REAL_BRAIN, 'features')
  const learning: string[] = []
  for (const name of readdirSync(realFeatures)) {
    if (!name.endsWith('.md')) continue
    const slug = name.replace(/\.md$/, '')
    const body = readFileSync(join(realFeatures, name), 'utf8')
    // NOT EVERY FILE IN features/ IS A CAPABILITY. The folder also holds
    // archived plan records and auto-captured working sets, which the board
    // admits and draws — two of them turned up on the sheet as cells reading
    // "Project: plan-flow Status: archived Created: …". They are honest
    // artefacts of a live store and wrong in a product shot.
    if (/Status:\s*archived|^thread_id:|^capture:\s*brain/m.test(body)) continue
    // `lastFullRead` is the switch the CLI reads for "understood"
    // (feature-graph.ts: fullyRead = lastFullRead !== null && !== ''). The
    // `\r?` matters: these files are CRLF on Windows, so an anchored `$`
    // without it matches nothing and every capability stays at 0%.
    const read = !UNREAD.has(slug)
    writeFileSync(
      join(brain, 'features', name),
      read
        ? body.replace(/^lastFullRead: null\r?$/m, `lastFullRead: ${new Date().toISOString()}`)
        : body,
    )
  }

  // Module-level learning state, keyed on the graph's own module labels.
  const graphPath = join(brain, '.structure', 'graph.json')
  if (existsSync(graphPath)) {
    const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as {
      nodes: Array<{ id: string; kind: string }>
    }
    const modules = graph.nodes.filter((n) => n.kind === 'module').map((n) => n.id.replace(/^module:/, ''))
    modules.forEach((module, i) => {
      // Four in five learned, one stale — enough for every state to show.
      const status = i % 5 === 4 ? 'stale' : 'learned'
      learning.push(JSON.stringify({ module, status, notedAt: new Date().toISOString() }))
    })
    writeFileSync(join(brain, '.structure', 'learning-state.jsonl'), learning.join('\n') + '\n')
  }

  writeFileSync(join(brain, 'code', 'tasks.md'), TASKS_DOC)
}

/** Tasks that read like this project's own board. */
export const SELF_TASKS: Array<{
  title: string
  description: string
  lane: 'todo' | 'doing' | 'blocked' | 'review' | 'done'
}> = [
  {
    title: 'Quote the code an edit changed',
    description:
      "An edit's expanded body should render as a red/green line diff instead of raw JSON, with a collapsed summary saying what changed rather than just the path.",
    lane: 'todo',
  },
  {
    title: 'Fold contiguous reads into one Gathered context row',
    description:
      'Consecutive read/grep/glob/websearch calls are one act of orientation, not six tool calls, and should read that way in the feed.',
    lane: 'todo',
  },
  {
    title: 'Mark the open thread in the sidebar',
    description:
      'A thread list where the conversation you are in looks identical to the others makes you re-read titles to find your place.',
    lane: 'todo',
  },
  {
    title: 'Name both model and effort in the composer',
    description: 'One menu for the pair, so the two settings that decide a turn are chosen together.',
    lane: 'todo',
  },
  {
    title: 'Group repeated tool cards in the chat feed',
    description:
      'A turn that edits one file N times stacks N identical Edit lines. Collapse consecutive same-tool, same-file calls under one expandable header that opens to the individual rows.',
    lane: 'doing',
  },
  {
    title: 'Search across file contents, not just names',
    description:
      'A Search rail and pane that searches file CONTENTS across the project scope and shows matching files with line snippets; clicking a match opens the file at the line.',
    lane: 'doing',
  },
  {
    title: 'Close the remote ticket when a promoted card reaches Done',
    description:
      'Blocked: needs the tracker write scope confirmed before it can close anything on a real board.',
    lane: 'blocked',
  },
  {
    title: 'A Review lane with the PR the loop opened',
    description:
      'When the board loop finishes a card cleanly it opens a pull request and moves the card to a Review lane between Blocked and Done, carrying a link and a one-click squash-merge.',
    lane: 'review',
  },
  {
    title: 'Settings as a page with tabs, not a modal',
    description:
      'Five groups split by what a person came to change — Models, Conversation files, Tasks, Integrations, App. A group with nothing in it loses its tab rather than offering an empty page.',
    lane: 'done',
  },
  {
    title: 'Empty the status bar; move autopilot into the composer',
    description:
      'autopilot on|off is the one always-visible answer to "will this act without asking me?", and it sat at the far corner of the window from the box you type into.',
    lane: 'done',
  },
]

/** Threads that read like this project's own. */
export const SELF_THREADS: Array<{ title: string; user?: string; assistant?: string }> = [
  {
    title: 'Tool cards group in the feed',
    user: 'A turn that edits one file six times stacks six identical Edit lines. Can we collapse them?',
    assistant:
      'Grouped consecutive same-tool, same-file calls under one expandable header (`Edited board-model.ts · 6 changes`).\n\nThe grouping is a pure, DOM-free model so it unit-tests without Monaco, and it runs live at the feed tail as well as on reconcile — otherwise a settled turn would group and an in-flight one would not.',
  },
  { title: 'Why is the Territory reporting 0% understood?' },
  { title: 'Remote column: what is mine, from the tracker' },
  { title: 'Conflict sides should name their branch' },
]
