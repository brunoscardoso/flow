/**
 * The known slash-command names for the thread on screen — pure, DOM-free.
 *
 * The composer is the one place that lists a project's commands (its slash
 * menu); it publishes every list it gets here, and anything that highlights a
 * command (the composer's own input, the feed's user messages, the queued
 * previews) reads from here. One fetch path, one answer to "is `/x` a real
 * command" — no surface keeps a copy that could disagree.
 */

let names: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()

/** Replace the known names. Listeners hear only an actual change. */
export function publishCommandNames(list: readonly { name: string }[]): void {
  const next = new Set(list.map((command) => command.name))
  if (next.size === names.size && [...next].every((name) => names.has(name))) return
  names = next
  for (const listener of [...listeners]) listener()
}

/** Whether `name` (no leading slash) is a known command or skill. */
export function isKnownCommand(name: string): boolean {
  return names.has(name)
}

/** Hear every change of the known names; returns the unsubscribe. */
export function onCommandNamesChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
