// Ask prefers solid knowledge (plan workspace_knowledge_draft_solid, note 9):
// a draft note is used only for the session's own branch or when nothing solid
// is relevant, and it is labelled with its branch so the answer says so.

import { createHash } from 'node:crypto'

import type { BlueprintFeatureNode } from '../../shared/ipc-contract'
import { foldKnowledgeStatus, knowledgeItemIdInput } from '../../shared/knowledge-status'
import type { RunResult } from '../worktree/thread-worktree'
import {
  gatherAskContext,
  notesWithStatus,
  pickNotes,
  sessionBranchOf,
  type AskFeature,
  type AskGit,
  type AskNote,
  type StoredAskNote,
} from './ask-context'
import { askNoteLine, buildFastPrompt } from './ask-orchestrator'
import { knowledgeStatusReaderFromText } from './knowledge-status-read'

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

/** One provenance record line exactly as the CLI's record writer writes it. */
function recordLine(provenance: { branch: string | null; commit: string | null; onDefault: boolean | null }): { id: string; line: string } {
  const body = JSON.stringify({ branch: provenance.branch, commit: provenance.commit, onDefault: provenance.onDefault, hashes: [] })
  const id = sha(body).slice(0, 16)
  return { id, line: `{"id":${JSON.stringify(id)},${body.slice(1)}` }
}

const ON_BRANCH = recordLine({ branch: 'feat/refunds', commit: 'a'.repeat(40), onDefault: false })
const ON_MAIN = recordLine({ branch: 'main', commit: 'b'.repeat(40), onDefault: true })
const OTHER_BRANCH = recordLine({ branch: 'feat/other', commit: 'c'.repeat(40), onDefault: false })
const PROVENANCE = [ON_BRANCH, ON_MAIN, OTHER_BRANCH].map((record) => record.line).join('\n')

const fingerprint = (note: StoredAskNote): string => `${note.text}+${JSON.stringify(note.anchors.map((a) => a.ref).sort())}`

function stored(text: string, learnedAt?: string): StoredAskNote {
  return { ts: '2026-11-01T00:00:00Z', text, anchors: [{ ref: 'src/orders.ts' }], ...(learnedAt !== undefined ? { learnedAt } : {}) }
}

describe('notesWithStatus — the CLI rules over the CLI files', () => {
  it('marks a branch note draft with its branch, keeps main and unstamped notes solid, drops abandoned', () => {
    const abandoned = stored('orders abandoned note', OTHER_BRANCH.id)
    const status = JSON.stringify({
      item: sha(knowledgeItemIdInput({ kind: 'note', scope: '', text: fingerprint(abandoned), learnedAt: OTHER_BRANCH.id })).slice(0, 16),
      status: 'abandoned',
      branch: 'feat/other',
      commit: null,
      reason: 'branch-gone',
      ts: '2026-11-16T00:00:00.000Z',
    })
    const reader = knowledgeStatusReaderFromText(status, PROVENANCE)
    const notes = notesWithStatus(
      [stored('orders draft note', ON_BRANCH.id), stored('orders main note', ON_MAIN.id), stored('orders old note'), abandoned],
      reader,
      fingerprint,
    )
    expect(notes.map((note) => note.text)).toEqual(['orders draft note', 'orders main note', 'orders old note'])
    expect(notes[0]).toMatchObject({ status: 'draft', branch: 'feat/refunds' })
    expect(notes[1].status).toBeUndefined()
    expect(notes[2].status).toBeUndefined()
  })

  it('the shared fold is the CLI fold: a promotion line outranks the draft line in either order', () => {
    const draft = JSON.stringify({ item: 'a'.repeat(16), status: 'draft', branch: 'x', commit: null, reason: 'learned', ts: '2026-11-17T00:00:00.000Z' })
    const solid = JSON.stringify({ item: 'a'.repeat(16), status: 'solid', branch: 'x', commit: null, reason: 'ancestor', ts: '2026-11-16T00:00:00.000Z' })
    expect(foldKnowledgeStatus([draft, solid]).get('a'.repeat(16))?.status).toBe('solid')
    expect(foldKnowledgeStatus([solid, draft]).get('a'.repeat(16))?.status).toBe('solid')
  })
})

