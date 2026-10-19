/**
 * Forgetting what the learner knows.
 *
 * The board's Reset cleared ONE file — `learning-state.jsonl`, the status table
 * saying which modules had been read. Everything the learning actually
 * PRODUCED stayed: on a live project, 400 module docs (2.4 MB), 506
 * investigation notes with 2,131 heat ticks (959 KB), 19 generated feature
 * views, and the `## Learned` / `## Parts` sections inside 57 feature files.
 * So the map came back looking exactly as informed as before, which is what
 * "I reset the learn, why do we still have data?" was about.
 *
 * This is the one place that knows the whole set. It is deliberately not the
 * whole brain: a person's own notes (`decisions/`, `errors/`), a feature's
 * name, kind and prose, and every derived structure file (the graph,
 * annotations, proposals, symbols) are NOT things the learner knows — they
 * come from the repo, from plans, or from a human, and forgetting them would
 * be a different verb with a different name.
 *
 * Destructive and irreversible, so it counts before it acts: `--dry-run`
 * reports exactly what would go, and the real run reports exactly what went.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  featuresDir,
  parseFeatureFile,
  persistFeatureNode,
  splitParts,
} from './feature-store.js';

/** Where the learner's per-module understanding docs live. */
const MODULES_DIRNAME = join('brain', 'modules');
/** The derived structure dir, relative to `flow/`. */
const STRUCTURE_DIRNAME = join('brain', '.structure');
/** Generated curated views — regenerated from a learn, never hand-written. */
const FEATURE_VIEWS_DIRNAME = join(STRUCTURE_DIRNAME, 'feature-views');

/** What a forget did, or would do. Every number is a count of real things. */
export interface ForgetTally {
  /** `flow/brain/modules/*.md` — the per-module understanding docs. */
  moduleDocs: number;
  /** Investigation notes (the learner's recorded findings). */
  notes: number;
  /** Heat ticks (how often a module was visited). */
  heat: number;
  /** Rows in the learning status table. */
  learningRows: number;
  /** Generated curated feature views. */
  featureViews: number;
  /** Feature files whose `## Learned` / `## Parts` sections were removed. */
  featuresStripped: number;
  /**
   * Feature files left alone because their machine sections could not be
   * separated from hand-written content. Never guessed at — a half-understood
   * file is left whole and named, so a person can decide.
   */
  featuresSkipped: string[];
}

/** Count the lines of a JSONL store by kind, tolerating a missing file. */
function tallyJsonl(path: string): { notes: number; heat: number } {
  if (!existsSync(path)) return { notes: 0, heat: 0 };
  let notes = 0;
  let heat = 0;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const entry = JSON.parse(trimmed) as { kind?: string };
      if (entry.kind === 'heat') heat += 1;
      else notes += 1;
    } catch {
      // A line that does not parse is still a line the store holds.
      notes += 1;
    }
  }
  return { notes, heat };
}

/** Files directly under `dir` matching `suffix`, or [] when there is no dir. */
function filesIn(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((name) => name.endsWith(suffix));
  } catch {
    return [];
  }
}

/**
 * Empty a JSONL store by writing nothing to it — the same temp+rename the
 * stores' own writers use, so a reader never sees a half-truncated file.
 */
function emptyFile(path: string): void {
  if (!existsSync(path)) return;
  const temp = `${path}.forget.tmp`;
  writeFileSync(temp, '', 'utf-8');
  renameSync(temp, path);
}

/**
 * Strip a feature's machine-owned regions, keeping every human byte.
 *
 * `## Learned` and `## Parts` are written by the learner; the frontmatter, the
 * prose above them and the feature's identity are not. Returns false when the
 * boundary is ambiguous — the file is then left exactly as it was, because a
 * partial rewrite of somebody's own writing is the one outcome worth refusing.
 */
function stripFeature(flowDir: string, dir: string, name: string): boolean {
  const path = join(dir, name);
  const slug = name.replace(/\.md$/, '');
  let node;
  try {
    node = parseFeatureFile(slug, readFileSync(path, 'utf-8'));
  } catch {
    return false;
  }
  let split;
  try {
    split = splitParts(node.body); // throws when the boundary is ambiguous
  } catch {
    return false;
  }
  if (split.learned === null && split.parts === null) return false; // nothing learned here
  const body = `${split.human.replace(/\s*$/, '')}\n`;
  // Through the store's one writer, so a Workspace project's note stays free
  // of per-machine counters (forgetting resets this machine's counters too).
  persistFeatureNode(flowDir, { ...node, body });
  return true;
}

