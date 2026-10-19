// WHAT A THREAD MAY BE ATTACHED TO — checked where the renderer asks
// (`threads:setRoots`), because an attached root becomes a folder a runtime
// may read and WRITE (agent-manager's writable roots for Codex and Copilot).
//
// The answer is the address gate's (addressable-roots.ts, allowed-pattern #14):
// a root the thread ADDS must be a project Flow knows. A root the thread
// already carries is kept as it is — a project removed from the list since must
// not make every later detach on that thread fail.

import { resolve } from 'path'

import type { AddressableRoots } from './addressable-roots'

export type AttachRootsCheck =
  | { ok: true; roots: string[] }
  | { ok: false; refused: string[] }

export function checkAttachRoots(
  asked: readonly string[],
  alreadyAttached: readonly string[],
  gate: Pick<AddressableRoots, 'isAddressable'>,
): AttachRootsCheck {
  const carried = new Set(alreadyAttached.map((root) => resolve(root)))
  const roots: string[] = []
  const refused: string[] = []
  for (const root of asked) {
    if (typeof root !== 'string' || root === '') continue
    const absolute = resolve(root)
    if (carried.has(absolute)) roots.push(root)
    else if (gate.isAddressable(absolute)) roots.push(absolute)
    else refused.push(root)
  }
  return refused.length > 0 ? { ok: false, refused } : { ok: true, roots }
}
