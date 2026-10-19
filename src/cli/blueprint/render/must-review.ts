/**
 * Must-review computation — the ranked "needs your eyes" list.
 *
 * Derives review-worthy items from ONLY existing structured data (graph
 * deltas vs the previous derive and rounds records) — no LLM narration.
 * God-node/degree signals were removed (superseded by the Drift feature,
 * which uses node degree as a ranker, not a review row). Output is
 * deterministic: the same graph,
 * previous graph, and rounds records always produce the same ranked list.
 *
 * Rounds filtering contract: `computeMustReview` expects `input.rounds` to be
 * PRE-FILTERED by the caller to the current run (the caller filters by
 * `run_id`; a null/unknown run id means an empty array — no rounds signals).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BlueprintGraph, BlueprintNode, MustReviewItem, MustReviewSeverity } from '../types.js';

/** Rounds file name inside the flow directory. */
const ROUNDS_FILENAME = '.rounds.jsonl';

/**
 * Minimal shape of one `.rounds.jsonl` envelope — only the fields
 * must-review reads. Unknown envelope types pass through untouched.
 */
export interface RoundsRecord {
  ts?: string;
  run_id?: string | null;
  type?: string;
  phase?: number | null;
  /** `verification` entries. */
  status?: string;
  task?: number;
  /** `risk` entries. */
  risk_level?: string;
  risk_rationale?: string;
  /** `escalation` entries. */
  what?: string;
  choice?: string;
  /** `review_verdict` entries. */
  finding_fingerprint?: string;
  classification?: string;
  [key: string]: unknown;
}

/** Ranking order per severity — lower sorts first. */
const SEVERITY_ORDER: Record<MustReviewSeverity, number> = {
  crit: 0,
  high: 1,
  ask: 2,
  info: 3,
};

/** An unranked must-review item, before rank assignment. */
type UnrankedItem = Omit<MustReviewItem, 'rank'>;

/**
 * Parse one rounds JSONL file into records, skipping malformed lines.
 * Missing or unreadable files return an empty array — never throw.
 */
export function parseRoundsFile(filePath: string): RoundsRecord[] {
  if (!existsSync(filePath)) {
    return [];
  }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    // Unreadable rounds file — must-review degrades to graph-only signals
    return [];
  }

  const records: RoundsRecord[] = [];
  for (const line of content.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        records.push(parsed as RoundsRecord);
      }
    } catch {
      // Malformed line — skip it rather than failing the whole read
    }
  }
  return records;
}

/**
 * Read the current rounds records from `<flowDir>/.rounds.jsonl`.
 * Tolerates an absent file and malformed lines (both yield fewer records,
 * never an error).
 */
export function readRoundsRecords(flowDir: string): RoundsRecord[] {
  return parseRoundsFile(join(flowDir, ROUNDS_FILENAME));
}

