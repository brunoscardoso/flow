/**
 * Tests for the proposal store — full lifecycle matrix (propose → decide →
 * confirm/sweep event folds), re-propose semantics (state resets, historical
 * timestamps preserved), fold determinism, single-writer lock behavior,
 * malformed-line fail-soft with skip counting, the predicted-id grammar
 * matrix (kind/prefix agreement is inherent), and the fingerprint shape.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import {
  anchorContains,
  anchorPath,
  appendProposalEvent,
  attachProposal,
  attachProposals,
  confirmableProposals,
  countProposals,
  deriveProposalChange,
  deriveProposalChanges,
  EXTRACTOR_PROPOSAL_KINDS,
  isExtractorProposalKind,
  isProposalConfirmed,
  readProposalsWithChange,
  foldProposalEvents,
  formatProposalsRecorded,
  formatProposalsStaled,
  formatProposeRefusal,
  isProposalSourceLive,
  isValidPredictedNodeId,
  LIVE_PROPOSAL_STATES,
  MAX_ANCHOR_CLAIMANTS,
  overlappingFeatures,
  parseProposalsFile,
  PREDICTED_ID_GRAMMAR,
  PROPOSAL_EVENT_NAMES,
  PROPOSAL_KINDS,
  PROPOSAL_STORE_BUSY_NOTICE,
  PROPOSALS_FILENAME,
  proposalFingerprint,
  proposalsForFeature,
  proposalSourceSlug,
  proposalsWithMissingSource,
  readEffectiveProposals,
  readProposalSourceIndex,
  validateProposalDecision,
  validateProposalRecord,
  suggestPartId,
  PREDICTED_ID_EXAMPLE,
  PART_ID_PATTERN,
  type AttachableFeature,
  type EffectiveProposal,
  type ProposalEvent,
  type ProposalEventName,
  type ProposalKind,
} from './proposal-store.js';
import type { Anchor } from './types.js';

describe('proposal store', () => {
  let flowDir: string;

  beforeEach(() => {
    flowDir = mkdtempSync(join(tmpdir(), 'proposal-store-test-'));
  });

  afterEach(() => {
    rmSync(flowDir, { recursive: true, force: true });
  });

  // ── Helpers ──────────────────────────────────────────────

  const storePath = (): string => join(flowDir, 'brain', '.structure', PROPOSALS_FILENAME);
  const lockPath = (): string => join(flowDir, 'brain', '.structure', 'proposals.lock');

  const storeLines = (): string[] =>
    readFileSync(storePath(), 'utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0);

  function makeEvent(overrides: Partial<ProposalEvent> = {}): ProposalEvent {
    return {
      ts: '2026-07-10T00:00:00.000Z',
      plan: 'plan_pay',
      predictedNodeId: 'integration:stripe',
      kind: 'integration',
      label: 'Stripe SDK',
      event: 'proposed',
      provenance: 'cli:propose',
      ...overrides,
    };
  }

  /** Append a lifecycle chain for one fingerprint, ts strictly ascending. */
  function appendChain(base: Partial<ProposalEvent>, events: ProposalEventName[]): void {
    events.forEach((eventName, index) => {
      appendProposalEvent(
        flowDir,
        makeEvent({ ...base, ts: `2026-07-10T0${index}:00:00.000Z`, event: eventName }),
      );
    });
  }

  // ── proposalFingerprint ──────────────────────────────────

  describe('proposalFingerprint', () => {
    it('should join plan and predictedNodeId with a plus', () => {
      expect(proposalFingerprint({ plan: 'plan_pay', predictedNodeId: 'integration:stripe' })).toBe(
        'plan_pay+integration:stripe',
      );
    });

    it('should be shared by every lifecycle event of one prediction', () => {
      const proposed = makeEvent();
      const confirmed = makeEvent({ event: 'confirmed', ts: '2026-07-10T05:00:00.000Z' });
      expect(proposalFingerprint(proposed)).toBe(proposalFingerprint(confirmed));
    });
  });

  // ── predicted-id grammar matrix ──────────────────────────

  describe('isValidPredictedNodeId', () => {
    const VALID: Record<ProposalKind, string[]> = {
      integration: ['integration:stripe', 'integration:api.stripe.com', 'integration:webhook:/hooks/telegram'],
      endpoint: ['endpoint:GET /users', 'endpoint:POST /a/b-c', 'endpoint:DELETE /', 'endpoint:cli derive'],
      datastore: ['datastore:sqlite', 'datastore:brain.sqlite', 'datastore:migrations:2026-07-10-add-users'],
      module: ['module:src/cli', 'module:src/cli/blueprint', 'module:app'],
      // Exactly what `partNodeId` mints, including the `-2` duplicate suffix.
      part: ['feature:chats/sse-events-endpoint', 'feature:chats/chat-ui-2', 'feature:auth/login'],
    };

    const INVALID: Record<ProposalKind, string[]> = {
      integration: [
        'integration:', // empty name
        'integration:has space',
        'integration:a:b', // bare colon form is webhook-only
        'integration:webhook:hooks', // webhook path must start with /
        'integration:webhook:/a b', // no spaces in webhook path
      ],
      endpoint: [
        'endpoint:get /users', // verb must be uppercase
        'endpoint:GET users', // path must start with /
        'endpoint:GET /a b', // no spaces in path
        'endpoint:cli two words', // CLI command is a single token
        'endpoint:cli ', // empty command
      ],
      datastore: ['datastore:', 'datastore:has space'],
      module: [
        'module:', // empty path
        'module:/abs/path', // must be repo-relative
        'module:src\\win', // posix separators only
        'module:has space',
      ],
      part: [
        'feature:chats', // a feature is not a part — the part slug is required
        'feature:chats/', // empty part slug
        'feature:/sse', // empty feature slug
        'feature:Chats/SSE', // slugs are lowercase (slugifyFeatureName's range)
        'feature:chats/sse events', // no spaces
        'feature:chats/sse/events', // one slash only
        'feature:-chats/sse', // no leading dash — nothing can mint this id
        'feature:chats/sse-', // no trailing dash
        'feature:chats/sse--events', // no doubled dash
        'chats/sse-events', // the `feature:` prefix is part of the grammar
      ],
    };

    it.each(PROPOSAL_KINDS.map((kind) => [kind] as const))(
      'should accept every valid %s id and refuse every invalid one',
      (kind) => {
        for (const id of VALID[kind]) {
          expect(isValidPredictedNodeId(kind, id)).toBe(true);
        }
        for (const id of INVALID[kind]) {
          expect(isValidPredictedNodeId(kind, id)).toBe(false);
        }
      },
    );

    it('should refuse kind/prefix disagreement — every pattern anchors its own prefix', () => {
      for (const kind of PROPOSAL_KINDS) {
        for (const otherKind of PROPOSAL_KINDS) {
          if (otherKind === kind) {
            continue;
          }
          for (const id of VALID[otherKind]) {
            expect(isValidPredictedNodeId(kind, id)).toBe(false);
          }
        }
      }
    });

    it('should document a human-readable grammar hint for every kind', () => {
      for (const kind of PROPOSAL_KINDS) {
        expect(PREDICTED_ID_GRAMMAR[kind].length).toBeGreaterThan(0);
        // Each hint names the prefix its ids actually carry. A part's ids are
        // minted under the OWNING FEATURE's prefix, not its own kind name —
        // asserting `part:` here would have documented an id nothing mints.
        expect(PREDICTED_ID_GRAMMAR[kind]).toContain(kind === 'part' ? 'feature:' : `${kind}:`);
      }
    });

    it('should separate part from the extractor kinds without widening BlueprintNodeKind', () => {
      expect(PROPOSAL_KINDS).toEqual([...EXTRACTOR_PROPOSAL_KINDS, 'part']);
      expect(EXTRACTOR_PROPOSAL_KINDS.every((kind) => isExtractorProposalKind(kind))).toBe(true);
      expect(isExtractorProposalKind('part')).toBe(false);
    });

    it('should refuse a part proposal whose id does not match the grammar, with a reason', () => {
      const refusal = validateProposalRecord({
        plan: 'plan_discovery-view_v1',
        node: 'part:sse-events', // the id an author would guess from the kind name
        kind: 'part',
        label: 'SSE events endpoint',
      });
      expect(refusal).toBe(
        "predicted id 'part:sse-events' does not match the part id grammar — expected feature:<slug>/<part-slug> or feature:<project>::<slug>/<part-slug> (e.g. feature:orbit-app::apps/scheduler)",
      );
      expect(formatProposeRefusal(refusal as string)).toContain('propose refused: predicted id');
    });

    it('should accept a part proposal carrying a well-formed part id', () => {
      expect(
        validateProposalRecord({
          plan: 'plan_discovery-view_v1',
          node: 'feature:chats/sse-events-endpoint',
          kind: 'part',
          label: 'SSE events endpoint',
        }),
      ).toBeNull();
    });
  });

  // ── lifecycle matrix (event folds) ───────────────────────

  describe('lifecycle fold matrix', () => {
    it.each([
      // [chain, expected state, has decidedAt, has confirmedAt]
      [['proposed'], 'proposed', false, false],
      [['proposed', 'accepted'], 'accepted', true, false],
      [['proposed', 'rejected'], 'rejected', true, false],
      [['proposed', 'confirmed'], 'confirmed', false, true], // derive confirms an undecided ghost
      [['proposed', 'accepted', 'confirmed'], 'confirmed', true, true],
      [['proposed', 'stale'], 'stale', false, false], // sweep of an undecided ghost
      [['proposed', 'accepted', 'stale'], 'stale', true, false], // sweep of accepted-unbuilt
      [['proposed', 'rejected', 'cleared'], 'cleared', true, false], // sweep of rejected
    ] as Array<[ProposalEventName[], ProposalEventName, boolean, boolean]>)(
      'should fold %j to state %s',
      (chain, expectedState, hasDecidedAt, hasConfirmedAt) => {
        appendChain({}, chain);

        const [folded] = readEffectiveProposals(flowDir);
        expect(folded.state).toBe(expectedState);
        expect(folded.proposedAt).toBe('2026-07-10T00:00:00.000Z');
        if (hasDecidedAt) {
          expect(folded.decidedAt).toBeDefined();
        } else {
          expect(folded.decidedAt).toBeUndefined();
        }
        if (hasConfirmedAt) {
          expect(folded.confirmedAt).toBeDefined();
        } else {
          expect(folded.confirmedAt).toBeUndefined();
        }
      },
    );

    it('should carry the payload from the FIRST proposed event, ignoring re-carried decision payloads', () => {
      appendProposalEvent(
        flowDir,
        makeEvent({
          phase: 2,
          detail: 'billing integration',
          anchors: [{ kind: 'file', ref: 'src/pay/stripe.ts' }],
        }),
      );
      appendProposalEvent(
        flowDir,
        makeEvent({
          ts: '2026-07-10T01:00:00.000Z',
          event: 'accepted',
          label: 'RE-CARRIED (must be ignored)',
          detail: 'tampered detail',
          provenance: 'cli:decide',
        }),
      );

      const [folded] = readEffectiveProposals(flowDir);
      expect(folded).toMatchObject({
        fingerprint: 'plan_pay+integration:stripe',
        kind: 'integration',
        label: 'Stripe SDK',
        detail: 'billing integration',
        phase: 2,
        anchors: [{ kind: 'file', ref: 'src/pay/stripe.ts' }],
        state: 'accepted',
        provenance: 'cli:propose',
        proposedAt: '2026-07-10T00:00:00.000Z',
        decidedAt: '2026-07-10T01:00:00.000Z',
      });
    });

    it('should drop fingerprints that never carry a proposed event', () => {
      appendProposalEvent(flowDir, makeEvent({ event: 'accepted' }));
      appendProposalEvent(
        flowDir,
        makeEvent({ predictedNodeId: 'datastore:cache', kind: 'datastore', label: 'Cache' }),
      );

      const folded = readEffectiveProposals(flowDir);
      expect(folded).toHaveLength(1);
      expect(folded[0].predictedNodeId).toBe('datastore:cache');
    });

    it('should break ts ties by file order — the later line wins', () => {
      const sameTs = '2026-07-10T00:00:00.000Z';
      appendProposalEvent(flowDir, makeEvent({ ts: sameTs }));
      appendProposalEvent(flowDir, makeEvent({ ts: sameTs, event: 'rejected' }));

      expect(readEffectiveProposals(flowDir)[0].state).toBe('rejected');
    });

    it('should scope reads to one plan when a plan filter is given', () => {
      appendProposalEvent(flowDir, makeEvent());
      appendProposalEvent(
        flowDir,
        makeEvent({ plan: 'plan_other', predictedNodeId: 'datastore:cache', kind: 'datastore', label: 'Cache' }),
      );

      expect(readEffectiveProposals(flowDir, 'plan_pay')).toHaveLength(1);
      expect(readEffectiveProposals(flowDir, 'plan_other')[0].predictedNodeId).toBe('datastore:cache');
      expect(readEffectiveProposals(flowDir, 'plan_nope')).toEqual([]);
      expect(readEffectiveProposals(flowDir)).toHaveLength(2);
    });
  });

  // ── re-propose semantics ─────────────────────────────────

  describe('re-propose', () => {
    it('should reset state to proposed without erasing decidedAt', () => {
      appendChain({}, ['proposed', 'rejected', 'cleared']);
      appendProposalEvent(
        flowDir,
        makeEvent({ ts: '2026-07-10T09:00:00.000Z', label: 'Stripe SDK v2' }),
      );

      const [folded] = readEffectiveProposals(flowDir);
      expect(folded.state).toBe('proposed');
      // Historical timestamps survive the reset — only the state reflects the
      // current lifecycle.
      expect(folded.decidedAt).toBe('2026-07-10T01:00:00.000Z');
      // Payload still comes from the FIRST proposed event.
      expect(folded.label).toBe('Stripe SDK');
      expect(folded.proposedAt).toBe('2026-07-10T00:00:00.000Z');
    });

    it('should reset state to proposed without erasing confirmedAt', () => {
      appendChain({}, ['proposed', 'accepted', 'confirmed']);
      appendProposalEvent(flowDir, makeEvent({ ts: '2026-07-10T09:00:00.000Z' }));

      const [folded] = readEffectiveProposals(flowDir);
      expect(folded.state).toBe('proposed');
      expect(folded.decidedAt).toBe('2026-07-10T01:00:00.000Z');
      expect(folded.confirmedAt).toBe('2026-07-10T02:00:00.000Z');
    });
  });

  // ── fold determinism ─────────────────────────────────────

  describe('fold determinism', () => {
    it('should return byte-equal results across two reads of the same store', () => {
      appendChain({}, ['proposed', 'accepted']);
      appendChain(
        { plan: 'plan_a', predictedNodeId: 'module:src/new', kind: 'module', label: 'New module' },
        ['proposed', 'stale'],
      );
      appendChain(
        { predictedNodeId: 'endpoint:GET /ghost', kind: 'endpoint', label: 'Ghost endpoint' },
        ['proposed', 'rejected', 'cleared'],
      );

      const first = readEffectiveProposals(flowDir);
      const second = readEffectiveProposals(flowDir);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });

    it('should sort by proposedAt then fingerprint, independent of file interleaving', () => {
      // Interleave three fingerprints out of order.
      appendProposalEvent(
        flowDir,
        makeEvent({ ts: '2026-07-10T02:00:00.000Z', predictedNodeId: 'datastore:zeta', kind: 'datastore', label: 'Z' }),
      );
      appendProposalEvent(flowDir, makeEvent({ ts: '2026-07-10T01:00:00.000Z' }));
      appendProposalEvent(
        flowDir,
        makeEvent({ ts: '2026-07-10T01:00:00.000Z', predictedNodeId: 'datastore:alpha', kind: 'datastore', label: 'A' }),
      );

      expect(readEffectiveProposals(flowDir).map((proposal) => proposal.fingerprint)).toEqual([
        'plan_pay+datastore:alpha', // ts tie with stripe — fingerprint breaks it
        'plan_pay+integration:stripe',
        'plan_pay+datastore:zeta',
      ]);
    });

    it('should fold the same event list identically regardless of caller (pure function)', () => {
      const events: ProposalEvent[] = [
        makeEvent(),
        makeEvent({ ts: '2026-07-10T01:00:00.000Z', event: 'accepted' }),
      ];
      expect(foldProposalEvents(events)).toEqual(foldProposalEvents([...events]));
    });
  });

  // ── lock behavior (single-writer invariant) ──────────────

  describe('appendProposalEvent lock', () => {
    it('should throw the exact busy notice and write nothing while the lock is held', () => {
      mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
      writeFileSync(lockPath(), '', 'utf-8');

      expect(() => appendProposalEvent(flowDir, makeEvent())).toThrow(PROPOSAL_STORE_BUSY_NOTICE);
      expect(() => appendProposalEvent(flowDir, makeEvent())).toThrow('proposal store busy — retry');
      expect(existsSync(storePath())).toBe(false);
      // The held lock is NOT ours to clean up — it must survive the failure.
      expect(existsSync(lockPath())).toBe(true);
    });

    it('should append normally after the lock is released, removing its own lock', () => {
      mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
      writeFileSync(lockPath(), '', 'utf-8');
      expect(() => appendProposalEvent(flowDir, makeEvent())).toThrow(PROPOSAL_STORE_BUSY_NOTICE);

      unlinkSync(lockPath());
      appendProposalEvent(flowDir, makeEvent());

      expect(storeLines()).toHaveLength(1);
      expect(existsSync(lockPath())).toBe(false);
      expect(readEffectiveProposals(flowDir)[0].state).toBe('proposed');
    });

    it('should create the blueprint directory on first append (silent-record semantics)', () => {
      expect(existsSync(join(flowDir, 'brain', '.structure'))).toBe(false);

      appendProposalEvent(flowDir, makeEvent());

      expect(storeLines()).toHaveLength(1);
      expect(JSON.parse(storeLines()[0])).toEqual(makeEvent());
    });
  });

  // ── malformed-line fail-soft ─────────────────────────────

  describe('parseProposalsFile', () => {
    it('should skip and COUNT malformed lines while keeping valid neighbors', () => {
      mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
      const valid = makeEvent();
      const validTail = makeEvent({
        ts: '2026-07-10T01:00:00.000Z',
        predictedNodeId: 'datastore:cache',
        kind: 'datastore',
        label: 'Cache',
      });
      writeFileSync(
        storePath(),
        [
          JSON.stringify(valid),
          'not json at all',
          '[1,2,3]', // parseable but not an object
          JSON.stringify({ ...makeEvent(), plan: '' }), // empty required field
          JSON.stringify({ ...makeEvent(), predictedNodeId: 42 }), // wrong type
          JSON.stringify({ ...makeEvent(), kind: 'bogus' }), // invalid kind
          JSON.stringify({ ...makeEvent(), label: null }), // invalid label
          JSON.stringify({ ...makeEvent(), event: 'exploded' }), // invalid event name
          JSON.stringify(validTail),
        ].join('\n') + '\n',
        'utf-8',
      );

      const { events, skipped } = parseProposalsFile(storePath());
      expect(skipped).toBe(7);
      expect(events).toHaveLength(2);
      expect(events[0].predictedNodeId).toBe('integration:stripe');
      expect(events[1].predictedNodeId).toBe('datastore:cache');
      // A poisoned store still folds the survivors.
      expect(readEffectiveProposals(flowDir)).toHaveLength(2);
    });

    it('should default optional fields and drop malformed anchor elements individually', () => {
      mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
      writeFileSync(
        storePath(),
        JSON.stringify({
          plan: 'plan_pay',
          predictedNodeId: 'integration:stripe',
          kind: 'integration',
          label: 'Stripe SDK',
          event: 'proposed',
          phase: 2.5, // non-integer — dropped
          anchors: [null, { kind: 'bogus', ref: 'x' }, { kind: 'file', ref: 'src/pay/stripe.ts' }],
          // ts and provenance missing — default to ''
        }) + '\n',
        'utf-8',
      );

      const { events, skipped } = parseProposalsFile(storePath());
      expect(skipped).toBe(0);
      expect(events[0]).toEqual({
        ts: '',
        plan: 'plan_pay',
        predictedNodeId: 'integration:stripe',
        kind: 'integration',
        label: 'Stripe SDK',
        event: 'proposed',
        provenance: '',
        anchors: [{ kind: 'file', ref: 'src/pay/stripe.ts' }],
      });
    });

    it('should yield empty results for a missing file', () => {
      expect(parseProposalsFile(storePath())).toEqual({ events: [], skipped: 0 });
      expect(readEffectiveProposals(flowDir)).toEqual([]);
    });

    it('should expose the six lifecycle event names in lifecycle order', () => {
      expect(PROPOSAL_EVENT_NAMES).toEqual(['proposed', 'accepted', 'rejected', 'confirmed', 'stale', 'cleared']);
    });
  });

  // ── CLI ↔ app fold parity fixture ────────────────────────
  //
  // SYNC NOTE: this fixture and its expected fold are DUPLICATED in
  // app/src/main/blueprint/blueprint-observer.test.ts ("CLI fold parity" —
  // foldProposalStream must produce the identical effective proposals from
  // the identical lines). When either side changes, update both.

  describe('fold parity fixture (shared with the app observer test)', () => {
    const PARITY_FIXTURE_LINES = [
      '{"ts":"2026-07-10T00:00:00.000Z","plan":"plan_pay","phase":2,"predictedNodeId":"integration:stripe","kind":"integration","label":"Stripe SDK","detail":"billing integration","anchors":[{"kind":"file","ref":"src/pay/stripe.ts"}],"event":"proposed","provenance":"cli:propose"}',
      '{"ts":"2026-07-10T01:00:00.000Z","plan":"plan_pay","predictedNodeId":"datastore:cache","kind":"datastore","label":"Cache","event":"proposed","provenance":"cli:propose"}',
      '{"ts":"2026-07-10T02:00:00.000Z","plan":"plan_pay","predictedNodeId":"integration:stripe","kind":"integration","label":"RE-CARRIED (ignored)","event":"accepted","provenance":"cli:propose"}',
      'not json — must be skipped by both folds',
      '{"ts":"2026-07-10T03:00:00.000Z","plan":"plan_pay","predictedNodeId":"endpoint:GET /ghost","kind":"endpoint","label":"Orphan decision","event":"accepted","provenance":"cli:propose"}',
      '{"ts":"2026-07-10T04:00:00.000Z","plan":"plan_pay","phase":2,"predictedNodeId":"integration:stripe","kind":"integration","label":"Stripe SDK","event":"confirmed","provenance":"derive:confirm"}',
      '{"ts":"2026-07-10T05:00:00.000Z","plan":"plan_pay","predictedNodeId":"datastore:cache","kind":"datastore","label":"Cache","event":"stale","provenance":"cli:sweep"}',
      '{"ts":"2026-07-10T06:00:00.000Z","plan":"plan_pay","predictedNodeId":"datastore:cache","kind":"datastore","label":"Cache v2 (ignored)","event":"proposed","provenance":"cli:propose"}',
    ] as const;

    const EXPECTED_PARITY_FOLD: EffectiveProposal[] = [
      {
        fingerprint: 'plan_pay+integration:stripe',
        plan: 'plan_pay',
        predictedNodeId: 'integration:stripe',
        kind: 'integration',
        label: 'Stripe SDK',
        anchors: [{ kind: 'file', ref: 'src/pay/stripe.ts' }],
        state: 'confirmed',
        provenance: 'cli:propose',
        proposedAt: '2026-07-10T00:00:00.000Z',
        phase: 2,
        detail: 'billing integration',
        decidedAt: '2026-07-10T02:00:00.000Z',
        confirmedAt: '2026-07-10T04:00:00.000Z',
      },
      {
        fingerprint: 'plan_pay+datastore:cache',
        plan: 'plan_pay',
        predictedNodeId: 'datastore:cache',
        kind: 'datastore',
        label: 'Cache',
        anchors: [],
        state: 'proposed', // re-proposed after the sweep — state resets
        provenance: 'cli:propose',
        proposedAt: '2026-07-10T01:00:00.000Z',
      },
    ];

    it('should fold the parity fixture into the expected effective proposals', () => {
      mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
      writeFileSync(storePath(), `${PARITY_FIXTURE_LINES.join('\n')}\n`, 'utf-8');

      const { skipped } = parseProposalsFile(storePath());
      expect(skipped).toBe(1); // only the corrupt line — the orphan decision parses fine, drops at fold

      expect(readEffectiveProposals(flowDir)).toEqual(EXPECTED_PARITY_FOLD);
    });
  });

  // ── new vs changed: DERIVED, never declared ──────────────
  //
  // A `--state` flag was rejected because a declared state can disagree with
  // reality and still be repeated back as fact. These lock the derivation:
  // the answer comes from whether the anchors resolve, through the ONE
  // resolver, in all three anchor forms.

  describe('deriveProposalChange', () => {
    /** A graph holding one module node, for `module:` anchor resolution. */
    const GRAPH = {
      version: 1,
      nodes: [{ id: 'module:src/cli/blueprint', kind: 'module', label: 'blueprint' }],
      edges: [],
    } as unknown as Parameters<typeof deriveProposalChange>[1];

    /** An effective proposal carrying the given anchors. */
    function proposalWithAnchors(anchors: Anchor[], kind: ProposalKind = 'part'): EffectiveProposal {
      return {
        fingerprint: 'plan_dv+feature:chats/sse-events-endpoint',
        plan: 'plan_dv',
        predictedNodeId: kind === 'part' ? 'feature:chats/sse-events-endpoint' : 'module:src/new',
        kind,
        label: 'SSE events endpoint',
        anchors,
        state: 'proposed',
        provenance: 'cli:propose',
        proposedAt: '2026-08-10T00:00:00.000Z',
      };
    }

    it('should report changed for a BARE path anchor that exists — the part form', () => {
      const derived = deriveProposalChange(
        proposalWithAnchors([{ kind: 'file', ref: 'src/routes/chat/sse.ts' }]),
        GRAPH,
        '/repo',
        (path) => path === '/repo/src/routes/chat/sse.ts',
      );
      expect(derived.change).toBe('changed');
      expect(derived.resolvedAnchors).toEqual(['src/routes/chat/sse.ts']);
    });

    it('should report changed for a file:-prefixed anchor that exists', () => {
      const derived = deriveProposalChange(
        proposalWithAnchors([{ kind: 'file', ref: 'file:src/routes/chat/sse.ts' }]),
        GRAPH,
        '/repo',
        () => true,
      );
      expect(derived.change).toBe('changed');
    });

    it('should report changed for a module: anchor already in the graph, with no disk at all', () => {
      const derived = deriveProposalChange(
        proposalWithAnchors([{ kind: 'module', ref: 'module:src/cli/blueprint' }], 'module'),
        GRAPH,
        '/repo',
        () => false,
      );
      expect(derived.change).toBe('changed');
    });

    it('should report new when no anchor resolves', () => {
      const derived = deriveProposalChange(
        proposalWithAnchors([
          { kind: 'file', ref: 'src/routes/chat/does-not-exist.ts' },
          { kind: 'module', ref: 'module:src/ghost' },
        ]),
        GRAPH,
        '/repo',
        () => false,
      );
      expect(derived.change).toBe('new');
      expect(derived.resolvedAnchors).toEqual([]);
    });

    it('should report new for a proposal with no anchors — silence is not an assertion', () => {
      expect(deriveProposalChange(proposalWithAnchors([]), GRAPH, '/repo', () => true).change).toBe('new');
    });

    it('should report changed when ONE of several anchors resolves', () => {
      const derived = deriveProposalChange(
        proposalWithAnchors([
          { kind: 'file', ref: 'src/gone.ts' },
          { kind: 'file', ref: 'src/here.ts' },
        ]),
        GRAPH,
        '/repo',
        (path) => path === '/repo/src/here.ts',
      );
      expect(derived.change).toBe('changed');
      expect(derived.resolvedAnchors).toEqual(['src/here.ts']);
    });

    it('should never re-prefix an anchor whose ref already names its kind', () => {
      // `{kind:'file', ref:'file:src/x.ts'}` must resolve `src/x.ts`, never
      // `file:src/x.ts` — the double-prefix bug that would report every
      // prefixed anchor as unresolved and so every changed proposal as new.
      const seen: string[] = [];
      deriveProposalChange(
        proposalWithAnchors([{ kind: 'file', ref: 'file:src/x.ts' }]),
        GRAPH,
        '/repo',
        (path) => {
          seen.push(path);
          return true;
        },
      );
      expect(seen).toEqual(['/repo/src/x.ts']);
    });

    it('should carry every folded field through untouched', () => {
      const proposal = proposalWithAnchors([]);
      const derived = deriveProposalChange(proposal, GRAPH, '/repo', () => false);
      expect(derived).toEqual({ ...proposal, change: 'new', resolvedAnchors: [] });
    });
  });

  // ── per-kind confirmation: two graphs, one exact match ───
  //
  // A part is not in `graph.json`. Confirmed against the extractor graph
  // alone, every proposed part missed, stayed unconfirmed and quietly staled
  // on the next sweep while the derive line still reported healthily.

  describe('confirmableProposals / isProposalConfirmed', () => {
    const sources = (graphIds: string[], partIds: string[]) => ({
      graphNodeIds: new Set(graphIds),
      partNodeIds: new Set(partIds),
    });

    function effective(
      kind: ProposalKind,
      predictedNodeId: string,
      state: ProposalEventName = 'proposed',
    ): EffectiveProposal {
      return {
        fingerprint: `plan_dv+${predictedNodeId}`,
        plan: 'plan_dv',
        predictedNodeId,
        kind,
        label: predictedNodeId,
        anchors: [],
        state,
        provenance: 'cli:propose',
        proposedAt: '2026-08-10T00:00:00.000Z',
      };
    }

    it('should confirm a part against the FEATURE graph, with graph.json empty', () => {
      const part = effective('part', 'feature:chats/sse-events-endpoint');
      expect(isProposalConfirmed(part, sources([], ['feature:chats/sse-events-endpoint']))).toBe(true);
    });

    it('REGRESSION: a part is never confirmed by graph.json — the silent-stale path', () => {
      const part = effective('part', 'feature:chats/sse-events-endpoint');
      // Every id in the world present in the EXTRACTOR graph, none in the
      // feature graph: the part must still not confirm, because that is not
      // the graph it lives in.
      expect(
        isProposalConfirmed(part, sources(['feature:chats/sse-events-endpoint'], [])),
      ).toBe(false);
    });

    it('should confirm an extractor kind against graph.json, never against the part ids', () => {
      const module = effective('module', 'module:src/pay');
      expect(isProposalConfirmed(module, sources(['module:src/pay'], []))).toBe(true);
      expect(isProposalConfirmed(module, sources([], ['module:src/pay']))).toBe(false);
    });

    it('should only confirm proposals in a confirmable state', () => {
      const ids = sources(['module:src/pay'], []);
      const states: ProposalEventName[] = PROPOSAL_EVENT_NAMES.filter((name) => name !== 'proposed');
      expect(confirmableProposals([effective('module', 'module:src/pay')], ids)).toHaveLength(1);
      expect(
        confirmableProposals([effective('module', 'module:src/pay', 'accepted')], ids),
      ).toHaveLength(1);
      for (const state of states) {
        if (state === 'accepted') continue;
        expect(confirmableProposals([effective('module', 'module:src/pay', state)], ids)).toEqual([]);
      }
    });

    it('should select both kinds in one pass, each against its own id set, in fold order', () => {
      const proposals = [
        effective('module', 'module:src/pay'),
        effective('part', 'feature:chats/sse-events-endpoint'),
        effective('part', 'feature:chats/never-built'),
        effective('endpoint', 'endpoint:GET /ghost'),
      ];
      const selected = confirmableProposals(
        proposals,
        sources(['module:src/pay'], ['feature:chats/sse-events-endpoint']),
      );
      expect(selected.map((proposal) => proposal.predictedNodeId)).toEqual([
        'module:src/pay',
        'feature:chats/sse-events-endpoint',
      ]);
    });
  });

  // ── determinism of the derived read ──────────────────────

  describe('derived-state determinism', () => {
    it('should yield deep-equal derived states for the same store read twice', () => {
      // One anchor that really exists and one that does not, so deep-equality
      // is a statement about a MIXED result rather than two copies of one
      // uniform answer (a determinism test over a constant proves nothing).
      mkdirSync(join(flowDir, 'src', 'routes', 'chat'), { recursive: true });
      writeFileSync(join(flowDir, 'src', 'routes', 'chat', 'sse.ts'), 'export const sse = 1\n', 'utf-8');
      appendChain({ plan: 'plan_dv', predictedNodeId: 'integration:stripe', kind: 'integration' }, [
        'proposed',
      ]);
      appendProposalEvent(
        flowDir,
        makeEvent({
          ts: '2026-08-10T02:00:00.000Z',
          plan: 'plan_dv',
          predictedNodeId: 'feature:chats/sse-events-endpoint',
          kind: 'part',
          label: 'SSE events endpoint',
          anchors: [{ kind: 'file', ref: 'src/routes/chat/sse.ts' }],
        }),
      );
      appendProposalEvent(
        flowDir,
        makeEvent({
          ts: '2026-08-10T03:00:00.000Z',
          plan: 'plan_dv',
          predictedNodeId: 'feature:chats/reconnect',
          kind: 'part',
          label: 'Reconnect',
          anchors: [{ kind: 'file', ref: 'src/routes/chat/gone.ts' }],
        }),
      );

      const first = deriveProposalChanges(readEffectiveProposals(flowDir), null, flowDir);
      const second = deriveProposalChanges(readEffectiveProposals(flowDir), null, flowDir);

      expect(first).toEqual(second);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(first.map((proposal) => proposal.change)).toEqual(['new', 'changed', 'new']);
    });

    it('should stay deep-equal across two reads when an anchor really exists on disk', () => {
      mkdirSync(join(flowDir, 'src'), { recursive: true });
      writeFileSync(join(flowDir, 'src', 'sse.ts'), 'export const sse = 1\n', 'utf-8');
      appendProposalEvent(
        flowDir,
        makeEvent({
          plan: 'plan_dv',
          predictedNodeId: 'feature:chats/sse-events-endpoint',
          kind: 'part',
          label: 'SSE events endpoint',
          anchors: [{ kind: 'file', ref: 'src/sse.ts' }],
        }),
      );

      const first = readProposalsWithChange(flowDir, null, flowDir);
      const second = readProposalsWithChange(flowDir, null, flowDir);
      expect(first).toEqual(second);
      expect(first.map((proposal) => proposal.change)).toEqual(['changed']);
    });
  });

  // ── accounting: the store can count to zero out loud ─────
  //
  // The store went un-written in every project on this machine because no
  // code path ever reported what a run recorded. These lock the accounting
  // that makes an empty store a REPORTABLE outcome rather than a silent one.

  describe('countProposals / formatProposalsRecorded', () => {
    it('should report an empty store as a zero count, not an absence', () => {
      const counts = countProposals(readEffectiveProposals(flowDir, 'plan_pay'));

      expect(counts.total).toBe(0);
      expect(counts.live).toBe(0);
      // Every state key present and zero-filled — no "absent vs none" ambiguity
      for (const state of PROPOSAL_EVENT_NAMES) {
        expect(counts.byState[state]).toBe(0);
      }
      expect(formatProposalsRecorded(counts)).toBe('proposals: 0 recorded');
    });

    it('should count a plan-scoped store by state, with live = proposed+accepted+rejected', () => {
      appendChain({ predictedNodeId: 'integration:stripe' }, ['proposed']);
      appendChain({ predictedNodeId: 'datastore:cache' }, ['proposed', 'accepted']);
      appendChain({ predictedNodeId: 'endpoint:GET /a' }, ['proposed', 'rejected']);
      appendChain({ predictedNodeId: 'module:src/dead' }, ['proposed', 'stale']);
      appendChain({ predictedNodeId: 'module:src/real' }, ['proposed', 'confirmed']);

      const counts = countProposals(readEffectiveProposals(flowDir, 'plan_pay'));

      expect(counts.total).toBe(5);
      expect(counts.live).toBe(3);
      expect(counts.byState).toEqual({
        proposed: 1,
        accepted: 1,
        rejected: 1,
        confirmed: 1,
        stale: 1,
        cleared: 0,
      });
      expect(LIVE_PROPOSAL_STATES).toEqual(['proposed', 'accepted', 'rejected']);
    });

    it('should surface the live subset only when it differs from the total', () => {
      expect(formatProposalsRecorded(countProposals([]))).toBe('proposals: 0 recorded');

      appendChain({ predictedNodeId: 'integration:stripe' }, ['proposed']);
      expect(formatProposalsRecorded(countProposals(readEffectiveProposals(flowDir, 'plan_pay')))).toBe(
        'proposals: 1 recorded',
      );

      appendChain({ predictedNodeId: 'datastore:cache' }, ['proposed', 'confirmed']);
      expect(formatProposalsRecorded(countProposals(readEffectiveProposals(flowDir, 'plan_pay')))).toBe(
        'proposals: 2 recorded (1 live)',
      );
    });

    it('should scope counts to one plan so a report never borrows another plan’s credit', () => {
      appendChain({ plan: 'plan_pay', predictedNodeId: 'integration:stripe' }, ['proposed']);
      appendChain({ plan: 'plan_other', predictedNodeId: 'module:src/other' }, ['proposed']);

      expect(countProposals(readEffectiveProposals(flowDir, 'plan_pay')).total).toBe(1);
      expect(countProposals(readEffectiveProposals(flowDir, 'plan_none')).total).toBe(0);
      expect(countProposals(readEffectiveProposals(flowDir)).total).toBe(2);
    });
  });

  // ── REGRESSION: a refusal is reportable, never a silent non-event ──
  //
  // The store went un-written partly because a refused propose could be
  // "skipped silently and continued" — the caller had nothing to surface even
  // if it wanted to. These lock the contract that EVERY rejected write hands
  // back a non-empty, caller-surfaceable reason, and that a valid one does
  // not (null is the only "nothing to say" value in this vocabulary).

  describe('attachment by anchor overlap', () => {
    /** A feature claiming the given anchors. Structurally a `FeatureNode` subset. */
    function feature(slug: string, anchors: string[]): AttachableFeature {
      return { id: `feature:${slug}`, slug, name: slug, anchors };
    }

    /** An effective proposal carrying the given anchors, label and detail. */
    function proposal(anchors: Anchor[], overrides: Partial<EffectiveProposal> = {}): EffectiveProposal {
      return {
        fingerprint: 'plan_dv+module:src/cli/blueprint',
        plan: 'plan_dv',
        predictedNodeId: 'module:src/cli/blueprint',
        kind: 'module',
        label: 'Parts store invariant',
        detail: 'writeParts refuses a feature whose kind is not core',
        anchors,
        state: 'proposed',
        provenance: 'cli:propose',
        proposedAt: '2026-08-10T00:00:00.000Z',
        ...overrides,
      };
    }

    describe('anchorPath / anchorContains', () => {
      it.each<[string, string | null]>([
        ['module:src/cli/blueprint', 'src/cli/blueprint'],
        ['file:src/cli/blueprint/store.ts', 'src/cli/blueprint/store.ts'],
        ['file:src/cli/blueprint/store.ts:writeParts', 'src/cli/blueprint/store.ts'],
        ['src/cli/blueprint/store.ts', 'src/cli/blueprint/store.ts'],
        ['endpoint:GET /users', null],
        ['symbol:writeParts', null],
      ])('should read the path of %s as %s', (ref, expected) => {
        expect(anchorPath(ref)).toBe(expected);
      });

      it('should hold containment in ONE direction — a claim contains its descendants, never the reverse', () => {
        expect(anchorContains('module:src', 'module:src/cli/blueprint')).toBe(true);
        expect(anchorContains('module:src/cli/blueprint', 'module:src')).toBe(false);
      });

      it('should treat a module claim as containing a file inside it, across anchor forms', () => {
        expect(anchorContains('module:src/cli/blueprint', 'file:src/cli/blueprint/store.ts')).toBe(true);
        expect(anchorContains('module:src/cli/blueprint', 'src/cli/blueprint/store.ts')).toBe(true);
      });

      it('should never invent a hierarchy for identity anchors — only exact equality matches', () => {
        expect(anchorContains('endpoint:GET /users', 'endpoint:GET /users')).toBe(true);
        expect(anchorContains('endpoint:GET /users', 'endpoint:GET /users/1')).toBe(false);
      });

      it('should not match a sibling directory sharing a name prefix', () => {
        expect(anchorContains('module:src/cli/blue', 'module:src/cli/blueprint')).toBe(false);
      });
    });

    it('should attach a proposal to the features whose claim holds its anchor, nearest claim winning', () => {
      const attached = attachProposal(proposal([{ kind: 'module', ref: 'src/cli/blueprint' }]), [
        feature('drift', ['module:src']),
        feature('trust-tiers', ['module:src/cli/blueprint']),
        feature('command-palette', ['module:app/src/renderer']),
      ]);

      // `drift` claims all of `module:src` and loses to the exact claim — clause 2.
      expect(attached.features.map((entry) => entry.featureId)).toEqual(['feature:trust-tiers']);
    });

    it('should carry label and detail through — a changed node is only informative because of them', () => {
      const attached = attachProposal(proposal([{ kind: 'module', ref: 'src/cli/blueprint' }]), [
        feature('trust-tiers', ['module:src/cli/blueprint']),
      ]);

      expect(attached.label).toBe('Parts store invariant');
      expect(attached.detail).toBe('writeParts refuses a feature whose kind is not core');
      expect(attached.predictedNodeId).toBe('module:src/cli/blueprint');
      expect(attached.kind).toBe('module');
      expect(attached.plan).toBe('plan_dv');
    });

    it('should carry the derived change state through when the caller already derived it', () => {
      const withChange = { ...proposal([{ kind: 'module', ref: 'src/cli/blueprint' }]), change: 'changed' as const, resolvedAnchors: ['src/cli/blueprint'] };

      const attached = attachProposal(withChange, [feature('trust-tiers', ['module:src/cli/blueprint'])]);

      expect(attached.change).toBe('changed');
    });

    it('should leave change undefined when the caller never derived it — attachment is graph-free', () => {
      const attached = attachProposal(proposal([{ kind: 'module', ref: 'src/cli/blueprint' }]), [
        feature('trust-tiers', ['module:src/cli/blueprint']),
      ]);

      expect(attached.change).toBeUndefined();
    });

    it('should show a genuinely cross-cutting proposal on BOTH features it spans', () => {
      const attached = attachProposal(
        proposal([
          { kind: 'file', ref: 'src/cli/blueprint/store.ts' },
          { kind: 'file', ref: 'app/src/renderer/blueprint/board.ts' },
        ]),
        [
          feature('cli-side', ['module:src/cli/blueprint']),
          feature('board-side', ['module:app/src/renderer/blueprint']),
        ],
      );

      expect(attached.features.map((entry) => entry.featureId).sort()).toEqual([
        'feature:board-side',
        'feature:cli-side',
      ]);
      expect(attached.features.find((entry) => entry.featureId === 'feature:cli-side')?.viaAnchors).toEqual([
        'src/cli/blueprint/store.ts',
      ]);
    });

    it('should report an anchor no feature claims as unclaimed rather than dropping it', () => {
      const attached = attachProposal(
        proposal([
          { kind: 'module', ref: 'src/cli/blueprint' },
          { kind: 'module', ref: 'docs/internal' },
        ]),
        [feature('trust-tiers', ['module:src/cli/blueprint'])],
      );

      expect(attached.unclaimed).toEqual(['docs/internal']);
      expect(attached.features).toHaveLength(1);
    });

    it('should not attach downward — a proposal broader than a feature claim names the tree, not the feature', () => {
      const attached = attachProposal(proposal([{ kind: 'module', ref: 'src' }]), [
        feature('trust-tiers', ['module:src/cli/blueprint']),
      ]);

      expect(attached.features).toEqual([]);
      expect(attached.unclaimed).toEqual(['src']);
    });

    it('should report BOTH directions in the raw relation — that is the width the rule is measured against', () => {
      const overlaps = overlappingFeatures(['module:src/cli/blueprint'], [
        feature('drift', ['module:src']),
        feature('trust-tiers', ['module:src/cli/blueprint']),
        feature('change-brief', ['file:src/cli/blueprint/brief-model.ts']),
      ]);

      expect(overlaps.map((entry) => entry.featureId)).toEqual([
        'feature:drift',
        'feature:trust-tiers',
        'feature:change-brief',
      ]);
      expect(overlaps.find((entry) => entry.featureId === 'feature:trust-tiers')?.exact).toBe(true);
      expect(overlaps.find((entry) => entry.featureId === 'feature:drift')?.exact).toBe(false);
    });

    it('should answer the board question through proposalsForFeature, not a re-implemented membership test', () => {
      const features = [
        feature('cli-side', ['module:src/cli/blueprint']),
        feature('board-side', ['module:app/src/renderer/blueprint']),
      ];
      const attachments = attachProposals(
        [
          proposal([{ kind: 'file', ref: 'src/cli/blueprint/store.ts' }]),
          proposal([{ kind: 'file', ref: 'app/src/renderer/blueprint/board.ts' }], {
            predictedNodeId: 'module:app/src/renderer/blueprint',
            fingerprint: 'plan_dv+module:app/src/renderer/blueprint',
          }),
        ],
        features,
      );

      expect(proposalsForFeature(attachments, 'feature:cli-side').map((entry) => entry.predictedNodeId)).toEqual([
        'module:src/cli/blueprint',
      ]);
      expect(proposalsForFeature(attachments, 'feature:nobody')).toEqual([]);
    });

    it('should be deterministic — the same proposal and features attach deep-equal twice', () => {
      const features = [
        feature('drift', ['module:src']),
        feature('trust-tiers', ['module:src/cli/blueprint']),
      ];
      const input = proposal([{ kind: 'module', ref: 'src/cli/blueprint' }]);

      expect(attachProposal(input, features)).toEqual(attachProposal(input, features));
    });

    it('should attach nothing for a proposal with no anchors, without throwing', () => {
      const attached = attachProposal(proposal([]), [feature('trust-tiers', ['module:src/cli/blueprint'])]);

      expect(attached.features).toEqual([]);
      expect(attached.unclaimed).toEqual([]);
    });

    describe('the specificity rule', () => {
      /**
       * THE REAL CASE, verbatim from this repo's own feature store (2026-08-10):
       * `module:src/cli/blueprint` is a live proposal anchor, and FIVE features
       * claim that exact directory while five more claim files inside it. Raw
       * overlap put the proposal on ten features; the rule must not.
       */
      const REAL_BLUEPRINT_CLAIMANTS: AttachableFeature[] = [
        // The five that claim `module:src/cli/blueprint` outright.
        feature('blueprint-simulation', ['module:app/src/renderer/blueprint', 'module:src/cli/blueprint', 'module:src/cli/commands', 'module:src/cli/state']),
        feature('brain-first-retrieval', ['module:app/src/main/agent', 'module:src/cli/blueprint', 'module:src/cli/blueprint/extractors', 'module:src/cli/commands']),
        feature('drift', ['module:app/src/main/learn', 'module:src', 'module:src/cli/blueprint', 'module:src/cli/blueprint/render']),
        feature('progressive-learning', ['module:app/src/main/agent', 'module:app/src/renderer/blueprint', 'module:src/cli/blueprint']),
        feature('trust-tiers', ['module:app/src/main/agent', 'module:src/cli/blueprint', 'module:src/cli/blueprint/extractors']),
        // Five more claiming FILES inside it — reached only by attaching downward.
        feature('change-brief', ['file:src/cli/blueprint/brief-model.ts', 'file:src/cli/blueprint/store.ts']),
        feature('feature-blueprint', ['file:src/cli/blueprint/proposal-store.ts', 'file:src/cli/blueprint/types.ts']),
        feature('compiled-run-scripts', ['file:src/cli/blueprint/story-compile.ts']),
        feature('native-full-preview', ['src/cli/blueprint/story-grammar.ts']),
        feature('framework-aware-extraction', ['file:src/cli/blueprint/extractors/scan.ts']),
      ];

      it('should refuse module:src/cli/blueprint — the confirmed real over-attachment, 5 exact claimants', () => {
        const anchor = { kind: 'module', ref: 'module:src/cli/blueprint' } as Anchor;

        const raw = new Set(overlappingFeatures(['module:src/cli/blueprint'], REAL_BLUEPRINT_CLAIMANTS).map((entry) => entry.featureId));
        const attached = attachProposal(proposal([anchor]), REAL_BLUEPRINT_CLAIMANTS);

        // Before the rule: every feature that touches the directory in either direction.
        expect(raw.size).toBe(10);
        // After it: none — and the refusal is REPORTED, with its claimants.
        expect(attached.features).toEqual([]);
        expect(attached.ambiguous).toHaveLength(1);
        expect(attached.ambiguous[0].claimants).toEqual([
          'feature:blueprint-simulation',
          'feature:brain-first-retrieval',
          'feature:drift',
          'feature:progressive-learning',
          'feature:trust-tiers',
        ]);
        expect(attached.ambiguous[0].reason).toContain('claimed by 5 features');
        expect(attached.ambiguous[0].reason).toContain('too broad to attach');
      });

      it('should refuse module:src — the anchor that would otherwise attach to every feature in the project', () => {
        const attached = attachProposal(
          proposal([{ kind: 'module', ref: 'module:src' } as Anchor]),
          REAL_BLUEPRINT_CLAIMANTS,
        );

        // Only `drift` claims `module:src`, so the cap never even fires — clause 1
        // already refuses to attach downward into the nine features inside it.
        expect(attached.features.map((entry) => entry.featureId)).toEqual(['feature:drift']);
        expect(attached.ambiguous).toEqual([]);
      });

      it('should let a narrower anchor rescue a refused proposal — the rule rewards precision', () => {
        const attached = attachProposal(
          proposal([{ kind: 'file', ref: 'file:src/cli/blueprint/proposal-store.ts' } as Anchor]),
          REAL_BLUEPRINT_CLAIMANTS,
        );

        // `feature-blueprint` claims that exact file; the five directory claims
        // contain it but lose the tier, so one feature attaches instead of five.
        expect(attached.features.map((entry) => entry.featureId)).toEqual(['feature:feature-blueprint']);
        expect(attached.ambiguous).toEqual([]);
      });

      it('should still show a cross-cutting change on every feature up to the cap', () => {
        const three = [
          feature('a', ['module:src/cli/blueprint']),
          feature('b', ['module:src/cli/blueprint']),
          feature('c', ['module:src/cli/blueprint']),
        ];

        const attached = attachProposal(proposal([{ kind: 'module', ref: 'module:src/cli/blueprint' } as Anchor]), three);

        expect(attached.features.map((entry) => entry.featureId)).toEqual(['feature:a', 'feature:b', 'feature:c']);
        expect(attached.ambiguous).toEqual([]);
      });

      it('should refuse the fourth claimant rather than crowding the board', () => {
        const four = [
          feature('a', ['module:src/cli/blueprint']),
          feature('b', ['module:src/cli/blueprint']),
          feature('c', ['module:src/cli/blueprint']),
          feature('d', ['module:src/cli/blueprint']),
        ];

        const attached = attachProposal(proposal([{ kind: 'module', ref: 'module:src/cli/blueprint' } as Anchor]), four);

        expect(attached.features).toEqual([]);
        expect(attached.ambiguous[0].claimants).toHaveLength(4);
      });

      it('should refuse only the broad anchor of a proposal, never its precise one', () => {
        const attached = attachProposal(
          proposal([
            { kind: 'module', ref: 'module:src/cli/blueprint' } as Anchor,
            { kind: 'file', ref: 'file:src/cli/blueprint/proposal-store.ts' } as Anchor,
          ]),
          REAL_BLUEPRINT_CLAIMANTS,
        );

        expect(attached.features.map((entry) => entry.featureId)).toEqual(['feature:feature-blueprint']);
        expect(attached.ambiguous.map((entry) => entry.ref)).toEqual(['module:src/cli/blueprint']);
      });

      it('should keep the cap at a stated, auditable number rather than an inline literal', () => {
        expect(MAX_ANCHOR_CLAIMANTS).toBe(3);
      });
    });
  });

  describe('expiry — source gone (stale, never delete)', () => {
    /** Write a source doc into one of `flow/`'s live source dirs. */
    function writeDoc(dirname: string, basename: string): void {
      const dir = join(flowDir, dirname);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${basename}.md`), '# doc\n', 'utf-8');
    }

    /** An effective proposal belonging to one plan, in one state. */
    function proposalOf(plan: string, state: ProposalEventName = 'proposed'): EffectiveProposal {
      return {
        fingerprint: `${plan}+module:src/x`,
        plan,
        predictedNodeId: 'module:src/x',
        kind: 'module',
        label: 'x',
        anchors: [],
        state,
        provenance: 'cli:propose',
        proposedAt: '2026-08-10T00:00:00.000Z',
      };
    }

    describe('proposalSourceSlug', () => {
      it.each<[string, string]>([
        ['plan_discovery-view_v1', 'discovery-view'],
        ['discovery_discovery-view_v1', 'discovery-view'],
        ['brainstorm_discovery-view_v2', 'discovery-view'],
        ['plan_change-record-parts_v1', 'change-record-parts'],
      ])('should read the slug of %s as %s', (plan, slug) => {
        expect(proposalSourceSlug(plan)).toBe(slug);
      });

      it('should treat an unconventional plan name as its own slug rather than shortening it', () => {
        expect(proposalSourceSlug('ad-hoc-exploration')).toBe('ad-hoc-exploration');
      });
    });

    it('should read a live doc from every source dir, and treat a missing dir as no error', () => {
      writeDoc('plans', 'plan_a_v1');
      writeDoc('discovery', 'discovery_b_v1');
      // No `flow/brainstorms/` at all — a fresh checkout must not stale a store.

      const index = readProposalSourceIndex(flowDir);

      expect(index.liveDocs.has('plan_a_v1')).toBe(true);
      expect(index.liveDocs.has('discovery_b_v1')).toBe(true);
      expect(index.liveSlugs.has('a')).toBe(true);
      expect(index.liveSlugs.has('b')).toBe(true);
    });

    it('should not let an unconventionally named doc claim a slug it does not own', () => {
      writeDoc('plans', 'notes');

      expect(readProposalSourceIndex(flowDir).liveSlugs.has('notes')).toBe(false);
    });

    it('should keep a discovery live once its PLAN exists — the doc has done its job', () => {
      writeDoc('plans', 'plan_discovery-view_v1');
      const index = readProposalSourceIndex(flowDir);

      // The discovery doc itself is gone; a plan of its slug is not.
      expect(isProposalSourceLive('discovery_discovery-view_v1', index)).toBe(true);
    });

    it('should keep a plan named-but-not-yet-written live from its discovery — the real store case', () => {
      // Verbatim from this repo: three proposals carry
      // `plan_change-record-parts_v1`, and only the discovery exists on disk.
      writeDoc('discovery', 'discovery_change-record-parts_v1');
      const index = readProposalSourceIndex(flowDir);

      expect(index.liveDocs.has('plan_change-record-parts_v1')).toBe(false);
      expect(isProposalSourceLive('plan_change-record-parts_v1', index)).toBe(true);
    });

    it('should treat an ARCHIVED doc as gone — archive is not a source dir', () => {
      mkdirSync(join(flowDir, 'archive'), { recursive: true });
      writeFileSync(join(flowDir, 'archive', 'plan_done_v1.md'), '# done\n', 'utf-8');

      expect(isProposalSourceLive('plan_done_v1', readProposalSourceIndex(flowDir))).toBe(false);
    });

    it('should stale every RENDERING state when the source is gone — including rejected', () => {
      const index = readProposalSourceIndex(flowDir);
      const proposals = LIVE_PROPOSAL_STATES.map((state) => proposalOf('plan_gone_v1', state));

      expect(proposalsWithMissingSource(proposals, index).map((entry) => entry.state)).toEqual([
        ...LIVE_PROPOSAL_STATES,
      ]);
    });

    it('should leave terminal states untouched, so a repeated expiry sweep is idempotent', () => {
      const index = readProposalSourceIndex(flowDir);
      const terminal: ProposalEventName[] = ['confirmed', 'stale', 'cleared'];

      expect(proposalsWithMissingSource(terminal.map((state) => proposalOf('plan_gone_v1', state)), index)).toEqual([]);
    });

    it('should report the count in the sweep vocabulary, zero included', () => {
      expect(formatProposalsStaled(0)).toBe('proposals: 0 staled (source gone)');
      expect(formatProposalsStaled(3)).toBe('proposals: 3 staled (source gone)');
    });

    // ── the leak itself ──────────────────────────────────────
    //
    // THE NAMED REGRESSION. Two explorations, identical in every respect a
    // clock can see: one abandoned months ago, one deliberate and still open.
    // Age-out expiry was rejected precisely because it cannot tell them apart —
    // so the test that guards this rule has to assert BOTH halves, or it would
    // pass for an implementation that simply stales everything.

    it('should stop an ABANDONED discovery from rendering forever — the leak, closed', () => {
      // The exploration happened; no plan came of it; the doc is gone.
      writeDoc('plans', 'plan_something-else_v1');
      const index = readProposalSourceIndex(flowDir);
      const abandoned = proposalOf('discovery_abandoned-idea_v1');

      const staled = proposalsWithMissingSource([abandoned], index);

      expect(staled).toHaveLength(1);
      expect(staled[0].plan).toBe('discovery_abandoned-idea_v1');
      // Stale, NEVER delete — the store keeps the proposal, the fold keeps its
      // payload, and only the state moves.
      expect(staled[0].label).toBe('x');
      expect(staled[0].predictedNodeId).toBe('module:src/x');
    });

    it('should NOT stale a live slow-moving discovery — the failure age-out expiry was rejected for', () => {
      // Opened long ago, still being thought about. Its doc is still there.
      writeDoc('discovery', 'discovery_slow-burn_v1');
      const index = readProposalSourceIndex(flowDir);
      const slow: EffectiveProposal = {
        ...proposalOf('discovery_slow-burn_v1'),
        proposedAt: '2025-01-01T00:00:00.000Z', // ancient by any clock
      };

      expect(proposalsWithMissingSource([slow], index)).toEqual([]);
      expect(isProposalSourceLive('discovery_slow-burn_v1', index)).toBe(true);
    });

    it('should separate the two in ONE pass — the abandoned one stales, the live one does not', () => {
      writeDoc('discovery', 'discovery_slow-burn_v1');
      writeDoc('plans', 'plan_active-work_v1');
      const index = readProposalSourceIndex(flowDir);

      const staled = proposalsWithMissingSource(
        [
          proposalOf('discovery_abandoned-idea_v1'),
          proposalOf('discovery_slow-burn_v1'),
          proposalOf('plan_active-work_v1'),
          proposalOf('discovery_active-work_v1'), // its plan exists — still live
        ],
        index,
      );

      expect(staled.map((entry) => entry.plan)).toEqual(['discovery_abandoned-idea_v1']);
    });

    // THE LEAK, END TO END, THROUGH THE REAL STORE. The selector tests above
    // prove which proposals are chosen; this one proves what choosing them
    // DOES — that the abandoned exploration stops rendering while the live one
    // keeps rendering, which is the whole claim. A selector that returned the
    // right list into a store that kept drawing the ghosts would pass every
    // test above this line.
    it('should stop an abandoned discovery from rendering while a live slow-moving one keeps rendering', () => {
      writeDoc('discovery', 'discovery_slow-burn_v1');
      const base = {
        ts: '2025-01-05T00:00:00.000Z',
        kind: 'module' as const,
        event: 'proposed' as const,
        provenance: 'cli:propose',
      };
      appendProposalEvent(flowDir, { ...base, plan: 'discovery_slow-burn_v1', predictedNodeId: 'module:src/slow', label: 'Slow burn' });
      appendProposalEvent(flowDir, { ...base, plan: 'discovery_abandoned-idea_v1', predictedNodeId: 'module:src/gone', label: 'Abandoned idea' });

      // Both render before the sweep — the leak, as it exists today.
      expect(countProposals(readEffectiveProposals(flowDir)).live).toBe(2);

      // The sweep, exactly as `blueprint sweep --expired` performs it.
      const index = readProposalSourceIndex(flowDir);
      const doomed = proposalsWithMissingSource(readEffectiveProposals(flowDir), index);
      for (const proposal of doomed) {
        appendProposalEvent(flowDir, {
          ts: '2026-08-10T00:00:00.000Z',
          plan: proposal.plan,
          predictedNodeId: proposal.predictedNodeId,
          kind: proposal.kind,
          label: proposal.label,
          event: 'stale',
          provenance: 'cli:sweep',
        });
      }

      const after = readEffectiveProposals(flowDir);
      const byPlan = new Map(after.map((proposal) => [proposal.plan, proposal]));

      // The abandoned one no longer renders…
      expect(byPlan.get('discovery_abandoned-idea_v1')?.state).toBe('stale');
      // …the live slow-moving one still does…
      expect(byPlan.get('discovery_slow-burn_v1')?.state).toBe('proposed');
      expect(countProposals(after).live).toBe(1);
      // …and NOTHING was deleted: both proposals, and their payloads, survive.
      expect(after).toHaveLength(2);
      expect(byPlan.get('discovery_abandoned-idea_v1')?.label).toBe('Abandoned idea');
      expect(parseProposalsFile(storePath()).events).toHaveLength(3);
    });
  });

  describe('refusal reporting (validateProposalRecord / validateProposalDecision)', () => {
    const VALID_RECORD = {
      plan: 'plan_pay',
      node: 'integration:stripe',
      kind: 'integration',
      label: 'Stripe SDK',
    };

    /** Every record-mode rejection, with the input token its reason must name. */
    const RECORD_REFUSALS: Array<[string, Partial<typeof VALID_RECORD>, string]> = [
      ['a missing plan', { plan: '' }, '--plan'],
      ['a missing node', { node: '' }, '--node'],
      ['an absent kind', { kind: undefined }, '--kind'],
      // `part` was the placeholder unknown kind here until it became a real
      // one; `feature` takes its place — a plausible guess that is still not a
      // proposal kind (a feature is proposed by naming one of its parts).
      ['an unknown kind', { kind: 'feature' }, '--kind'],
      ['a missing label', { label: '' }, '--label'],
      ['an id that breaks its kind grammar', { node: 'integration:has space' }, 'grammar'],
      ['an id whose prefix disagrees with its kind', { node: 'module:src/pay' }, 'grammar'],
    ];

    it.each(RECORD_REFUSALS)(
      'should refuse %s with a non-empty reason a caller can surface',
      (_case, overrides, expectedToken) => {
        const reason = validateProposalRecord({ ...VALID_RECORD, ...overrides });

        // The whole point: a rejection is NEVER expressible as "nothing happened"
        expect(reason).not.toBeNull();
        expect(typeof reason).toBe('string');
        expect((reason as string).length).toBeGreaterThan(0);
        expect(reason as string).toContain(expectedToken);
        // …and it round-trips into the exact line the CLI puts on stderr
        expect(formatProposeRefusal(reason as string)).toBe(`propose refused: ${reason}`);
        expect(formatProposeRefusal(reason as string).startsWith('propose refused: ')).toBe(true);
      },
    );

    it('should return null — and only null — for a valid record', () => {
      expect(validateProposalRecord(VALID_RECORD)).toBeNull();
      for (const kind of PROPOSAL_KINDS) {
        const node = { integration: 'integration:stripe', endpoint: 'endpoint:GET /a', datastore: 'datastore:cache', module: 'module:src/pay', part: 'feature:pay/checkout-form' }[kind];
        expect(validateProposalRecord({ ...VALID_RECORD, kind, node })).toBeNull();
      }
    });

    /** Build an effective proposal parked in one lifecycle state. */
    function proposalInState(state: ProposalEventName): EffectiveProposal {
      return {
        fingerprint: 'plan_pay+integration:stripe',
        plan: 'plan_pay',
        predictedNodeId: 'integration:stripe',
        kind: 'integration',
        label: 'Stripe SDK',
        anchors: [],
        state,
        provenance: 'cli:propose',
        proposedAt: '2026-07-10T00:00:00.000Z',
      };
    }

    it('should refuse a decision on a never-proposed fingerprint with a reason naming both halves', () => {
      const reason = validateProposalDecision(undefined, 'plan_pay', 'integration:stripe');

      expect(reason).not.toBeNull();
      expect(reason as string).toContain('integration:stripe');
      expect(reason as string).toContain('plan_pay');
    });

    it.each<[ProposalEventName]>([['confirmed'], ['cleared'], ['accepted'], ['rejected'], ['stale']])(
      'should refuse a decision from %s with a reason naming the blocking state',
      (state) => {
        const reason = validateProposalDecision(proposalInState(state), 'plan_pay', 'integration:stripe');

        expect(reason).not.toBeNull();
        expect((reason as string).length).toBeGreaterThan(0);
        expect(reason as string).toContain(state);
        expect(formatProposeRefusal(reason as string)).toBe(`propose refused: ${reason}`);
      },
    );

    it('should allow a decision from proposed — the one state that yields no reason', () => {
      expect(validateProposalDecision(proposalInState('proposed'), 'plan_pay', 'integration:stripe')).toBeNull();
    });

    it('should leave no lifecycle state unaccounted for — every non-proposed state refuses', () => {
      const refusing = PROPOSAL_EVENT_NAMES.filter(
        (state) => validateProposalDecision(proposalInState(state), 'plan_pay', 'integration:stripe') !== null,
      );

      expect(refusing).toEqual(PROPOSAL_EVENT_NAMES.filter((state) => state !== 'proposed'));
    });
  });
});

describe('part ids a Workspace discovery writes (2026-10-08)', () => {
  // The grammar already accepts every id partNodeId can mint, including a
  // sibling project's namespaced part. Pinned first, so a "helpful" loosening
  // or tightening shows up here.
  it.each([
    'feature:apps/scheduler',
    'feature:orbit-app::apps/scheduler',
    'feature:orbit-core::scheduler-service/cron-trigger',
  ])('accepts %s', (node) => {
    expect(validateProposalRecord({ plan: 'p', node, kind: 'part', label: 'Scheduler' })).toBeNull();
  });

  it('every kind example passes its own grammar', () => {
    for (const kind of PROPOSAL_KINDS) {
      expect(isValidPredictedNodeId(kind, PREDICTED_ID_EXAMPLE[kind])).toBe(true);
    }
  });

  it.each([
    ['part:apps/scheduler', 'feature:apps/scheduler'],
    ['feature:orbit-app/apps/scheduler', 'feature:orbit-app::apps/scheduler'],
    ['feature:orbit-app:apps/scheduler', 'feature:orbit-app::apps/scheduler'],
    ['part:orbit-app::apps/scheduler', 'feature:orbit-app::apps/scheduler'],
    ['feature:Orbit_App::Apps/Scheduler Service', 'feature:orbit-app::apps/scheduler-service'],
  ])('refuses %s and names %s, without writing it for the caller', (node, suggestion) => {
    expect(isValidPredictedNodeId('part', node)).toBe(false);
    const refusal = validateProposalRecord({ plan: 'p', node, kind: 'part', label: 'Scheduler' }) as string;
    expect(refusal).toContain('expected feature:<slug>/<part-slug> or feature:<project>::<slug>/<part-slug>');
    expect(refusal).toContain('(e.g. feature:orbit-app::apps/scheduler)');
    expect(refusal).toContain(`did you mean '${suggestion}'?`);
    expect(PART_ID_PATTERN.test(suggestion)).toBe(true);
  });

  it('suggests nothing when the intent cannot be read', () => {
    for (const node of ['part:scheduler', 'feature:a/b/c/d', 'feature:apps/', 'module:src/x', 'feature:--/--']) {
      expect(suggestPartId(node)).toBeNull();
    }
    const refusal = validateProposalRecord({ plan: 'p', node: 'part:scheduler', kind: 'part', label: 'S' }) as string;
    expect(refusal).not.toContain('did you mean');
  });

  it('never suggests for the extractor kinds', () => {
    const refusal = validateProposalRecord({ plan: 'p', node: 'endpoint:get /x', kind: 'endpoint', label: 'E' }) as string;
    expect(refusal).toContain('(e.g. endpoint:POST /api/apps/rebuild)');
    expect(refusal).not.toContain('did you mean');
  });
});
