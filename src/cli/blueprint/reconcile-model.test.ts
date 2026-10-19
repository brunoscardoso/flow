import { reconcile, surpriseNodes, type ActualTouched } from './reconcile-model.js';
import type { TouchedSet } from './types.js';

const predicted: TouchedSet[] = [
  {
    phase: 1,
    touched: [
      { nodeId: 'module:a', kind: 'modify', anchor: { kind: 'module', ref: 'a' } },
      { nodeId: 'module:b', kind: 'modify', anchor: { kind: 'module', ref: 'b' } },
    ],
  },
  {
    phase: 2,
    touched: [{ nodeId: 'module:c', kind: 'new', anchor: { kind: 'module', ref: 'c' } }],
  },
];

describe('reconcile', () => {
  it('classifies confirmed, missed, and surprise per phase', () => {
    const actual: ActualTouched[] = [
      { phase: 1, nodeIds: ['module:a', 'module:x'] }, // a confirmed, b missed, x surprise
      { phase: 2, nodeIds: ['module:c'] }, // c confirmed
    ];
    const result = reconcile(predicted, actual);
    expect(result).toEqual([
      { nodeId: 'module:a', phase: 1, state: 'confirmed', kind: 'modify' },
      { nodeId: 'module:b', phase: 1, state: 'missed', kind: 'modify' },
      { nodeId: 'module:x', phase: 1, state: 'surprise' },
      { nodeId: 'module:c', phase: 2, state: 'confirmed', kind: 'new' },
    ]);
  });

  it('marks everything missed when nothing landed', () => {
    const result = reconcile(predicted, []);
    expect(result.every((r) => r.state === 'missed')).toBe(true);
  });

  it('marks unpredicted phases entirely surprise', () => {
    const result = reconcile([], [{ phase: 5, nodeIds: ['module:z'] }]);
    expect(result).toEqual([{ nodeId: 'module:z', phase: 5, state: 'surprise' }]);
  });
});

describe('surpriseNodes (risk signal — global)', () => {
  it('returns only nodes predicted in NO phase', () => {
    const actual: ActualTouched[] = [
      { phase: 1, nodeIds: ['module:a', 'module:x'] },
      { phase: 2, nodeIds: ['module:c', 'module:y'] },
    ];
    // x and y were never predicted anywhere; a and c were
    expect(surpriseNodes(predicted, actual)).toEqual(['module:x', 'module:y']);
  });

  it('does NOT flag a node touched in a different phase than predicted (timing shift)', () => {
    // module:c was predicted for phase 2; touching it in phase 1 is a timing
    // shift, NOT unforeseen blast radius — must not raise risk.
    const actual: ActualTouched[] = [{ phase: 1, nodeIds: ['module:c'] }];
    expect(surpriseNodes(predicted, actual)).toEqual([]);
  });

  it('dedupes a node touched in multiple phases', () => {
    const actual: ActualTouched[] = [
      { phase: 1, nodeIds: ['module:z'] },
      { phase: 2, nodeIds: ['module:z'] },
    ];
    expect(surpriseNodes([], actual)).toEqual(['module:z']);
  });
});
