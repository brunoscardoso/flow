// Which task records earn a row in the THREAD sidebar (#1789).
//
// The sidebar renders tasks as chat-like rows, and it used to render every
// non-archived record. That was right when every task was something a person
// typed into the New Task modal — each one owns a 1:1 thread by construction —
// and became wrong the day the mirror started filing an agent's TaskCreate
// calls onto the board: one request in a conversation produced N cards, and the
// sidebar grew N new "chats" named after them, none of which was a conversation
// at all. The board is where that work belongs; the sidebar is the list of
// conversations.
//
// THE RULE, IN THE DATA'S OWN TERMS: a record earns a row when nothing marks it
// as machine-created. Two marks say a machine filed it:
//
//  - `originThreadId` — the mirror's provenance column, stamped by both agent
//    task protocols and by nothing a person does in the UI;
//  - a `manual`-sourced record CARRYING an `externalKey` — `manual` means "no
//    external tracker", so a key on one is machine bookkeeping by definition
//    (the mirrors' thread-scoped keys, a ledger queue's `<path>#<id>`), and
//    every surface that renders keys already guards on `source !== 'manual'`
//    for exactly this reason. Checked as well as provenance, not instead of
//    it, because provenance nulls when its origin thread is deleted and the
//    key survives.
//
// OWNING A CHAT USED TO BE ENOUGH, AND IS NOT ANY MORE. The first cut let any
// record with a `threadId` through, on the reasoning that a chat exists so the
// row opens something real — which made merely OPENING a mirrored card file a
// permanent conversation, because `ensureTaskThread` creates and links the
// thread on open. Measured on the reporter's own machine: four mirrored cards
// had threads, every one of them created 30 minutes to 3 hours after its card
// and holding ZERO messages. Four rows in the conversation list, none of which
// was ever a conversation. The user's call, asked and answered: a machine-filed
// card belongs to the board, whatever happened to it afterwards. Its chat is
// still reachable — the card's own "Open chat" is the way in, and a search still
// finds the thread, because searching drops the task layer by design.
//
// What deliberately KEEPS its row while chatless: a person's own manual task
// whose thread was deleted from the sidebar (#1061 — the row is the recovery
// affordance), and a tracker import in the same state, for the same reason. A
// tracker import is not machine-created: a person chose to import it.

/** The fields the rule reads — a subset of TaskSummary, so tests stay lean. */
export interface SidebarTaskFacts {
  threadId: string | null
  originThreadId: string | null
  source: string
  externalKey: string | null
}

/** True when this record was filed by machinery rather than typed by a person. */
function machineCreated(task: SidebarTaskFacts): boolean {
  if (task.originThreadId !== null) return true
  return task.source === 'manual' && task.externalKey !== null
}

/** Does this task earn a row in the thread sidebar (active or archived)? */
export function taskBelongsInSidebar(task: SidebarTaskFacts): boolean {
  return !machineCreated(task)
}

/** The facts the bare-list rule reads on top of {@link SidebarTaskFacts}. */
export interface BareThreadTaskFacts extends SidebarTaskFacts {
  /** ISO archive timestamp, or null when active. */
  archivedAt: string | null
  /** The task's 1:1 thread is a live loop run (its `origin_loop` is set). */
  threadIsLoopRun: boolean
}

/**
 * Whether a task's 1:1 thread is kept OUT of the sidebar's bare-thread list
 * while the task layer is shown (#1880).
 *
 * A task row normally speaks for its thread, so the thread is suppressed from
 * the bare list to avoid a double render. But a machine-filed card earns no task
 * row (`taskBelongsInSidebar` is false), so suppressing its thread too renders
 * it NOWHERE — the defect behind #1880. The board's loop takes such a card,
 * gives it a live 1:1 conversation and marks it a run, and that conversation was
 * then absent from the thread list: owned by a task (so not "bare"), and its
 * owner drawn on the board instead of the sidebar.
 *
 * The thread falls through to the bare list ONCE it is a live loop run — the
 * board is working it, a running conversation belongs in the conversation list,
 * and it draws the ↻ glyph off its `originLoop` like any other run. A thread
 * that exists only because someone OPENED the card (not yet a loop run) stays
 * suppressed: that is #1789's rule, the reason merely opening a mirrored card
 * never files a permanent, empty conversation. An archived task's thread stays
 * suppressed too — the Archived section speaks for it, never a live bare row
 * (#1467).
 */
export function taskThreadSuppressedFromBareList(task: BareThreadTaskFacts): boolean {
  if (task.archivedAt !== null) return true
  if (taskBelongsInSidebar(task)) return true
  return !task.threadIsLoopRun
}
