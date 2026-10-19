// feature-view-session — generates the curated feature view (feature-view #2).
//
// The approved prototype (flow/references/blueprint-feature-view-mock.html) was
// produced by READING plan_chat_session_cache_rework_v1.md. This is that pass: it
// reads a feature's plan, its discovery documents and its anchored code, and
// emits the Phase 1 contract — components with semantic kinds and human titles,
// LABELLED edges, per-component prose, code excerpts, refs and brief slots.
//
// Same discipline as the learn pass: the session is caged (Read/Grep/Glob), and
// the executor performs every write.
//
// THE ANTI-FABRICATION RULE (task 2.3). The model names a code excerpt by FILE
// AND LINE RANGE; it never supplies the text. The executor reads those lines
// from disk. A drawer showing invented code would be the worst failure this
// surface can have — it looks exactly like proof — and the only reliable
// defence is to never let the model's prose become the excerpt.
//
// ONE PASS, BOTH ARTIFACTS
// ========================
// This used to be half of a pair. A second, independent pass ("Learn this
// feature") wrote the feature's `## Learned` section from THE SAME ranked
// files — `rankModuleFiles` is imported from the learn session right below —
// and a reader had to choose which internal store got written. That split was
// implementation-shaped: two plans built two stores at different times, and
// the board then reported a feature with the richest artifact the system can
// produce as unexamined.
//
// So the prose is now a STEP OF THIS PASS rather than a second session. The
// same read produces the picture and the facts; the executor writes both. Two
// sessions over the same files was pure waste, and it was also the reason the
// two artifacts could disagree about what the code says.
//
// EVERY EXIT NAMES WHICH HALF LANDED. The two writes are independent — the
// view goes through the validator, the learnings through the store's boundary
// parser — so either can be refused alone. A caller must never have to guess:
// see `FeatureViewPassResult`.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

import { runCagedSession, runBundledCliCapturing, type ModuleFile, type RankCaps } from './learn-session'
import {
  rankModuleFiles,
  extractJsonObject,
  errorMessage,
  isTurnExhaustion,
  FEATURE_EDGE_MAX,
  FEATURE_LEARNING_MAX,
  parseFeatureLearnEdges,
  parseFeatureLearnOutput,
  renderFeatureRoster,
  type FeatureEdgeProposal,
  type FeatureRosterEntry,
} from './learn-session'
import type { BundledCli } from '../blueprint/derive-runner'
import { PORTS_EXAMPLE_LINE, viewPortsPromptLines } from '../../shared/feature-view-ports-prompt'

/** Components one view may carry before it stops being readable. */
export const VIEW_NODE_MAX = 10

/** Parameters for one view-generation pass. */
export interface FeatureViewPassParams {
  rootPath: string
  /** Feature id or slug — what `blueprint features view --feature` takes. */
  featureRef: string
  featureName: string
  /** The feature's anchored files. */
  files: readonly ModuleFile[]
  /** Repo-relative plan/discovery docs describing this feature. */
  planDocs?: readonly string[]
  /**
   * The OTHER features in this project — the vocabulary a relationship may use.
   *
   * This is the pass that actually learns a feature in the IDE, so it is the
   * one that must be able to name the other side. Absent or empty ⇒ the prompt
   * is exactly what it was before rosters existed.
   */
  roster?: readonly FeatureRosterEntry[]
  provenance?: string
  model?: string
  maxTurns?: number
  caps?: RankCaps
  bundledCli: BundledCli
  abortSignal?: AbortSignal
  authEnv?: NodeJS.ProcessEnv
  onRead?: (filePath: string) => void
  /**
   * Called as the session works — 'thinking', 'writing', 'tool', 'error'.
   *
   * READING IS THE SHORT HALF. A pass reads its files in the first minute and
   * then spends several composing the drawing and the learnings, during which
   * it opens no file at all. A caller that watches `onRead` alone sees that as
   * silence — which is how a watchdog built on reads killed a healthy pass at
   * exactly the moment it started doing the work. The module pass has always
   * wired both; this one could not, because the parameter stopped here.
   */
  onActivity?: (kind: string, detail?: string) => void
  now?: () => Date
}

/**
 * What the pass did — HALF BY HALF.
 *
 * `ok` is still "the picture landed", because that is what the board's running
 * indicator settles on. It is deliberately NOT "everything worked": a run that
 * drew the view and could not write the prose is a real, reportable state, and
 * flattening it into one boolean is how a user ends up told nothing.
 */
