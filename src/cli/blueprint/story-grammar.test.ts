/**
 * Tests for the `## Story` grammar parser — happy path across every field,
 * missing-section and empty-doc behavior, malformed blocks and items
 * (warned + skipped, never silent), step-id slugging and collision suffixes,
 * inline vs indented chip lists, anchor kind mapping (node-id prefixes and
 * explicit envelopes), flow/phase validation, and determinism (same input →
 * deep-equal output). The fixtures double as grammar examples.
 */

import { parseFlowItem, parseStorySection } from './story-grammar.js';
import type { StoryStep } from './types.js';

const SOURCE_PATH = 'flow/plans/plan_pay_v1.md';

/** Canonical full-featured fixture: one doc, two steps, every field shape. */
const FULL_DOC = `# Plan: pay

## Overview

Not part of the story.

## Story

Intro prose before the first step is section preamble (ignored).

### Step: The problem we are solving
- kicker: Why this exists
- anchors: module:src/cli/blueprint, datastore:story
- phases: 1, 2
- source: flow/discovery/discovery_pay_v1.md

Payments fail silently today.

This is the second body paragraph.

### Step: How data flows
- kicker: Follow a charge
- anchors: endpoint:POST /charges, integration:stripe, symbol:parseStorySection, file:src/cli/blueprint/story-grammar.ts, table:charges
- flow: endpoint:POST /charges, module:src/cli/blueprint, datastore:story
- decisions: single writer, atomic rename
- rejected:
  - JSONL fold semantics — markdown is the source of truth
  - a second IPC channel
- questions: is draft mode enough?

Charge requests land on the endpoint and settle in the store.

## Not Story

### Step: Outside the section — never parsed
`;

