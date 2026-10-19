/**
 * WHAT MAKES AUTOPILOT AUTOMATIC — the trigger that was missing.
 *
 * The chain machinery shipped complete: a driver, stage gates, a stop control,
 * a claims registry, and a project key that GATES starting one. What it never
 * had was anything that asks it to start. `flow:chain` accepts `run: true` and
 * no caller anywhere sends it; the renderer's only use is documented as "ONLY
 * ask". So a person turned autopilot on, the key granted permission for a
 * request nobody made, and nothing chained — which is exactly what it looked
 * like from the outside (user, 2026-09-23: "even with the autopilot on on the
 * ide, we are still not calling automatically the next command").
 *
 * A chain therefore begins on the FIRST MESSAGE OF A CONVERSATION, with that
 * message as its aim.
 *
 * ── WHY THE FIRST MESSAGE, AND ONLY THE FIRST ───────────────────────────────
 *
 * The aim is what the whole chain is about: it names the feature, it is what
 * the stage gate checks each document against, and it is carried into every
 * rung's prompt. The opening message is the one moment somebody says what they
 * want in their own words. A later message is a reply inside work already under
 * way, and treating one as a new aim would restart a workflow mid-flight.
 *
 * ── AN EXPLICIT COMMAND IS THE PERSON DRIVING ───────────────────────────────
 *
 * A first message that already starts with `/` is somebody choosing a step
 * themselves. Wrapping that in a chain would answer a request they did not make
 * — and if they typed `/discovery-plan` the chain would issue a second one.
 *
 * Pure: it decides, and the caller acts. Nothing here knows about a store, a
 * chain or a message bus.
 */

export interface AutoChainInput {
  /** How many messages this thread already has. */
  messageCount: number
  /** What the person just typed. */
  content: string
  /** How many files came with it. */
  attachmentCount?: number
}

/**
 * Should this message begin a chain instead of being sent as an ordinary turn?
 *
 * TRUE MEANS THE CHAIN TAKES THE MESSAGE. It is not sent on its own — the
 * chain's first rung is `/discovery-plan <aim>`, which carries it. Sending both
 * would give the thread two opening turns saying the same thing.
 *
 * Every branch here is a reason NOT to chain. The remaining permission checks —
 * is autopilot on for this project, is something already driving this thread,
 * does the thread still exist — belong to `begin()`, which refuses for each of
 * them with its own reason. This does not duplicate them (allowed-pattern #14):
 * it answers only the question `begin()` cannot, which is whether this message
 * is the kind that starts work.
 */
export function shouldAutoChain(input: AutoChainInput): boolean {
  // Not the opening message: a reply inside work already under way.
  if (input.messageCount !== 0) return false
  const aim = input.content.trim()
  // Nothing to be about. A chain with an empty aim has no feature name, and the
  // stage gate would have nothing to check the first document against.
  if (aim === '') return false
  // The person is driving.
  if (aim.startsWith('/')) return false
  // AN ATTACHMENT IS CONTENT THE CHAIN CANNOT CARRY.
  //
  // A chain takes the message INSTEAD of sending it — its first rung is
  // `/discovery-plan <aim>`, and that path has no attachments on it. So a
  // first message with a screenshot would start a chain and silently lose the
  // screenshot, which is the worst of both: the person's evidence is gone and
  // nothing says so.
  //
  // Sending it the ordinary way is the safe half of that trade. The thread's
  // own composer can still start a chain afterwards once there is a control
  // for it; a dropped image cannot be recovered by anybody.
  if ((input.attachmentCount ?? 0) > 0) return false
  return true
}