export interface FeatureViewPassResult {
  /** The curated view was validated and persisted. */
  ok: boolean
  /** Components written, for the completion toast. */
  components?: number
  /**
   * Learnings persisted to the feature's `## Learned`.
   *
   * `0` is an honest answer twice over — the pass found nothing non-obvious, or
   * the write was refused — which is exactly why `learningsFailed` exists
   * beside it rather than being inferred from a zero.
   */
  learnings?: number
  /** The learnings half was ATTEMPTED and refused. See `reason`. */
  learningsFailed?: boolean
  /**
   * What to tell the user, naming which half landed whenever they differ.
   * Present on every partial outcome; absent only when both halves went
   * through cleanly with nothing worth mentioning.
   */
  reason?: string
}

/**
 * Build the generation prompt.
 *
 * Names the contract, gives the mock's own vocabulary as the example, and states
 * the two rules that keep the picture honest: the CODE wins over a document,
 * and an excerpt is named by line range rather than quoted.
 */
export function buildFeatureViewPrompt(input: {
  featureName: string
  rankedFiles: readonly ModuleFile[]
  planDocs?: readonly string[]
  roster?: readonly FeatureRosterEntry[]
}): string {
  const docs = input.planDocs ?? []
  const hasRoster = (input.roster ?? []).length > 0
  return [
    `You are drawing the architecture of the feature "${input.featureName}" for an engineer who has never seen it.`,
    '',
    'Read the files below, then describe how the feature ACTUALLY WORKS as a small',
    'diagram: the components involved and the labelled connections between them.',
    '',
    ...(docs.length === 0
      ? [
          'THERE IS NO PLAN FOR THIS FEATURE, so you are drawing what it IS rather',
          'than what is changing about it. Name its PARTS the way someone who works',
          'on it would say them out loud — "SSE stream", "chat SDK client", "message',
          'renderer", "history store" — not the directories they happen to live in.',
          'Each part gets `doc` prose saying what it does and why it exists, and',
          'every `delta` is "stable": nothing is changing here.',
          'A reader who opens this should come away able to say what the feature is',
          'made of and how a request travels through it.',
          '',
        ]
      : []),
    ...(docs.length > 0
      ? [
          'Plan and discovery documents — READ THESE FIRST. They carry the problem,',
          'the decisions and the known failure modes, none of which the code states',
          'about itself:',
          docs.map((doc) => `- ${doc}`).join('\n'),
          '',
        ]
      : []),
    'Code (ranked; read what you need):',
    input.rankedFiles.map((file) => `- ${file.path}`).join('\n'),
    '',
    'RULES',
    `- At most ${String(VIEW_NODE_MAX)} components. This is a diagram, not an inventory.`,
    '- Title components the way an engineer would say them out loud: "Gateway BFF",',
    '  "Agent core engine", "Prisma" — never a directory path.',
    '- `title` is AT MOST FOUR WORDS and carries no separators. Everything else —',
    '  the function name, the route, the table list — goes in `sub`. A title that',
    '  runs on does not fit on a card, and the card is the whole surface.',
    '- EVERY connection needs a label saying what flows: "send message", "SSE tokens",',
    '  "write USER + finalize". An unlabelled arrow explains nothing.',
    '- Keep a label under ~40 characters. It is drawn ON the wire, not in a tooltip.',
    '- Where a document contradicts the code, the CODE is right. Say so in the doc field.',
    '- For a code excerpt, give file + first/last LINE NUMBERS only. Do NOT quote the',
    '  code; it is read from disk. Quoting from memory produces invented evidence.',
    '- A code excerpt must point at SOURCE, never at a plan or discovery document.',
    '  Use the documents to write `doc` and `note`; cite code for the excerpt.',
    '  An excerpt naming a .md file is DROPPED — the component loses its evidence.',
    '- When the plan has numbered phases, give every component it touches a',
    '  `phases` array. The reader selects a phase to see what it reaches; a',
    '  component with no phases is one the rollout never lights up.',
    '- Give a component a nested `views` level ONLY when there is a second',
    '  diagram genuinely inside it — its own parts and their own labelled',
    '  connections. Point at it with `view`. A level that just restates the',
    '  component is a door onto a wall.',
    '',
    // ENTRIES AND EXITS (plan `diagram-entry-exit` phase 2). The lines are the
    // CLI's own, so the cap the prompt states is the cap the validator refuses.
    ...viewPortsPromptLines(),
    // THE PROSE HALF. Same read, same session — see the header. These are the
    // facts a person keeps; the diagram is the shape. Asking for them here
    // rather than in a second pass is the whole point of the collapse.
    'LEARNINGS — the other half of the same answer',
    'Alongside the diagram, record what you LEARNED about how this feature',
    'actually behaves. A learning is ONE SENTENCE stating something non-obvious',
    'and specific that is TRUE of this code.',
    'Good: "Reload can duplicate a completed turn because the streamed message id',
    'differs from the persisted row id."',
    'Bad: "This feature handles chats." (says nothing) —',
    '"useMessageCatchup exists." (the code already says that)',
    `- At most ${String(FEATURE_LEARNING_MAX)} learnings. Fewer is better than padded.`,
    '- Every learning must be grounded in a file you actually read. Never invent behaviour.',
    '- No newlines inside a learning — one line each.',
    '- Prefer a learning that explains WHY or HOW the system behaves as it does',
    '  over one that restates a file. An EMPTY list is a valid, honest answer.',
    // THE RELATIONSHIP HALF. Same read again: this pass is looking at ONE
    // capability's code, which is precisely when a connection to another
    // capability is visible on the page — and the only moment somebody can
    // write down HOW they connect.
    ...renderFeatureRoster(input.roster ?? []),
    '',
    'Reply with ONLY a single JSON object — no prose, no code fence:',
    '{',
    '  "meta": { "title": "<what this feature is called in conversation>", "sub": "<one clause>" },',
    '  "learnings": ["<one non-obvious sentence>", "<another>"],',
    ...(hasRoster
      ? [
          '  "relates": [{"target": "<an id from the list above>", "via": "<the file or file.ts#symbol where you saw it>", "note": "<one line: how they connect>"}],',
        ]
      : []),,
    '  "brief": {',
    '    "problem": "<the known issue today, or omit when there is none>",',
    '    "unchanged": "<what this feature guarantees stays the same, or omit>",',
    '    "todayHow": [["yes", "<how it works today>"]],',
    '    "todayProblems": [["bad", "<a real problem, grounded in what you read>"]]',
    '  },',
    '  "views": {',
    '    "root": {',
    '      "title": "<title>", "kicker": "<Level 0 · …>",',
    '      "summary": "<two sentences on how it works today>",',
    PORTS_EXAMPLE_LINE,
    '      "nodes": [',
    '        { "id": "bff", "kind": "endpoint", "title": "Gateway BFF", "sub": "streamTurn",',
    '          "delta": "stable", "doc": "<what it is and why it matters>",',
    '          "phases": [2, 3], "view": "<nested level id, only when one exists>",',
    '          "code": { "file": "<repo-relative>", "from": 851, "to": 857, "note": "<why THIS code matters>" },',
    '          "refs": [["<file or symbol>", "<what it shows>"]] }',
    '      ],',
    '      "edges": [ { "from": "browser", "to": "bff", "label": "send message", "delta": "kept" } ]',
    '    }',
    '  }',
    '}',
    '',
    ...(hasRoster
      ? [
          '',
          '"relates" — one entry per connection to a listed feature that you ACTUALLY SAW in the code:',
          `- At most ${String(FEATURE_EDGE_MAX)} of them. Omit "relates" entirely if you saw none.`,
          '- "target" must be copied EXACTLY from the list above. An id that is not on the list is refused.',
          '- "via" is the MECHANISM — the repo-relative file (or `file.ts#symbol`) where the connection is made.',
          '- "note" answers "how do these two connect?" for somebody who will never open the other feature.',
          '',
        ]
      : []),
    'kind ∈ project | endpoint | integration | datastore | function | module',
    'delta ∈ stable | modify | new | remove   (use "stable" unless a plan changes it)',
    'edge delta ∈ kept | added | removed',
  ].join('\n')
}

