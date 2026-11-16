// What the pinned cell's "Open" does (user, 2026-11-15: "the experience
// should be just one — if the user is seeing the blocks, keep on the blocks;
// if it's seeing the diagram keep using that").
//
// The pinned card shows a DIAGRAM. Its Open used to run the cell's own press,
// which drills into the feature's BLOCKS one level down — so a reader who was
// reading a diagram landed on a different kind of picture. Open now opens the
// same diagram full size: the feature's own level, the one the drilled level's
// header control opens.
//
// Only a FEATURE has a diagram level to open. A part keeps its press — at the
// last level that is the part's own code story, which is what its card is
// about; opening the owner's whole diagram would be a different picture again.
// A cell with no feature behind it keeps its press too. A plain press on a cell
// is not decided here.
//
// DOM-free so it runs under the CJS node jest.

export interface PinOpenCell {
  id: string
  kind: 'feature' | 'part' | 'domain' | string
  name: string
}

export interface PinOpenOwner {
  id: string
  name: string
}

export type PinOpenAction =
  | { kind: 'level'; id: string; name: string; via: 'self' }
  | { kind: 'press' }

export function pinOpenAction(cell: PinOpenCell, _owner: PinOpenOwner | null = null): PinOpenAction {
  if (cell.kind === 'feature') return { kind: 'level', id: cell.id, name: cell.name, via: 'self' }
  return { kind: 'press' }
}
