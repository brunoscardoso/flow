/**
 * SEARCH RANKS SOLID KNOWLEDGE ABOVE DRAFTS (discovery
 * `workspace_knowledge_draft_solid`, FR-9).
 *
 * A search hit is read as "how the code works", so a feature file's chunk
 * whose learnings were all learned on an unmerged branch is DEMOTED
 * (`DRAFT_CHUNK_WEIGHT`), and one whose learnings were all abandoned is
 * HIDDEN (weight 0 — the ranker drops a zero score). Everything else keeps
 * its score: human prose, plans, discoveries, and any chunk with at least one
 * solid learning.
 *
 * Resolved PER LEARNING LINE, through the readers' one door
 * (`knowledge-status-read.ts`): the feature file is read once per search, each
 * of its learnings — `## Learned` and every part's — resolved with its proper
 * scope, and a chunk's lines are looked up by `(text, learnedAt)`. The chunker
 * cuts a feature file at its headings, so a part's `### name` block is its own
 * chunk and gets its own answer.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  addressPartNames,
  parseLearnings,
  parseParts,
  partLearningScope,
  resolveLearnings,
  splitParts,
  type Learning,
  type ResolvedLearning,
} from '../blueprint/feature-store.js';
import { createKnowledgeStatusReader, type KnowledgeStatusReader } from './knowledge-status-read.js';

/** A draft chunk's score multiplier: still found, never above the solid answer. */
export const DRAFT_CHUNK_WEIGHT = 0.4;

const FEATURE_FILE_RE = /(?:^|\/)brain\/features\/([^/]+)\.md$/;

/** The chunk fields the weight reads. */
export interface WeightedChunk {
  file: string;
  text: string;
}

const keyOf = (entry: Pick<Learning, 'text' | 'learnedAt'>): string => `${entry.text}\u0000${entry.learnedAt ?? ''}`;

/** Every learning of one feature file, resolved with its scope, by `(text, learnedAt)`. */
function resolvedFeatureFile(flowDir: string, slug: string, reader: KnowledgeStatusReader): Map<string, ResolvedLearning> {
  const out = new Map<string, ResolvedLearning>();
  const path = join(flowDir, 'brain', 'features', `${slug}.md`);
  if (!existsSync(path)) return out;
  try {
    const split = splitParts(readFileSync(path, 'utf-8'));
    for (const entry of resolveLearnings(parseLearnings(split.learned), { kind: 'learning', scope: slug }, reader)) {
      out.set(keyOf(entry), entry);
    }
    const parts = parseParts(split.parts).filter((part) => part.name.trim().length > 0);
    const ids = addressPartNames(`feature:${slug}`, parts.map((part) => part.name));
    parts.forEach((part, index) => {
      const scope = partLearningScope(ids[index]);
      for (const entry of resolveLearnings(part.learnings, { kind: 'part-learning', scope }, reader)) {
        if (!out.has(keyOf(entry))) out.set(keyOf(entry), entry);
      }
    });
  } catch {
    // An unreadable or ambiguous file ranks as it always has.
  }
  return out;
}

/** The weight one chunk's learnings earn: 1 solid, `DRAFT_CHUNK_WEIGHT` draft, 0 abandoned. */
export function weightOfLearnings(statuses: ReadonlyArray<ResolvedLearning['status']>): number {
  if (statuses.length === 0) return 1;
  if (statuses.some((status) => status === 'solid')) return 1;
  if (statuses.some((status) => status === 'draft')) return DRAFT_CHUNK_WEIGHT;
  return 0;
}

/**
 * A chunk weigher over `flowDir`'s knowledge. The log, the records and each
 * feature file are read at most once per weigher — build one per search.
 * `reader` is injectable for tests.
 */
export function chunkKnowledgeWeigher(
  flowDir: string,
  reader?: KnowledgeStatusReader,
): (chunk: WeightedChunk) => number {
  let shared: KnowledgeStatusReader | undefined = reader;
  const files = new Map<string, Map<string, ResolvedLearning>>();
  return (chunk) => {
    const match = FEATURE_FILE_RE.exec(chunk.file);
    if (match === null) return 1;
    const lines = parseLearnings(chunk.text);
    if (lines.length === 0) return 1;
    shared ??= createKnowledgeStatusReader(flowDir);
    const slug = match[1];
    let resolved = files.get(slug);
    if (resolved === undefined) {
      resolved = resolvedFeatureFile(flowDir, slug, shared);
      files.set(slug, resolved);
    }
    // What the chunk SAYS is its current lines; a chunk of only superseded
    // lines is judged by those.
    const current = lines.filter((entry) => entry.supersededReason === undefined);
    const judged = current.length > 0 ? current : lines;
    const statuses = judged.map(
      (entry) =>
        resolved.get(keyOf(entry))?.status ??
        resolveLearnings([entry], { kind: 'learning', scope: slug }, shared)[0].status,
    );
    return weightOfLearnings(statuses);
  };
}