/** Narrow the model's output to the contract. Null when it did not answer. */
export function parseFeatureViewOutput(raw: string): Record<string, unknown> | null {
  const candidate = extractJsonObject(raw)
  if (candidate === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const views = record['views']
  if (typeof views !== 'object' || views === null) return null
  return record
}

/**
 * Replace every code excerpt's text with the REAL lines from disk.
 *
 * This is the anti-fabrication rule made mechanical. The model supplies a file
 * and a range; whatever text it may have volunteered is discarded and the lines
 * are read. An excerpt naming a file that does not exist, or a range past its
 * end, is DROPPED — the component keeps its prose and loses only the snippet,
 * which is strictly better than showing code that was never there.
 *
 * Returns the count dropped so the caller can report it rather than hide it.
 */
export function fillCodeExcerpts(
  view: Record<string, unknown>,
  repoRoot: string,
): { dropped: number } {
  let dropped = 0
  const views = view['views']
  if (typeof views !== 'object' || views === null) return { dropped }
  for (const level of Object.values(views as Record<string, unknown>)) {
    if (typeof level !== 'object' || level === null) continue
    const nodes = (level as Record<string, unknown>)['nodes']
    if (!Array.isArray(nodes)) continue
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) continue
      const record = node as Record<string, unknown>
      const code = record['code']
      if (typeof code !== 'object' || code === null) continue
      const spec = code as Record<string, unknown>
      const file = spec['file']
      const from = spec['from']
      const to = spec['to']
      if (typeof file !== 'string' || typeof from !== 'number' || typeof to !== 'number') {
        delete record['code']
        dropped += 1
        continue
      }
      // A CODE excerpt must be code. The pass reads plan/discovery markdown for
      // the WHY, and the model sometimes cites those lines as the evidence —
      // real lines, but rendering prose inside a code box presents an argument
      // as an implementation. Dropped, not refused: the component keeps its
      // doc, which is where that prose belonged all along.
      if (/\.(md|mdx|txt|rst)$/i.test(file)) {
        delete record['code']
        dropped += 1
        continue
      }
      const abs = join(repoRoot, file)
      if (!existsSync(abs)) {
        delete record['code']
        dropped += 1
        continue
      }
      let lines: string[]
      try {
        lines = readFileSync(abs, 'utf-8').split('\n')
      } catch {
        delete record['code']
        dropped += 1
        continue
      }
      if (from < 1 || to < from || to > lines.length) {
        delete record['code']
        dropped += 1
        continue
      }
      // The excerpt is the FILE's content, never the model's.
      spec['text'] = lines.slice(from - 1, to).join('\n')
    }
  }
  return { dropped }
}

