#!/usr/bin/env node
/**
 * Brain-search benchmark — the runnable successor to the deleted
 * `scripts/brain-search-compare.mjs`.
 *
 * `docs/brain-search-comparison.md` records its own measurement as "history,
 * not a reproducible run", because the harness that produced it was deleted
 * with the index it measured. That is the deficiency this file closes: the 12
 * questions, the corpus walk, the engines and the judging inputs all live here,
 * so the next person can re-run rather than re-litigate.
 *
 * IT JUDGES NOTHING. It prints each engine's top 5 with `path:line › heading`
 * and leaves the verdict to a person. An automated relevance score would be
 * this harness marking its own homework (forbidden-pattern #7) — the same rule
 * the original comparison set for itself.
 *
 * Run:  ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/brain-search-bench.mjs
 *       (Electron-as-Node because better-sqlite3 is built for the Electron ABI —
 *        allowed-pattern #8.)
 */
import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

/**
 * The project to measure. Defaults to this repo; pass a path to point it at a
 * bigger real corpus — the original run needed 234 markdown files of real
 * knowledge and this repo's brain no longer has them.
 */
const ROOT = process.argv[2] ? resolve(process.argv[2]) : resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SELF = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const Database = (await import(join(SELF, 'app/node_modules/better-sqlite3/lib/index.js'))).default

/**
 * The searched corpus, per CLAUDE.md — minus `docs/`, which is NOT in it and
 * which contains all 12 questions as headings. Leaving it in makes the
 * benchmark document its own top hit for every question.
 */
const CORPUS_DIRS = ['flow/brain', 'flow/plans', 'flow/discovery', 'flow/brainstorms', '.claude/resources', '.claude/rules']
const CORPUS_FILES = ['CLAUDE.md']
/** `.raw/` is never indexed or surfaced — the tier boundary, in one place. */
const SKIP = /(^|\/)(\.raw|node_modules|archive)(\/|$)/

/**
 * The 12 questions, fixed before any result was seen — unchanged from the
 * original run so the two are comparable, and the expansions below were written
 * from the question wording ALONE, before a single query was executed.
 */
const QUESTIONS = [
  ['where does a turn get persisted', ['turn', 'persist', 'persisted', 'save', 'saved', 'store', 'stored', 'write', 'written', 'record']],
  ['what enforces the .raw boundary', ['raw', 'boundary', 'enforce', 'enforced', 'tier', 'guard', 'rule', 'invariant']],
  ['how does propose reach the store', ['propose', 'proposal', 'proposals', 'store', 'write', 'written', 'append', 'persist']],
  ['how do skills impact playbooks', ['skill', 'skills', 'playbook', 'playbooks', 'impact', 'affect', 'relate', 'related', 'depend']],
  ['who writes annotations.jsonl', ['annotations', 'annotation', 'write', 'writer', 'written', 'append', 'store', 'owner']],
  ['what decides which model a phase runs on', ['model', 'phase', 'decide', 'decides', 'route', 'routing', 'select', 'choose', 'tier', 'complexity']],
  ['how is a wave of parallel phases sequenced', ['wave', 'waves', 'parallel', 'phase', 'phases', 'sequence', 'sequenced', 'order', 'ordering', 'topological', 'dependency', 'dependencies']],
  ['where is the gitignore block generated', ['gitignore', 'block', 'generate', 'generated', 'build', 'built', 'write', 'written', 'template', 'emit']],
  ['what happens when verification fails twice', ['verification', 'verify', 'fail', 'fails', 'failed', 'twice', 'second', 'again', 'repeat', 'retry', 'retries', 'attempt', 'attempts']],
  ['how does the board know a module is stale', ['board', 'module', 'stale', 'staleness', 'outdated', 'drift', 'drifted', 'detect', 'hash', 'recheck', 'invalidate']],
  ['why was the lavish engine retired', ['lavish', 'engine', 'retire', 'retired', 'removed', 'deleted', 'replaced', 'absorbed', 'superseded']],
  ['difference between complexity and risk', ['difference', 'complexity', 'risk', 'versus', 'vs', 'compare', 'distinct', 'between']],
]

const STOP = new Set(
  'a an the of to in on is are was were do does how what where who why when which that this it its for from with by at as be been can could should would will we our you your i my me not no and or but if then than there here about into over under'.split(' '),
)
const terms = (q) => [...new Set(q.toLowerCase().match(/[a-z0-9_.%]+/g)?.filter((t) => !STOP.has(t) && t.length > 2) ?? [])]
const match = (list) => list.map((t) => `"${t}"*`).join(' OR ')

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (SKIP.test(relative(ROOT, p))) continue
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.md')) out.push(p)
  }
  return out
}