describe('parseStorySection', () => {
  it('reads numbered step headings as steps, and step-by-step prose as nothing (2026-10-08)', () => {
    const doc = [
      '## Story',
      '',
      '### Step 1: Refresh works but nothing is live',
      '- kicker: The problem',
      '',
      '### Step 2 — The contract is never enforced',
      '',
      '### Step 3. Repair the frozen ones',
      '',
      '### Step 4 - What does not change',
      '',
      '### Step: Plain form still works',
      '',
      '### Step-by-step notes',
      'not a step',
    ].join('\n');
    const titles = parseStorySection(doc, SOURCE_PATH).steps.map((step) => step.title);
    expect(titles).toEqual([
      'Refresh works but nothing is live',
      'The contract is never enforced',
      'Repair the frozen ones',
      'What does not change',
      'Plain form still works',
    ]);
  });

  // ── Missing / empty sections ─────────────────────────────

  it('returns empty steps and no warnings for a doc without a ## Story section', () => {
    const result = parseStorySection('# Plan\n\n## Overview\n\nNothing here.\n', SOURCE_PATH);
    expect(result).toEqual({ steps: [], warnings: [] });
  });

  it('returns empty steps and no warnings for an empty document', () => {
    expect(parseStorySection('', SOURCE_PATH)).toEqual({ steps: [], warnings: [] });
  });

  it('parses an empty ## Story section (no steps) without warnings', () => {
    const result = parseStorySection('## Story\n\nJust prose, no steps.\n', SOURCE_PATH);
    expect(result).toEqual({ steps: [], warnings: [] });
  });

  it('does not match deeper or prefixed headings as the section marker', () => {
    const result = parseStorySection('### Story\n\n### Step: nope\n', SOURCE_PATH);
    expect(result).toEqual({ steps: [], warnings: [] });
  });

  // ── Happy path ───────────────────────────────────────────

  it('parses the full fixture into two steps with no warnings', () => {
    const { steps, warnings } = parseStorySection(FULL_DOC, SOURCE_PATH);
    expect(warnings).toEqual([]);
    expect(steps.map((step) => step.id)).toEqual(['the-problem-we-are-solving', 'how-data-flows']);
  });

  it('parses scalar fields, phases, and body paragraphs verbatim', () => {
    const { steps } = parseStorySection(FULL_DOC, SOURCE_PATH);
    const first = steps[0];
    expect(first.title).toBe('The problem we are solving');
    expect(first.kicker).toBe('Why this exists');
    expect(first.source).toBe('flow/discovery/discovery_pay_v1.md');
    expect(first.phases).toEqual([1, 2]);
    expect(first.body).toBe('Payments fail silently today.\n\nThis is the second body paragraph.');
  });

  it('leaves optional fields absent/empty when omitted', () => {
    const { steps } = parseStorySection('## Story\n\n### Step: Bare minimum\n', SOURCE_PATH);
    const step = steps[0];
    expect(step.kicker).toBeUndefined();
    expect(step.source).toBeUndefined();
    expect(step.anchors).toEqual([]);
    expect(step.flow).toEqual([]);
    expect(step.phases).toEqual([]);
    expect(step.decisions).toEqual([]);
    expect(step.rejected).toEqual([]);
    expect(step.questions).toEqual([]);
    expect(step.body).toBe('');
  });

  it('sets the compile-phase fields to their parser defaults', () => {
    const { steps } = parseStorySection(FULL_DOC, SOURCE_PATH);
    for (const step of steps) {
      expect(step.unresolvedAnchors).toEqual([]);
      expect(step.draft).toBe(false);
    }
  });

  it('ignores step headings outside the ## Story section', () => {
    const { steps } = parseStorySection(FULL_DOC, SOURCE_PATH);
    expect(steps.some((step) => step.title.startsWith('Outside the section'))).toBe(false);
  });

  // ── Anchor kind mapping ──────────────────────────────────

  it('maps node-id prefixes and explicit envelopes to anchor kinds', () => {
    const { steps } = parseStorySection(FULL_DOC, SOURCE_PATH);
    expect(steps[0].anchors).toEqual([
      { kind: 'module', ref: 'src/cli/blueprint' },
      { kind: 'table', ref: 'story' },
    ]);
    expect(steps[1].anchors).toEqual([
      { kind: 'endpoint', ref: 'POST /charges' },
      { kind: 'symbol', ref: 'stripe' },
      { kind: 'symbol', ref: 'parseStorySection' },
      { kind: 'file', ref: 'src/cli/blueprint/story-grammar.ts' },
      { kind: 'table', ref: 'charges' },
    ]);
  });

  it('accepts predicted-id variants (webhook mounts, CLI endpoints)', () => {
    const doc = '## Story\n\n### Step: Ghosts\n- anchors: integration:webhook:/hooks/stripe, endpoint:cli narrate\n';
    const { steps, warnings } = parseStorySection(doc, SOURCE_PATH);
    expect(warnings).toEqual([]);
    expect(steps[0].anchors).toEqual([
      { kind: 'symbol', ref: 'webhook:/hooks/stripe' },
      { kind: 'endpoint', ref: 'cli narrate' },
    ]);
  });

  it('warns on malformed anchor items and keeps valid siblings', () => {
    const doc =
      '## Story\n\n### Step: Mixed anchors\n- anchors: module:src/cli, bogus, widget:thing, endpoint:get /lowercase, symbol:\n';
    const { steps, warnings } = parseStorySection(doc, SOURCE_PATH);
    expect(steps[0].anchors).toEqual([{ kind: 'module', ref: 'src/cli' }]);
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain('invalid anchor "bogus"');
    expect(warnings[1]).toContain('invalid anchor "widget:thing"');
    expect(warnings[2]).toContain('invalid anchor "endpoint:get /lowercase"');
    expect(warnings[3]).toContain('invalid anchor "symbol:"');
    for (const warning of warnings) {
      expect(warning).toContain(SOURCE_PATH);
      expect(warning).toContain('step "Mixed anchors"');
    }
  });

  // ── Flow and phases validation ───────────────────────────

  it('keeps flow order and drops invalid flow ids with warnings', () => {
    const doc =
      '## Story\n\n### Step: Flow\n- flow: datastore:story, endpoint:GET /x, not-a-node, symbol:onlyAnchorsAllowHere\n';
    const { steps, warnings } = parseStorySection(doc, SOURCE_PATH);
    expect(steps[0].flow).toEqual(['datastore:story', 'endpoint:GET /x']);
    expect(warnings).toEqual([
      `${SOURCE_PATH}: step "Flow" — invalid flow node id "not-a-node"`,
      `${SOURCE_PATH}: step "Flow" — invalid flow node id "symbol:onlyAnchorsAllowHere"`,
    ]);
  });

  it('warns on non-integer phases and keeps integer siblings', () => {
    const doc = '## Story\n\n### Step: Phases\n- phases: 1, two, 3.5, 4\n';
    const { steps, warnings } = parseStorySection(doc, SOURCE_PATH);
    expect(steps[0].phases).toEqual([1, 4]);
    expect(warnings).toEqual([
      `${SOURCE_PATH}: step "Phases" — invalid phase "two" (expected an integer)`,
      `${SOURCE_PATH}: step "Phases" — invalid phase "3.5" (expected an integer)`,
    ]);
  });

  // ── Chip lists: inline vs indented ───────────────────────

  it('parses inline comma lists and indented items to the same shape', () => {
    const inline = '## Story\n\n### Step: Chips\n- decisions: alpha, beta\n';
    const indented = '## Story\n\n### Step: Chips\n- decisions:\n  - alpha\n  - beta\n';
    const inlineResult = parseStorySection(inline, SOURCE_PATH);
    const indentedResult = parseStorySection(indented, SOURCE_PATH);
    expect(inlineResult.steps[0].decisions).toEqual(['alpha', 'beta']);
    expect(indentedResult.steps[0].decisions).toEqual(['alpha', 'beta']);
  });

  it('merges inline items with immediately-following indented items', () => {
    const doc = '## Story\n\n### Step: Chips\n- questions: first?\n  - second?\n';
    const { steps } = parseStorySection(doc, SOURCE_PATH);
    expect(steps[0].questions).toEqual(['first?', 'second?']);
  });

  it('stops consuming indented items at the first non-indented line', () => {
    const doc = '## Story\n\n### Step: Chips\n- rejected:\n  - dropped idea\nBody resumes here.\n  - this dash is body, not a chip\n';
    const { steps } = parseStorySection(doc, SOURCE_PATH);
    expect(steps[0].rejected).toEqual(['dropped idea']);
    expect(steps[0].body).toBe('Body resumes here.\n  - this dash is body, not a chip');
  });

  it('treats unrecognized `- key:` lines as body, not grammar', () => {
    const doc = '## Story\n\n### Step: Body list\n- verdict: keep this in the body\n- kicker: real kicker\n';
    const { steps, warnings } = parseStorySection(doc, SOURCE_PATH);
    expect(warnings).toEqual([]);
    expect(steps[0].kicker).toBe('real kicker');
    expect(steps[0].body).toBe('- verdict: keep this in the body');
  });

  // ── Malformed step blocks ────────────────────────────────

  it('skips step blocks with empty titles AND counts them in warnings', () => {
    const doc = '## Story\n\n### Step:\nOrphan body.\n\n### Step: Valid one\n';
    const { steps, warnings } = parseStorySection(doc, SOURCE_PATH);
    expect(steps.map((step) => step.title)).toEqual(['Valid one']);
    expect(warnings).toEqual([`${SOURCE_PATH}: step block with empty title skipped`]);
  });

  it('warns when multiple ## Story sections exist and parses only the first', () => {
    const doc = '## Story\n\n### Step: First section\n\n## Middle\n\n## Story\n\n### Step: Second section\n';
    const { steps, warnings } = parseStorySection(doc, SOURCE_PATH);
    expect(steps.map((step) => step.title)).toEqual(['First section']);
    expect(warnings).toEqual([`${SOURCE_PATH}: multiple "## Story" sections — only the first was parsed`]);
  });

  // ── Step-id derivation ───────────────────────────────────

  it('derives kebab-slug ids and applies -2/-3 collision suffixes', () => {
    const doc =
      '## Story\n\n### Step: Data Flow!\n\n### Step: Data flow\n\n### Step: data  flow\n\n### Step: Other\n';
    const { steps } = parseStorySection(doc, SOURCE_PATH);
    expect(steps.map((step) => step.id)).toEqual(['data-flow', 'data-flow-2', 'data-flow-3', 'other']);
  });

  it('skips collision suffixes already occupied by naturally-suffixed titles', () => {
    const doc = '## Story\n\n### Step: build\n\n### Step: build 2\n\n### Step: build\n';
    const { steps } = parseStorySection(doc, SOURCE_PATH);
    expect(steps.map((step) => step.id)).toEqual(['build', 'build-2', 'build-3']);
  });

  it('falls back to a stable id when the title has no sluggable characters', () => {
    const doc = '## Story\n\n### Step: ???\n\n### Step: !!!\n';
    const { steps } = parseStorySection(doc, SOURCE_PATH);
    expect(steps.map((step) => step.id)).toEqual(['step', 'step-2']);
  });

  // ── Body preservation & line endings ─────────────────────

  it('keeps subheadings and markdown structure inside the body', () => {
    const doc = '## Story\n\n### Step: Rich body\n\n#### Detail heading\n\n> a quote\n\n* a bullet\n';
    const { steps } = parseStorySection(doc, SOURCE_PATH);
    expect(steps[0].body).toBe('#### Detail heading\n\n> a quote\n\n* a bullet');
  });

  it('parses CRLF input identically to LF input', () => {
    const lf = parseStorySection(FULL_DOC, SOURCE_PATH);
    const crlf = parseStorySection(FULL_DOC.split('\n').join('\r\n'), SOURCE_PATH);
    expect(crlf).toEqual(lf);
  });

  // ── Determinism ──────────────────────────────────────────

  it('is deterministic: the same input yields deep-equal output', () => {
    const first = parseStorySection(FULL_DOC, SOURCE_PATH);
    const second = parseStorySection(FULL_DOC, SOURCE_PATH);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it('emits fully-populated StoryStep shapes (compile-time fields defaulted)', () => {
    const { steps } = parseStorySection(FULL_DOC, SOURCE_PATH);
    const expectedKeys: Array<keyof StoryStep> = [
      'id',
      'title',
      'body',
      'anchors',
      'flow',
      'phases',
      'decisions',
      'rejected',
      'questions',
      'unresolvedAnchors',
      'draft',
    ];
    for (const step of steps) {
      for (const key of expectedKeys) {
        expect(step).toHaveProperty(key);
      }
    }
  });
});

describe('bare-path anchor tolerance (2026-07-27)', () => {
  it('prefix-less path tokens parse as file anchors instead of dropping', () => {
    const doc = ['## Story', '', '### Step: X', '- anchors: src/commands/streamTurn.ts, orbit_core/web/api/v1/agents/views.py', 'body text', ''].join('\n');
    const parsed = parseStorySection(doc);
    expect(parsed.steps[0].anchors).toEqual([
      { kind: 'file', ref: 'src/commands/streamTurn.ts' },
      { kind: 'file', ref: 'orbit_core/web/api/v1/agents/views.py' },
    ]);
  });

  it('non-path garbage still drops', () => {
    const doc = ['## Story', '', '### Step: X', '- anchors: just some words, another thing', 'body', ''].join('\n');
    const parsed = parseStorySection(doc);
    expect(parsed.steps[0].anchors).toEqual([]);
  });
});

describe('HTML comments never leak into step bodies (2026-07-27)', () => {
  it('drops a trailing brain-capture block from the last step', () => {
    const doc = [
      '## Story',
      '',
      '### Step: Erase, comply, verify',
      'Real narrative line.',
      '',
      '<!-- brain-capture',
      'skill: create-plan',
      'data:',
      '  phase_count: 12',
      '-->',
      '',
    ].join('\n');
    const parsed = parseStorySection(doc);
    expect(parsed.steps[0].body).toBe('Real narrative line.');
    expect(parsed.steps[0].body).not.toContain('brain-capture');
  });

  it('single-line comments drop too', () => {
    const doc = ['## Story', '', '### Step: X', '<!-- note to self -->', 'Body.', ''].join('\n');
    expect(parseStorySection(doc).steps[0].body).toBe('Body.');
  });
});


describe('flow items: feature parts and hyphenated ids (2026-09-30)', () => {
  const story = (flow: string): string =>
    ['## Story', '', '### Step: Shape', `- flow_after: ${flow}`, ''].join('\n');

  it('accepts a feature part id in a flow', () => {
    const { steps, warnings } = parseStorySection(story('feature:demo/memory-store, integration:x'), SOURCE_PATH);
    expect(warnings).toEqual([]);
    expect(steps[0].flowAfter).toEqual(['feature:demo/memory-store', 'integration:x']);
  });

  it('keeps a hyphenated id whole when it carries a hop label', () => {
    // The lazy id used to stop at the FIRST hyphen: `feature:demo/memory` + "store -reads".
    const { steps } = parseStorySection(story('module:src/foo-bar -reads->, integration:x'), SOURCE_PATH);
    expect(parseFlowItem(steps[0].flowAfter[0])).toEqual({ id: 'module:src/foo-bar', label: 'reads' });
  });
});