/**
 * Persist the prose half through the store's own writer.
 *
 * `blueprint features learned` rather than fs, for the same reason the view
 * goes through `features view --write`: the store owns the boundary parser
 * that stands between a machine pass and an unrecoverable overwrite of human
 * prose, and its refusal (an ambiguous `## Learned`, a hand-edited section) is
 * a verdict this pass must report rather than route around.
 */
async function writeLearnings(
  params: FeatureViewPassParams,
  runCli: typeof runBundledCliCapturing,
  learnings: readonly string[],
  edges: readonly FeatureEdgeProposal[],
  date: string,
): Promise<{ ok: boolean; error?: string }> {
  const provenance = params.provenance ?? 'code'
  const args = ['blueprint', 'features', 'learned', '--feature', params.featureRef]
  for (const text of learnings) {
    args.push('--entry', JSON.stringify({ text, provenance, date }))
  }
  // `relates` rides the SAME write. It is machine-owned like the section, the
  // store validates every target against its own roster, and one invocation
  // means the facts and the relationships can never half-land.
  if (edges.length > 0) args.push('--relates', JSON.stringify(edges))
  const written = await runCli(params.bundledCli, params.rootPath, args)
  return written.ok ? { ok: true } : { ok: false, error: written.error ?? 'unknown' }
}

/**
 * Is a refused `features view --write` refusing over the view's PORTS?
 *
 * Recognised by the validator's own port wording (`validatePorts` /
 * `validatePort` in src/cli/blueprint/feature-view.ts): every port error names
 * an `in-port N` / `out-port N`, the `ports` object or a port side. The full
 * stderr tail is read because `error` holds only the last refusal line.
 */
const PORT_REFUSAL = /\b(?:in|out)-port \d+\b|\bhas ports that\b|\bports\.(?:in|out)\b|\bhas a port side\b/

export function refusalIsAboutPorts(result: { error?: string; stderr?: string }): boolean {
  return PORT_REFUSAL.test(`${result.error ?? ''}\n${result.stderr ?? ''}`)
}