/** Heading-aware chunks, capped so one long section is not one giant chunk. */
function chunk(text) {
  const lines = text.split('\n')
  const out = []
  let buf = [], heading = '', start = 1
  const flush = (end) => {
    const body = buf.join('\n').trim()
    if (body) out.push({ body, heading, line: start })
    buf = []; start = end
  }
  lines.forEach((l, i) => {
    if (/^#{1,6} /.test(l)) { flush(i + 1); heading = l.replace(/^#+\s*/, '') }
    buf.push(l)
    if (buf.length > 45) flush(i + 1)
  })
  flush(lines.length)
  return out
}

const dbPath = join(tmpdir(), `brain-bench-${process.pid}.db`)
for (const s of ['', '-wal', '-shm']) { try { unlinkSync(dbPath + s) } catch {} }
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
// POINTER INDEX. `content=''` indexes the words and stores none of them, so a
// hit is a place to go and read. Default `detail` is kept on purpose:
// `detail=none` is a third of the size and cannot answer phrase queries.
db.exec(`
  CREATE VIRTUAL TABLE ptr USING fts5(body, content='', tokenize="unicode61 tokenchars '_%'");
  CREATE TABLE loc(rowid INTEGER PRIMARY KEY, path TEXT, heading TEXT, line INT);
`)

const files = [...CORPUS_DIRS.flatMap((d) => walk(join(ROOT, d))), ...CORPUS_FILES.map((f) => join(ROOT, f))].filter((f) => {
  try { return statSync(f).isFile() } catch { return false }
})
const ins = db.prepare('INSERT INTO ptr(rowid, body) VALUES (?,?)')
const loc = db.prepare('INSERT INTO loc(rowid, path, heading, line) VALUES (?,?,?,?)')
let id = 0
const built = process.hrtime.bigint()
db.transaction(() => {
  for (const f of files) for (const c of chunk(readFileSync(f, 'utf-8'))) {
    id++; ins.run(id, c.body); loc.run(id, relative(ROOT, f), c.heading, c.line)
  }
})()
const buildMs = Number(process.hrtime.bigint() - built) / 1e6

const top = db.prepare(`
  SELECT l.path, l.heading, l.line, bm25(ptr) AS r
  FROM ptr JOIN loc l ON l.rowid = ptr.rowid
  WHERE ptr MATCH ? ORDER BY r LIMIT ?
`)

/** Reciprocal rank fusion: the base query keeps its authority, the expansion
 *  only adds reach it could not have. k=60 is the conventional constant. */
function fuse(lists, k = 60) {
  const scored = new Map()
  for (const list of lists) list.forEach((row, i) => {
    const key = `${row.path}:${row.line}`
    const entry = scored.get(key) ?? { row, s: 0 }
    entry.s += 1 / (k + i + 1)
    scored.set(key, entry)
  })
  return [...scored.values()].sort((a, b) => b.s - a.s).slice(0, 5).map((e) => e.row)
}

console.log(`# corpus: ${files.length} files → ${id} chunks · index built in ${buildMs.toFixed(0)}ms · ${(statSync(dbPath).size / 1048576).toFixed(1)} MB`)
console.log('# judge by hand: does the top 5 contain something that answers the question?\n')

let plain = 0, fused = 0
for (const [q, extra] of QUESTIONS) {
  const t1 = process.hrtime.bigint()
  const base = top.all(match(terms(q)), 10)
  plain += Number(process.hrtime.bigint() - t1) / 1e6
  const t2 = process.hrtime.bigint()
  const expanded = fuse([base, top.all(match([...new Set([...terms(q), ...extra])]), 10)])
  fused += Number(process.hrtime.bigint() - t2) / 1e6
  console.log(`## ${q}`)
  const show = (label, rows) => {
    console.log(`  ${label}`)
    if (rows.length === 0) console.log('     — nothing')
    rows.slice(0, 5).forEach((r, i) => console.log(`     ${i + 1}. ${r.path}:${r.line} › ${r.heading || '(top of file)'}`))
  }
  show('fts:', base)
  show('fts + expansion (fused):', expanded)
  console.log()
}
console.log(`# fts ${plain.toFixed(1)}ms · fused ${fused.toFixed(1)}ms · ${QUESTIONS.length} questions`)
db.close()
for (const s of ['', '-wal', '-shm']) { try { unlinkSync(dbPath + s) } catch {} }
