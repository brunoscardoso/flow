// parseAskOpenDetail — the one door's untrusted event detail, read leniently.

import { parseAskOpenDetail } from './ask-contract'

describe('parseAskOpenDetail', () => {
  it('reads a well-formed detail in full', () => {
    expect(
      parseAskOpenDetail({
        text: 'Can we share credentials?',
        tags: [
          { id: 'feature:connectors', kind: 'feature', label: 'Connectors' },
          { id: 'feature:connectors/credentials', kind: 'part' },
          { id: 't1', kind: 'conversation', label: 'Vault work' },
        ],
        threadId: 't1',
        threadTitle: 'Vault work',
        view: 'history',
        entryId: 'qa-1',
        submit: true,
      }),
    ).toEqual({
      text: 'Can we share credentials?',
      tags: [
        { id: 'feature:connectors', kind: 'feature', label: 'Connectors' },
        { id: 'feature:connectors/credentials', kind: 'part' },
        { id: 't1', kind: 'conversation', label: 'Vault work' },
      ],
      threadId: 't1',
      threadTitle: 'Vault work',
      view: 'history',
      entryId: 'qa-1',
      submit: true,
    })
  })

  it.each([null, undefined, 'text', 42, true])('reads %p as no detail', (detail) => {
    expect(parseAskOpenDetail(detail)).toEqual({})
  })

  it('drops malformed fields and malformed tags, never throws', () => {
    expect(
      parseAskOpenDetail({
        text: '   ',
        threadId: '',
        view: 'everything',
        submit: 'yes',
        entryId: 7,
        tags: [null, 'feature:x', { id: '', kind: 'feature' }, { id: 'feature:y', kind: 'change' }, { id: 'feature:z', kind: 'feature', label: '' }],
      }),
    ).toEqual({ tags: [{ id: 'feature:z', kind: 'feature' }] })
  })

  it('leaves tags out when none survive', () => {
    expect(parseAskOpenDetail({ tags: [{ id: 1 }] })).toEqual({})
    expect(parseAskOpenDetail({ tags: 'feature:x' })).toEqual({})
  })
})