/**
 * Remove `ports` from every level of a view, in place, returning how many
 * ports went with them. In place on purpose: the view is this pass's own draft,
 * never a caller's record.
 */
export function stripViewPorts(view: Record<string, unknown>): number {
  const views = view['views']
  if (typeof views !== 'object' || views === null) return 0
  let removed = 0
  for (const level of Object.values(views as Record<string, unknown>)) {
    if (typeof level !== 'object' || level === null) continue
    const record = level as Record<string, unknown>
    if (!('ports' in record)) continue
    const ports = record['ports']
    if (typeof ports === 'object' && ports !== null) {
      for (const side of Object.values(ports as Record<string, unknown>)) {
        removed += Array.isArray(side) ? side.length : 1
      }
    } else {
      removed += 1
    }
    delete record['ports']
  }
  return removed
}

/**
 * Generate and persist a feature's curated view AND its learnings.
 *
 * The CLI validates and writes (Phase 1), so a contract violation — a line from
 * nowhere, a dead drill target, an out-of-range excerpt — refuses the whole
 * artifact and surfaces verbatim. Nothing half-drawn ever reaches the board.
 *
 * BOTH HALVES ARE ALWAYS ATTEMPTED, and the result says which landed. They are
 * independent artifacts with independent writers: a view the validator refuses
 * says nothing about whether the facts are worth keeping, so a refused picture
 * must not silently take the prose down with it. The reverse holds too — this
 * is the every-exit-reports discipline `drawFeatureView` already keeps, applied
 * one layer down where the two writes actually happen.
 */
