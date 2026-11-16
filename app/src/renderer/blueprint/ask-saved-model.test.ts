// "Questions asked" on a feature's brief — the rows it shows.

import type { AskSavedThread } from '../../shared/ask-contract'
import { SAVED_ROWS_SHOWN, savedSectionView } from './ask-saved-model'

const NOW = Date.parse('2026-11-15T12:00:00Z')

function thread(id: string, ts: string, patch: Partial<AskSavedThread> = {}): AskSavedThread {
  return {
    id,
    ts,
    author: 'Ana',
    question: `Question ${id}`,
    tags: ['feature:connectors'],
    conversationCount: 0,
    usedConversation: false,
    answer: 'x',
    sources: [],
    factsLearned: 0,
    partial: false,
    followUps: [],
    ...patch,
  }
}

describe('savedSectionView', () => {
  it('draws nothing when there is nothing saved', () => {
    expect(savedSectionView([], [], NOW)).toBeNull()
  })

  it('lists the newest first with a verdict chip, who and when, follow-ups and staleness', () => {
    const followUp = { ...thread('f', '2026-11-15T11:00:00Z'), parentId: 'b' }
    const view = savedSectionView(
      [
        thread('a', '2026-11-10T12:00:00Z'),
        thread('b', '2026-11-15T11:59:50Z', { verdict: { label: 'Yes · medium effort', risk: 'Rotation' }, followUps: [followUp, followUp] }),
        thread('c', '2026-11-14T12:00:00Z', { author: 'Bo', followUps: [followUp] }),
        thread('d', '2026-10-01T12:00:00Z'),
      ],
      [
        { id: 'c', stale: true, changedFiles: ['src/a.ts'], missingFiles: [] },
        { id: 'b', stale: false, changedFiles: [], missingFiles: [] },
      ],
      NOW,
    )
    expect(view?.heading).toBe('Questions asked · 4')
    expect(view?.hasMore).toBe(true)
    expect(view?.rows).toHaveLength(SAVED_ROWS_SHOWN)
    expect(view?.rows.map((r) => r.id)).toEqual(['b', 'c', 'a'])
    expect(view?.rows[0]).toEqual({
      id: 'b',
      question: 'Question b',
      chip: 'Yes · medium effort · Rotation',
      meta: 'Ana · just now · 2 follow-ups',
      stale: false,
      tags: ['feature:connectors'],
      workspaceEntry: null,
    })
    expect(view?.rows[1]).toMatchObject({ chip: null, meta: 'Bo · yesterday · 1 follow-up', stale: true })
    expect(view?.rows[2].meta).toBe('Ana · 5 days ago')
  })

  it('has no "more" when every saved question fits', () => {
    expect(savedSectionView([thread('a', '2026-11-15T10:00:00Z')], [], NOW)?.hasMore).toBe(false)
  })
})
