/**
 * The ticket's facts — what a tracker prints beside it, and only that.
 *
 * The board had three ticket surfaces that agreed on nothing, and none of them
 * showed what a person reads first: what kind of thing it is, how urgent, who
 * filed it, who has it. The rule that keeps this from becoming a form is that
 * an ABSENT field is not a row.
 */

import { ticketFacts } from './ticket-model'

describe('the facts a ticket shows', () => {
  it('shows what the tracker said, in a fixed order', () => {
    expect(
      ticketFacts({
        type: 'Bug',
        status: 'Backlog',
        priority: 'Medium',
        reporter: 'Paresh Bhalke',
        assignee: 'Dev User',
      }),
    ).toEqual([
      { label: 'Type', value: 'Bug' },
      { label: 'Status', value: 'Backlog' },
      { label: 'Priority', value: 'Medium' },
      { label: 'Reporter', value: 'Paresh Bhalke' },
      { label: 'Assignee', value: 'Dev User' },
    ])
  })

  it('leaves out what it did not say — never a row reading "None"', () => {
    // The trackers disagree about which of these exist: GitHub has no priority
    // at all, Azure calls the reporter "created by", and a Jira project can
    // switch any of them off. Printing a dash for each absence turns a ticket
    // into a form about things nobody filled in.
    expect(ticketFacts({ status: 'open', reporter: 'octocat' })).toEqual([
      { label: 'Status', value: 'open' },
      { label: 'Reporter', value: 'octocat' },
    ])
  })

  it('treats whitespace as absence', () => {
    expect(ticketFacts({ priority: '   ', status: 'open' })).toEqual([
      { label: 'Status', value: 'open' },
    ])
  })

  it('says nothing at all when the tracker said nothing', () => {
    expect(ticketFacts({})).toEqual([])
  })
})