export async function runFeatureViewPass(
  params: FeatureViewPassParams,
  deps: { runSession?: typeof runCagedSession; runCli?: typeof runBundledCliCapturing } = {},
): Promise<FeatureViewPassResult> {
  const ranked = rankModuleFiles(params.files, params.caps)
  if (ranked.length === 0 && (params.planDocs ?? []).length === 0) {
    return { ok: false, reason: 'this feature claims no readable files or documents' }
  }
  // A feature cannot relate to itself, so it is never handed its own name.
  // `featureRef` is an id OR a slug (that is what the CLI verb takes), so both
  // are compared — matching only one would leave the subject in half the time.
  const roster = (params.roster ?? []).filter(
    (entry) => entry.id !== params.featureRef && entry.id !== `feature:${params.featureRef}`,
  )
  const prompt = buildFeatureViewPrompt({
    featureName: params.featureName,
    rankedFiles: ranked,
    ...(params.planDocs !== undefined ? { planDocs: params.planDocs } : {}),
    ...(roster.length > 0 ? { roster } : {}),
  })
  const runSession = deps.runSession ?? runCagedSession
  const runCli = deps.runCli ?? runBundledCliCapturing

  const session = (text: string): Promise<string> =>
    runSession({
      cwd: params.rootPath,
      prompt: text,
      model: params.model,
      maxTurns: params.maxTurns,
      abortSignal: params.abortSignal,
      authEnv: params.authEnv,
      onRead: params.onRead,
      onActivity: params.onActivity,
    })

  let raw: string
  try {
    raw = await session(prompt)
  } catch (error) {
    if (!isTurnExhaustion(error)) {
      return { ok: false, reason: `view session failed: ${errorMessage(error)}` }
    }
    raw = ''
  }

  let view = parseFeatureViewOutput(raw)
  if (view === null) {
    try {
      raw = await session(
        `${prompt}\n\nIMPORTANT: your previous attempt did not produce a single valid JSON object. Respond with ONLY the JSON object. If you are low on turns, answer from what you have already read.`,
      )
    } catch (error) {
      return { ok: false, reason: `view session failed on retry: ${errorMessage(error)}` }
    }
    view = parseFeatureViewOutput(raw)
  }
  if (view === null) {
    return { ok: false, reason: 'view session did not return the agreed JSON shape' }
  }

  // THE PROSE HALF, read off the SAME reply. `parseFeatureLearnOutput` is the
  // learn pass's own parser, imported rather than reimplemented: one set of
  // normalization rules (single line, trimmed, capped) means the facts this
  // pass writes are indistinguishable from the ones the retired second pass
  // wrote. `null` means the model named no `learnings` key at all, which is
  // the same honest answer as an empty list.
  const learnings = parseFeatureLearnOutput(raw) ?? []
  // THE RELATIONSHIPS, off that same reply. The store judges every target
  // against its own roster (`writeEdges`), so a name this pass could not have
  // resolved is refused there rather than trusted here.
  const edges = parseFeatureLearnEdges(raw)
  // Never part of the artifact. The view is validated as a picture, and a stray
  // key riding along in the stored JSON would be a second, unvalidated place
  // the prose lives.
  delete view['learnings']
  delete view['relates']

  const { dropped } = fillCodeExcerpts(view, params.rootPath)
  const now = params.now ? params.now() : new Date()
  const date = now.toISOString().slice(0, 10)
  view['provenance'] = params.provenance ?? 'code'
  view['generatedAt'] = date

  const writeView = (candidate: Record<string, unknown>): ReturnType<typeof runCli> =>
    runCli(params.bundledCli, params.rootPath, [
      'blueprint',
      'features',
      'view',
      '--feature',
      params.featureRef,
      '--write',
      JSON.stringify(candidate),
    ])
  let written = await writeView(view)
  // A BAD PORT MUST NOT COST THE PICTURE (plan `diagram-entry-exit` phase 2).
  // The validator refuses the whole view over one port that touches an absent
  // component or cites a function its file never mentions — right for the
  // artifact, wasteful for the pass: the diagram itself was fine. So when the
  // refusal is about ports, and only then, the ports are stripped from every
  // level and the view is written once more. The drop is reported, never quiet.
  let portsDropped = 0
  if (!written.ok && refusalIsAboutPorts(written)) {
    portsDropped = stripViewPorts(view)
    if (portsDropped > 0) {
      console.warn(
        `[feature-view] ${params.featureRef}: ${String(portsDropped)} port(s) refused — ${written.error ?? 'unknown'}; writing the view without them`,
      )
      written = await writeView(view)
    }
  }

  // ATTEMPTED WHETHER OR NOT THE PICTURE LANDED. An empty list writes nothing
  // and is not a failure — the section keeps whatever it had rather than being
  // emptied by a quiet pass, exactly as the learn pass behaved.
  const learned =
    learnings.length === 0 && edges.length === 0
      ? { ok: true }
      : await writeLearnings(params, runCli, learnings, edges, date)
  const learningsWritten = learned.ok ? learnings.length : 0

  if (!written.ok) {
    // THE PICTURE WAS REFUSED. Say so — and say what survived, because "could
    // not write the view" alone would leave a user believing the whole pass
    // produced nothing while their `## Learned` section had just grown.
    const why = `could not write the view: ${written.error ?? 'unknown'}`
    return {
      ok: false,
      learnings: learningsWritten,
      ...(learned.ok ? {} : { learningsFailed: true }),
      reason:
        learningsWritten > 0
          ? `${why} — ${String(learningsWritten)} learning(s) were still written`
          : learned.ok
            ? why
            : `${why}; the learnings were refused too — ${learned.error ?? 'unknown'}`,
    }
  }

  const root = (view['views'] as Record<string, unknown>)['root']
  const nodes =
    typeof root === 'object' && root !== null && Array.isArray((root as Record<string, unknown>)['nodes'])
      ? ((root as Record<string, unknown>)['nodes'] as unknown[]).length
      : 0
  const notes: string[] = []
  if (dropped > 0) notes.push(`${String(dropped)} excerpt(s) dropped as unverifiable`)
  if (portsDropped > 0) notes.push(`${String(portsDropped)} entry/exit port(s) dropped as unverifiable`)
  // THE PICTURE LANDED, THE PROSE DID NOT. Reported on the success path, not
  // swallowed by it: the board lights up either way now (a valid view counts as
  // understanding), so a silent refusal here would be invisible forever.
  if (!learned.ok) {
    notes.push(`the drawing landed, but the learnings were refused — ${learned.error ?? 'unknown'}`)
  }
  return {
    ok: true,
    components: nodes,
    learnings: learningsWritten,
    ...(learned.ok ? {} : { learningsFailed: true }),
    ...(notes.length > 0 ? { reason: notes.join(' · ') } : {}),
  }
}

