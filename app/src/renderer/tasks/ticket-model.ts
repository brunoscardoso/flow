// WHAT A TICKET SAYS — the DOM-free half.
//
// SEPARATE FROM THE CHROME because this half is testable and that half is not:
// the app's jest runs under Node with no DOM lib, so a module naming
// `HTMLElement` cannot be imported by a test at all. The rule about absence
// below is the one worth pinning, so it lives where a test can reach it.
//
// ONE TICKET, WHEREVER IT IS SHOWN.
//
// The board had three ticket surfaces and each had grown its own idea of what a
// ticket looks like: the task detail, the queue-item detail, and the remote
// card. They agreed on nothing — one bolded its title and one did not, one had
// a meta line and one had two, the sections were labelled in three ways, and
// none of them showed the facts a tracker prints first (who filed it, how
// urgent, what kind of thing it is). The user, looking at two of them side by
// side: "the standard ticket is really bad as well, lets make a standard to
// all".
//
// So the chrome is built once, here, and every surface fills it: a title that
// reads as a title, a fact row that says what the tracker says, labelled
// sections with room between them, and one scrolling region between a head and
// a foot that stay put.
//
// A FIXED HEIGHT, ON PURPOSE. "lets have a default size of the ticket with a
// scroll inside if needed" — a dialog that grows to its content is a dialog
// that jumps between one ticket and the next, and a one-line ticket that opens
// as a sliver reads as a failure rather than as a short ticket.

/** One fact a tracker prints beside a ticket. */
export interface TicketFact {
  label: string
  value: string
}

/** Everything a ticket shows, in the order it shows it. */
export interface TicketModel {
  title: string
  /** The line under it — `Jira · ACME-3278`, `acme/widgets#41`. */
  subtitle: string
  /** Where it lives, when it lives somewhere. The subtitle links to it. */
  url: string | null
  /**
   * Type, priority, reporter, assignee — whatever the tracker actually said.
   *
   * ONLY WHAT IT SAID. An absent field is not a row reading "None": the
   * trackers disagree about which of these exist, and printing a dash for
   * every one a given tracker does not have turns a ticket into a form.
   */
  facts: TicketFact[]
}

/** A ticket's facts, from whatever a provider filled in. */
export function ticketFacts(source: {
  type?: string | undefined
  status?: string | undefined
  priority?: string | undefined
  reporter?: string | undefined
  assignee?: string | undefined
}): TicketFact[] {
  const rows: TicketFact[] = [
    { label: 'Type', value: source.type ?? '' },
    { label: 'Status', value: source.status ?? '' },
    { label: 'Priority', value: source.priority ?? '' },
    { label: 'Reporter', value: source.reporter ?? '' },
    { label: 'Assignee', value: source.assignee ?? '' },
  ]
  return rows.filter((row) => row.value.trim().length > 0)
}