const tagged: AskFeature[] = [{ id: 'feature:orders', name: 'Orders', kind: 'core', summary: '', tagged: true }]
const note = (text: string, patch: Partial<AskNote> = {}): AskNote => ({ ts: '', text, anchors: [], ...patch })

describe('pickNotes — solid first', () => {
  const solid = note('orders retry twice')
  const draftHere = note('orders refund queue', { status: 'draft', branch: 'feat/refunds' })
  const draftElsewhere = note('orders ledger rewrite', { status: 'draft', branch: 'feat/other' })

  it('with a relevant solid note: solid, plus only the draft from the session branch', () => {
    const picked = pickNotes([solid, draftHere, draftElsewhere], tagged, 10, 'feat/refunds')
    expect(picked).toEqual([solid, draftHere])
  })

  it('on another branch, a relevant solid note keeps every draft out', () => {
    const picked = pickNotes([solid, draftHere, draftElsewhere], tagged, 10, 'main')
    expect(picked).toContain(solid)
    expect(picked).toEqual([solid])
  })

  it('with no relevant solid note, the relevant drafts are used', () => {
    const unrelated = note('billing invoices')
    const picked = pickNotes([unrelated, draftHere, draftElsewhere], tagged, 10, 'main')
    expect(picked).toEqual([draftHere, draftElsewhere, unrelated])
  })
})

describe('the prompt labels a draft with its branch', () => {
  it('askNoteLine', () => {
    expect(askNoteLine(note('Refunds settle nightly.', { anchors: ['src/a.ts'] }))).toBe('- Refunds settle nightly. (src/a.ts)')
    expect(askNoteLine(note('Refunds settle nightly.', { anchors: ['src/a.ts'], status: 'draft', branch: 'feat/refunds' }))).toBe(
      '- Work in progress on feat/refunds: Refunds settle nightly. Not merged yet, so this may change. (src/a.ts)',
    )
  })

  it('gatherAskContext reads the session branch and the prompt carries the label and the rule', async () => {
    const calls: string[][] = []
    const git: AskGit = async (_cwd, args): Promise<RunResult> => {
      calls.push([...args])
      return args[0] === 'symbolic-ref' ? { ok: true, stdout: 'feat/refunds\n' } : { ok: false, stdout: '' }
    }
    const nodes: BlueprintFeatureNode[] = [
      { id: 'feature:orders', slug: 'orders', name: 'Orders', kind: 'core', understanding: 'learned', active: false, anchorCount: 1, status: 'draft', draftBranch: 'feat/refunds' },
    ]
    const context = await gatherAskContext(
      { rootPath: '/repo', question: 'how do refunds work?', tags: ['feature:orders'], conversationIds: [] },
      {
        searchKnowledge: async () => [],
        readFeatureGraph: async () => ({ nodes, edges: [] }),
        readNotes: async () => [note('orders solid note'), note('orders refund queue', { status: 'draft', branch: 'feat/refunds' }), note('orders other', { status: 'draft', branch: 'feat/other' })],
        threadStore: { getThread: () => null, listMessages: () => [], listToolCallPaths: () => [] } as never,
        git,
      },
    )
    expect(calls).toContainEqual(['symbolic-ref', '--quiet', '--short', 'HEAD'])
    expect(context.notes.map((n) => n.text)).toEqual(['orders solid note', 'orders refund queue'])
    const text = buildFastPrompt('how do refunds work?', ['feature:orders'], context)
    expect(text).toContain('Work in progress on feat/refunds: orders refund queue Not merged yet, so this may change.')
    expect(text).toContain('[work in progress on feat/refunds, not merged]')
    expect(text).not.toContain('orders other')
  })

  it('sessionBranchOf: detached or failing git is null, never a guess', async () => {
    expect(await sessionBranchOf(async () => ({ ok: false, stdout: '' }), '/repo')).toBeNull()
    expect(await sessionBranchOf(async () => { throw new Error('boom') }, '/repo')).toBeNull()
    expect(await sessionBranchOf(async () => ({ ok: true, stdout: 'main\n' }), '/repo')).toBe('main')
  })
})