/** Index nodes of a graph by id. Null graph yields an empty index. */
function nodesById(graph: BlueprintGraph | null): Map<string, BlueprintNode> {
  if (graph === null) {
    return new Map();
  }
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

/** String table list from a node's meta, or empty. */
function tablesOf(node: BlueprintNode | undefined): string[] {
  const tables = node?.meta?.tables;
  if (!Array.isArray(tables)) {
    return [];
  }
  return tables.filter((table): table is string => typeof table === 'string');
}

/**
 * Graph-delta signals: new integrations (crit) and new/changed datastores
 * (high). A null previous graph means a first derive — there is no baseline
 * to diff against, so delta signals are skipped entirely (flooding the list
 * with every existing node would rank nothing).
 */
function graphDeltaItems(graph: BlueprintGraph, prevGraph: BlueprintGraph | null): UnrankedItem[] {
  if (prevGraph === null) {
    return [];
  }

  const prevNodes = nodesById(prevGraph);
  const items: UnrankedItem[] = [];

  for (const node of graph.nodes) {
    const prevNode = prevNodes.get(node.id);

    if (node.kind === 'integration' && prevNode === undefined) {
      items.push({
        severity: 'crit',
        title: `New external integration: ${node.label}`,
        detail: `Integration node ${node.id} (${node.sourceFile}) is absent from the previous derive.`,
        nodeId: node.id,
        source: 'graph-delta',
      });
      continue;
    }

    if (node.kind === 'datastore') {
      if (prevNode === undefined) {
        items.push({
          severity: 'high',
          title: `New data store: ${node.label}`,
          detail: `Datastore node ${node.id} (${node.sourceFile}) is absent from the previous derive.`,
          nodeId: node.id,
          source: 'graph-delta',
        });
        continue;
      }
      const prevTables = new Set(tablesOf(prevNode));
      const gainedTables = tablesOf(node).filter((table) => !prevTables.has(table));
      if (gainedTables.length > 0) {
        items.push({
          severity: 'high',
          title: `Data store gained tables: ${node.label}`,
          detail: `Datastore ${node.id} gained table(s): ${gainedTables.join(', ')}.`,
          nodeId: node.id,
          source: 'graph-delta',
        });
      }
    }
  }

  return items;
}

/**
 * Rounds signals from the current run's records (pre-filtered by the caller):
 * high/medium risk, escalations (relayed verbatim), kept review findings,
 * and verifications stuck at failed-needs-decision.
 */
function roundsItems(rounds: RoundsRecord[]): UnrankedItem[] {
  const items: UnrankedItem[] = [];

  for (const record of rounds) {
    switch (record.type) {
      case 'risk': {
        if (record.risk_level !== 'high' && record.risk_level !== 'medium') {
          break;
        }
        items.push({
          severity: record.risk_level === 'high' ? 'crit' : 'high',
          title: `Run risk assessed ${record.risk_level}`,
          detail: typeof record.risk_rationale === 'string' ? record.risk_rationale : '(no rationale recorded)',
          source: 'rounds',
        });
        break;
      }

      case 'escalation': {
        const what = typeof record.what === 'string' ? record.what : '(unrecorded escalation)';
        const choice = typeof record.choice === 'string' ? record.choice : '(no choice recorded)';
        items.push({
          severity: 'ask',
          title: `Escalation: ${what}`,
          detail: `${what} — choice: ${choice}`,
          source: 'rounds',
        });
        break;
      }

      case 'review_verdict': {
        if (record.classification !== 'kept') {
          break;
        }
        const fingerprint =
          typeof record.finding_fingerprint === 'string' ? record.finding_fingerprint : '(unknown finding)';
        items.push({
          severity: 'ask',
          title: `Kept review finding: ${fingerprint}`,
          detail: `Review finding ${fingerprint} was kept and awaits your judgment.`,
          source: 'rounds',
        });
        break;
      }

      case 'verification': {
        if (record.status !== 'failed-needs-decision') {
          break;
        }
        const phase = record.phase ?? '?';
        const task = record.task ?? '?';
        items.push({
          severity: 'ask',
          title: `Verification needs decision: phase ${phase} task ${task}`,
          detail: `Verification for phase ${phase} task ${task} failed and a withheld repair awaits your decision.`,
          source: 'rounds',
        });
        break;
      }

      default:
        break;
    }
  }

  return items;
}

/** Codepoint string comparison — locale-independent, deterministic. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Compute the ranked must-review list from graph deltas, graphify god-node
 * metrics, and (pre-filtered) rounds records. Items are sorted by severity
 * (crit > high > ask > info) with a stable title tie-break, then assigned
 * ranks 1..N. Pure and deterministic.
 */
export function computeMustReview(input: {
  graph: BlueprintGraph;
  prevGraph: BlueprintGraph | null;
  rounds: RoundsRecord[];
}): MustReviewItem[] {
  const unranked: UnrankedItem[] = [
    ...graphDeltaItems(input.graph, input.prevGraph),
    ...roundsItems(input.rounds),
  ];

  unranked.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) {
      return bySeverity;
    }
    return compareStrings(a.title, b.title);
  });

  return unranked.map((item, index) => ({ ...item, rank: index + 1 }));
}