/**
 * Turn a drawn view's components into the feature's PARTS.
 *
 * The drawing pass already does the hard half of decomposition: it reads the
 * code and names the pieces an engineer would name — "Live events SSE", "Chat
 * SDK", "History store" — instead of the directories they live in. Those names
 * are the parts. What the drawing does NOT do is learn them, which is the whole
 * point of making them parts: each one then gets investigated in its own right,
 * against its own anchors, with its own staleness.
 *
 * ANCHORS COME FROM WHAT THE COMPONENT CITED, never from its name. A part whose
 * anchors were guessed from its title would send a learn pass to read the wrong
 * files and record confident findings about code that has nothing to do with
 * it. A component that cited nothing yields no part — better to have fewer
 * parts than parts nobody can check.
 */
export function derivePartsFromView(view: unknown): Array<{
  name: string
  summary: string
  anchors: string[]
}> {
  if (typeof view !== 'object' || view === null) return []
  const views = (view as Record<string, unknown>)['views']
  if (typeof views !== 'object' || views === null) return []
  const root = (views as Record<string, unknown>)['root']
  if (typeof root !== 'object' || root === null) return []
  const nodes = (root as Record<string, unknown>)['nodes']
  if (!Array.isArray(nodes)) return []

  const parts: Array<{ name: string; summary: string; anchors: string[] }> = []
  for (const raw of nodes) {
    if (typeof raw !== 'object' || raw === null) continue
    const node = raw as Record<string, unknown>
    const title = typeof node['title'] === 'string' ? node['title'].trim() : ''
    if (title.length === 0) continue

    const anchors = new Set<string>()
    const code = node['code']
    if (typeof code === 'object' && code !== null) {
      const file = (code as Record<string, unknown>)['file']
      if (typeof file === 'string' && file.trim().length > 0) anchors.add(file.trim())
    }
    // `refs` are the component's cited evidence. A ref that names a path is an
    // anchor; one that names a symbol is prose and cannot be read from disk.
    const refs = node['refs']
    if (Array.isArray(refs)) {
      for (const ref of refs) {
        if (!Array.isArray(ref) || typeof ref[0] !== 'string') continue
        const target = ref[0].trim().replace(/[`'"]/g, '')
        if (target.includes('/') && !target.includes(' ')) anchors.add(target)
      }
    }
    if (anchors.size === 0) continue

    const doc = typeof node['doc'] === 'string' ? node['doc'].trim() : ''
    parts.push({
      name: title,
      // One clause, not the whole paragraph: the summary sits under a heading
      // in a file a person reads, and the full prose lives in the view.
      summary: doc.split(/(?<=\.)\s/)[0]?.trim() ?? '',
      anchors: [...anchors],
    })
  }
  return parts
}

/** A file a learn pass can read. */
export interface AnchorFile {
  path: string
  size: number
}

/**
 * Resolve a part's anchors to the files a learn pass will actually read.
 *
 * AN ANCHOR IS A FILE OR A DIRECTORY, and the two resolve differently. The
 * drawing cites individual files far more often than directories — a component
 * points at `src/components/chat/ChatPanel/useChatPanelLogic.ts`, not at
 * a folder — and handing that to a module walker finds nothing. That is exactly
 * how ten parts were "learned" from ten empty file lists: ten model passes, zero
 * findings, and no error anywhere to say so.
 *
 * An anchor that no longer exists is SKIPPED, not fatal: a part whose other
 * anchors still resolve is worth learning from what remains, and a part left
 * with nothing is reported by the caller rather than silently learned from air.
 */
export async function resolvePartFiles(
  repoRoot: string,
  anchors: readonly string[],
  deps: {
    stat: (absPath: string) => { isFile: boolean; size: number } | null
    enumerate: (repoRoot: string, dir: string) => Promise<{ files: AnchorFile[] }>
  },
): Promise<{ files: AnchorFile[]; missing: string[] }> {
  const files: AnchorFile[] = []
  const missing: string[] = []
  const seen = new Set<string>()
  for (const anchor of anchors) {
    const info = deps.stat(join(repoRoot, anchor))
    if (info === null) {
      missing.push(anchor)
      continue
    }
    if (info.isFile) {
      if (!seen.has(anchor)) {
        seen.add(anchor)
        files.push({ path: anchor, size: info.size })
      }
      continue
    }
    const entry = await deps.enumerate(repoRoot, anchor)
    for (const file of entry.files) {
      if (seen.has(file.path)) continue
      seen.add(file.path)
      files.push(file)
    }
  }
  return { files, missing }
}