/**
 * Forget everything the learner knows about this project.
 *
 * `dryRun` counts without touching anything, which is what the board shows
 * before asking. Missing files and directories are not an error: a project that
 * never learned anything forgets nothing, and says so with zeroes.
 */
export function forgetLearning(
  flowDir: string,
  options: { dryRun?: boolean } = {},
): ForgetTally {
  const dryRun = options.dryRun === true;
  const structureDir = join(flowDir, STRUCTURE_DIRNAME);
  const modulesDir = join(flowDir, MODULES_DIRNAME);
  const viewsDir = join(flowDir, FEATURE_VIEWS_DIRNAME);
  const investigationsPath = join(structureDir, 'investigations.jsonl');
  const learningPath = join(structureDir, 'learning-state.jsonl');

  const moduleDocs = filesIn(modulesDir, '.md');
  const featureViews = filesIn(viewsDir, '.json');
  const { notes, heat } = tallyJsonl(investigationsPath);
  const learningRows = tallyJsonl(learningPath).notes;

  const dir = featuresDir(flowDir);
  const featureFiles = filesIn(dir, '.md');
  const tally: ForgetTally = {
    moduleDocs: moduleDocs.length,
    notes,
    heat,
    learningRows,
    featureViews: featureViews.length,
    featuresStripped: 0,
    featuresSkipped: [],
  };

  if (dryRun) {
    // Count what WOULD be stripped without writing: a feature carries learned
    // content when either machine region is present.
    for (const name of featureFiles) {
      try {
        const node = parseFeatureFile(name.replace(/\.md$/, ''), readFileSync(join(dir, name), 'utf-8'));
        const split = splitParts(node.body);
        if (split.learned !== null || split.parts !== null) tally.featuresStripped += 1;
      } catch {
        tally.featuresSkipped.push(name);
      }
    }
    return tally;
  }

  for (const name of moduleDocs) rmSync(join(modulesDir, name), { force: true });
  for (const name of featureViews) rmSync(join(viewsDir, name), { force: true });
  emptyFile(investigationsPath);
  // The status table is REWRITTEN empty rather than deleted: the app reads it
  // on every board refresh, and an absent file and an empty one mean the same
  // thing to it — but only one of them is a file the next write can rename over.
  if (existsSync(structureDir)) {
    mkdirSync(structureDir, { recursive: true });
    emptyFile(learningPath);
    if (!existsSync(learningPath)) writeFileSync(learningPath, '', 'utf-8');
  }
  for (const name of featureFiles) {
    try {
      if (stripFeature(flowDir, dir, name)) tally.featuresStripped += 1;
    } catch {
      tally.featuresSkipped.push(name);
    }
  }
  return tally;
}

/** One line a person can read, for either mode. */
export function describeForget(tally: ForgetTally, dryRun: boolean): string {
  const verb = dryRun ? 'would forget' : 'forgot';
  const parts = [
    `${String(tally.moduleDocs)} module doc${tally.moduleDocs === 1 ? '' : 's'}`,
    `${String(tally.notes)} note${tally.notes === 1 ? '' : 's'}`,
    `${String(tally.heat)} heat tick${tally.heat === 1 ? '' : 's'}`,
    `${String(tally.learningRows)} status row${tally.learningRows === 1 ? '' : 's'}`,
    `${String(tally.featureViews)} feature view${tally.featureViews === 1 ? '' : 's'}`,
    `${String(tally.featuresStripped)} feature${tally.featuresStripped === 1 ? "'s" : "s'"} learnings`,
  ];
  const skipped =
    tally.featuresSkipped.length === 0
      ? ''
      : `\nforget: left ${String(tally.featuresSkipped.length)} feature file(s) alone — hand-written content inside a machine section: ${tally.featuresSkipped.join(', ')}`;
  return `forget: ${verb} ${parts.join(', ')}${skipped}`;
}
